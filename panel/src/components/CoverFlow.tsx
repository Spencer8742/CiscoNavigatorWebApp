import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX, VNode } from 'preact';
import { Artwork } from '~/components/Artwork.tsx';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { browse } from '~/net/socket.ts';
import { KIND_ICON, KIND_LABEL, isExpandable } from '~/lib/media.ts';
import { BROWSE_PAGE } from '@shared/protocol.ts';
import type { BrowseResult, MediaItem } from '@shared/protocol.ts';

/**
 * Cover Flow: whatever the browser is showing, as a row of covers you swipe.
 *
 * It takes the same result the list does — a shelf, a source, an artist's
 * albums, search results grouped by type — so every view gets it without
 * knowing it exists. Tapping the cover in the middle flips it over to show
 * what is on it; a side cover glides to the middle instead.
 *
 * ## What it costs
 *
 * Only the centre cover and `WINDOW` either side are in the DOM, so a page of
 * sixty is never sixty decoded images and sixty composited layers — it is
 * thirteen, and the set changes only when the centre does.
 *
 * Motion is written straight onto each cover's `style.transform` from the
 * pointer handler and from one rAF loop that STOPS when the row settles. A
 * drag re-renders only when the centre index changes, so a swipe across the
 * whole page is a dozen renders, not one per frame. Nothing here runs while
 * the row is at rest (docs/ROOMOS.md §2).
 */

/** Covers drawn either side of the centre. */
const WINDOW = 6;
/** Below this the finger is tapping, not swiping. Under Pressable's slop. */
const SLOP_PX = 8;
/** Only the last stretch of a swipe decides how far it flings. */
const VELOCITY_WINDOW_MS = 100;
/** How far a fling carries on, in ms of its release speed. */
const FLING_MS = 220;

interface Entry {
  item: MediaItem;
  /** The search group it came from — "Artists", "Albums". */
  group?: string;
}

interface Metrics {
  /** Side of the centre cover, px. */
  cover: number;
  /** The flipped card, px. */
  panelW: number;
  panelH: number;
  /** How far the track's centre sits above the stage's, px. */
  trackDy: number;
}

type Phase = 'opening' | 'open' | 'closing';

export function CoverFlow({
  result,
  onPick,
  onOpen,
  renderRow,
}: {
  result: BrowseResult;
  /** Play something — opens the play options. */
  onPick: (item: MediaItem) => void;
  /** Drill into something, replacing the row with its contents. */
  onOpen: (item: MediaItem) => void;
  /** One row of the flipped card's list, drawn the way the list view draws it. */
  renderRow: (item: MediaItem, onOpen: (item: MediaItem) => void) => VNode;
}) {
  const entries = useMemo<Entry[]>(() => {
    if (result.kind === 'list') return result.items.map((item) => ({ item }));
    if (result.kind === 'groups') {
      return result.groups.flatMap((g) => g.items.map((item) => ({ item, group: g.name })));
    }
    return [];
  }, [result]);
  const n = entries.length;

  const stage = useRef<HTMLDivElement | null>(null);
  const track = useRef<HTMLDivElement | null>(null);
  const pos = useRef(0);
  const centerRef = useRef(0);
  const [center, setCenter] = useState(0);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const metricsRef = useRef<Metrics | null>(null);
  metricsRef.current = metrics;
  const [flipped, setFlipped] = useState<{ item: MediaItem; phase: Phase } | null>(null);
  const frame = useRef(0);
  /** Where a glide in progress will land, so a second tap steps on from there. */
  const aim = useRef(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const drag = useRef<{
    id: number;
    x0: number;
    p0: number;
    moved: boolean;
    /** The cover the finger came down on. Captured, the release lands on the track. */
    hit: number | null;
    pressed: HTMLElement | null;
    samples: { t: number; x: number }[];
  } | null>(null);

  /* ── Placement ──────────────────────────────────────────────────────── */

  /** Write every drawn cover's transform for the current position. */
  const apply = (): void => {
    const t = track.current;
    const m = metricsRef.current;
    if (!t || !m) return;
    const p = pos.current;
    const c = m.cover;
    for (const node of Array.from(t.children)) {
      const el = node as HTMLElement;
      const i = Number(el.dataset['i']);
      const d = i - p;
      const a = Math.abs(d);
      const s = Math.sign(d);
      // The first step out swings a cover round and away; past that, the
      // stack just slides, packed tight, the way the original did.
      const near = Math.min(a, 1);
      const x = s * (near * c * 0.66 + Math.max(0, a - 1) * c * 0.3);
      const rot = -s * near * 64;
      const z = -near * c * 0.42;
      el.style.transform = `translate3d(${x.toFixed(1)}px,0,0) perspective(${(c * 3.2).toFixed(0)}px) rotateY(${rot.toFixed(2)}deg) translateZ(${z.toFixed(1)}px)`;
      el.style.zIndex = String(1000 - Math.round(a * 10));
      el.style.opacity = a > WINDOW - 1 ? String(Math.max(0, WINDOW - a)) : '';
    }
  };

  const clampIndex = (i: number): number => Math.max(0, Math.min(n - 1, i));

  /** Move the centre index along with the position, re-rendering only on change. */
  const sync = (): void => {
    const c = clampIndex(Math.round(pos.current));
    if (c !== centerRef.current) {
      centerRef.current = c;
      setCenter(c);
    }
  };

  const stop = (): void => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
  };

  /** One cover along from wherever the row is heading. */
  const step = (by: number): void => glideTo((frame.current ? aim.current : centerRef.current) + by);

  /** Ease to a cover. One rAF loop, ended when it gets there. */
  const glideTo = (target: number): void => {
    stop();
    const to = clampIndex(target);
    aim.current = to;
    const from = pos.current;
    const dist = to - from;
    const duration = Math.min(900, 260 + Math.abs(dist) * 60) * motionScale();
    if (duration < 16 || Math.abs(dist) < 0.001) {
      pos.current = to;
      apply();
      sync();
      return;
    }
    const t0 = performance.now();
    const tick = (now: number): void => {
      const k = Math.min(1, (now - t0) / duration);
      // Ease-out cubic: quick to leave, soft to land.
      pos.current = from + dist * (1 - (1 - k) ** 3);
      apply();
      sync();
      frame.current = k < 1 ? requestAnimationFrame(tick) : 0;
    };
    frame.current = requestAnimationFrame(tick);
  };

  /* ── Size ───────────────────────────────────────────────────────────── */

  useLayoutEffect(() => {
    const el = stage.current;
    const t = track.current;
    if (!el || !t) return;
    const measure = (): void => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const th = t.clientHeight;
      if (w === 0 || th === 0) return;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const cover = Math.round(Math.min(th * 0.72, w * 0.34, rem * 20));
      const panelH = Math.round(Math.min(h - rem, rem * 34));
      // Wider than tall where there is room, for the sleeve-and-tracklist
      // layout; never wider than the stage, however narrow it is.
      const panelW = Math.round(Math.min(w - rem * 1.5, panelH * 1.65));
      const trackDy = Math.round(t.offsetTop + th / 2 - h / 2);
      setMetrics((m) =>
        m && m.cover === cover && m.panelW === panelW && m.panelH === panelH && m.trackDy === trackDy
          ? m
          : { cover, panelW, panelH, trackDy },
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* A new result starts at the beginning, face up. */
  useLayoutEffect(() => {
    stop();
    pos.current = 0;
    centerRef.current = 0;
    setCenter(0);
    setFlipped(null);
  }, [result]);

  // After every render — a new window of covers, new metrics — put them where
  // the position says. Cheap: a dozen style writes.
  useLayoutEffect(apply);

  useEffect(
    () => () => {
      stop();
      clearTimeout(closeTimer.current);
      clearTimeout(wheelTimer.current);
    },
    [],
  );

  /* ── Flipping ───────────────────────────────────────────────────────── */

  const openFlip = (item: MediaItem): void => {
    clearTimeout(closeTimer.current);
    setFlipped({ item, phase: 'opening' });
  };

  const closeFlip = (): void => {
    if (!flipped || flipped.phase === 'closing') return;
    setFlipped({ ...flipped, phase: 'closing' });
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setFlipped(null), 620 * motionScale() + 40);
  };

  /*
   * Opening is two frames: one to draw the card sitting exactly over the
   * cover, and one to tell it to turn. Set both in the same frame and the
   * browser never sees a starting point to transition from.
   */
  useEffect(() => {
    if (flipped?.phase !== 'opening') return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() =>
        setFlipped((f) => (f && f.phase === 'opening' ? { ...f, phase: 'open' } : f)),
      );
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [flipped]);

  /** What a tap on the centre cover means. */
  const activate = (index: number): void => {
    const entry = entries[index];
    if (!entry || entry.item.u === '') return;
    stop();
    pos.current = index;
    apply();
    sync();
    if (isExpandable(entry.item)) openFlip(entry.item);
    else onPick(entry.item);
  };

  /* ── Gestures ───────────────────────────────────────────────────────── */

  const onPointerDown = (e: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    if (drag.current || (e.pointerType === 'mouse' && e.button !== 0)) return;
    // A touch on a gliding row catches it, as on a phone.
    stop();
    const cover = (e.target as Element).closest<HTMLElement>('.cf-cover');
    const hit = cover ? Number(cover.dataset['i']) : null;
    const pressed = hit !== null && hit === Math.round(pos.current) ? cover : null;
    pressed?.setAttribute('data-pressed', '');
    drag.current = {
      id: e.pointerId,
      x0: e.clientX,
      p0: pos.current,
      moved: false,
      hit,
      pressed,
      samples: [{ t: e.timeStamp, x: e.clientX }],
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported for this pointer — a slide-off just ends it */
    }
  };

  const onPointerMove = (e: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    const m = metricsRef.current;
    if (!d || d.id !== e.pointerId || !m) return;
    const dx = e.clientX - d.x0;
    if (!d.moved) {
      if (Math.abs(dx) < SLOP_PX) return;
      d.moved = true;
      d.pressed?.removeAttribute('data-pressed');
    }
    pos.current = rubberBand(d.p0 - dx / (m.cover * 0.42), n - 1);
    apply();
    sync();
    d.samples.push({ t: e.timeStamp, x: e.clientX });
    const cutoff = e.timeStamp - VELOCITY_WINDOW_MS;
    while (d.samples.length > 2 && d.samples[0]!.t < cutoff) d.samples.shift();
  };

  const onPointerUp = (e: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    const m = metricsRef.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    d.pressed?.removeAttribute('data-pressed');

    if (!d.moved) {
      if (d.hit === null) return glideTo(Math.round(pos.current));
      if (d.hit === Math.round(pos.current)) activate(d.hit);
      else glideTo(d.hit);
      return;
    }

    let target = Math.round(pos.current);
    const first = d.samples[0]!;
    const last = d.samples[d.samples.length - 1]!;
    const dt = last.t - first.t;
    // Held still before letting go: land where it is, no fling.
    if (m && dt > 0 && e.timeStamp - last.t < 60) {
      const velocity = -(last.x - first.x) / dt / (m.cover * 0.42); // covers per ms
      target = Math.round(pos.current + velocity * FLING_MS);
    }
    glideTo(target);
  };

  const onPointerCancel = (e: JSX.TargetedPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    d.pressed?.removeAttribute('data-pressed');
    glideTo(Math.round(pos.current));
  };

  /** A trackpad or mouse wheel scrubs, then settles on the nearest cover. */
  const onWheel = (e: JSX.TargetedWheelEvent<HTMLDivElement>): void => {
    const m = metricsRef.current;
    if (!m) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (delta === 0) return;
    e.preventDefault();
    stop();
    pos.current = Math.max(-0.3, Math.min(n - 0.7, pos.current + delta / (m.cover * 0.6)));
    apply();
    sync();
    clearTimeout(wheelTimer.current);
    wheelTimer.current = setTimeout(() => glideTo(Math.round(pos.current)), 140);
  };

  const onKeyDown = (e: JSX.TargetedKeyboardEvent<HTMLDivElement>): void => {
    if (flipped) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeFlip();
      }
      return;
    }
    // Keys pressed on the step buttons are theirs; only the row's own focus
    // drives it.
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'Home') glideTo(0);
    else if (e.key === 'End') glideTo(n - 1);
    else if (e.key === 'Enter' || e.key === ' ') activate(centerRef.current);
    else return;
    e.preventDefault();
  };

  /* ── Drawing ────────────────────────────────────────────────────────── */

  const lo = Math.max(0, center - WINDOW);
  const hi = Math.min(n - 1, center + WINDOW);
  const drawn: { entry: Entry; i: number }[] = [];
  for (let i = lo; i <= hi; i++) drawn.push({ entry: entries[i]!, i });

  const focus = entries[center];
  const showingFlip = flipped !== null;

  return (
    <div
      ref={stage}
      class={showingFlip ? 'cf-stage is-flipped' : 'cf-stage'}
      tabIndex={0}
      aria-roledescription="carousel"
      aria-label="Cover Flow. Swipe or use the arrow keys to browse."
      onKeyDown={onKeyDown}
      style={
        metrics
          ? ({
              '--cf-cover': `${metrics.cover}px`,
              '--cf-panel-w': `${metrics.panelW}px`,
              '--cf-panel-h': `${metrics.panelH}px`,
              '--cf-dy': `${metrics.trackDy}px`,
              '--cf-r': String(metrics.cover / metrics.panelH),
            } as JSX.CSSProperties)
          : undefined
      }
    >
      <div
        ref={track}
        class="cf-track"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onWheel={onWheel}
      >
        {metrics
          ? drawn.map(({ entry, i }) => (
              <div
                key={`${i}:${entry.item.u}`}
                class={
                  i === center
                    ? showingFlip
                      ? 'cf-cover is-center is-lifted'
                      : 'cf-cover is-center'
                    : 'cf-cover'
                }
                data-i={i}
                aria-hidden={i === center ? undefined : 'true'}
              >
                <div class="cf-face">
                  <Artwork
                    src={entry.item.a}
                    icon={KIND_ICON[entry.item.k]}
                    iconSize="3.5rem"
                    alt={entry.item.n}
                    class="cf-art"
                  />
                </div>
              </div>
            ))
          : null}
      </div>

      <div class="cf-caption" aria-live="polite">
        <Pressable
          class="cf-step p-sm"
          onPress={() => step(-1)}
          disabled={center === 0}
          ariaLabel="Previous"
        >
          <Icon name="chevronLeft" size="1.4rem" weight={2.2} />
        </Pressable>
        {focus ? (
          <div class="cf-caption-text" key={`${center}:${focus.item.u}`}>
            <div class="cf-caption-name truncate">{focus.item.n}</div>
            <div class="cf-caption-sub truncate">
              {focus.group ? <span class="cf-caption-group">{focus.group}</span> : null}
              {focus.item.s ?? KIND_LABEL[focus.item.k]}
            </div>
            <div class="cf-caption-hint">
              {focus.item.u === ''
                ? `${center + 1} of ${n}`
                : `${center + 1} of ${n} · ${isExpandable(focus.item) ? 'Tap to flip' : 'Tap to play'}`}
            </div>
          </div>
        ) : null}
        <Pressable
          class="cf-step p-sm"
          onPress={() => step(1)}
          disabled={center >= n - 1}
          ariaLabel="Next"
        >
          <Icon name="chevronRight" size="1.4rem" weight={2.2} />
        </Pressable>
      </div>

      {flipped && metrics ? (
        <>
          {/* Anywhere off the card turns it back over. */}
          <div class="cf-catcher" onPointerDown={closeFlip} />
          <FlipCard
            key={flipped.item.u}
            item={flipped.item}
            open={flipped.phase === 'open'}
            wide={metrics.panelW >= metrics.panelH * 1.3}
            onClose={closeFlip}
            onPick={onPick}
            onOpen={onOpen}
            renderRow={renderRow}
          />
        </>
      ) : null}
    </div>
  );
}

/* ── The back of the cover ────────────────────────────────────────────────*/

/**
 * A cover turned over: what is on it, each row playable or openable.
 *
 * The card is sized for its back, and drawn at the cover's size with a
 * `scale()` until it turns — so the flip is a single compositor transform
 * rather than anything that lays out. The front face is the cover art again,
 * square and centred, so the card at rest is indistinguishable from the cover
 * it replaced; the back is wider than the front, which reads as the card
 * opening out as it turns.
 */
function FlipCard({
  item,
  open,
  wide,
  onClose,
  onPick,
  onOpen,
  renderRow,
}: {
  item: MediaItem;
  open: boolean;
  wide: boolean;
  onClose: () => void;
  onPick: (item: MediaItem) => void;
  onOpen: (item: MediaItem) => void;
  renderRow: (item: MediaItem, onOpen: (item: MediaItem) => void) => VNode;
}) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Same `stale` guard as the browser: a slow answer for a cover you have
  // since put back must not land on the next one.
  useEffect(() => {
    let stale = false;
    setPage(null);
    setError(null);
    browse({ kind: 'item', uri: item.u, offset })
      .then((r) => {
        if (!stale) setPage(r);
      })
      .catch((err: unknown) => {
        if (!stale) setError(err instanceof Error ? err.message : 'Could not load');
      });
    return () => {
      stale = true;
    };
  }, [item.u, offset]);

  const rows = page?.kind === 'list' ? page.items : [];
  const playable = item.o !== true;

  return (
    <div class="cf-flip-wrap">
      <div
        class={open ? 'cf-flip is-open' : 'cf-flip'}
        role="dialog"
        aria-label={item.n}
        aria-modal="true"
      >
        <div class="cf-front" aria-hidden="true">
          <Artwork src={item.a} icon={KIND_ICON[item.k]} iconSize="5rem" class="cf-front-art" />
        </div>

        <div class={wide ? 'cf-back is-wide' : 'cf-back'}>
          <div class="cf-back-head">
            <Artwork src={item.a} icon={KIND_ICON[item.k]} iconSize="2.5rem" class="cf-back-art" />
            <div class="cf-back-titles">
              <div class="cf-back-kind">{KIND_LABEL[item.k]}</div>
              <div class="cf-back-name">{item.n}</div>
              {item.s ? <div class="cf-back-sub truncate">{item.s}</div> : null}
            </div>
            <div class="cf-back-actions">
              {playable ? (
                <Pressable class="cf-back-play" onPress={() => onPick(item)} ariaLabel={`Play ${item.n}`}>
                  <Icon name="play" size="1.2rem" />
                  <span>Play</span>
                </Pressable>
              ) : null}
              <Pressable class="cf-back-close p-sm" onPress={onClose} ariaLabel="Flip back">
                <Icon name="close" size="1.3rem" weight={2} />
              </Pressable>
            </div>
          </div>

          <div class="cf-back-list scroll">
            {error ? (
              <div class="browse-state">
                <Icon name="alert" size="2rem" weight={1.6} />
                <p class="browse-state-title">{error}</p>
              </div>
            ) : !page ? (
              <div class="browse-state">
                <div class="spinner" aria-label="Loading" />
              </div>
            ) : rows.length === 0 ? (
              <div class="browse-state">
                <Icon name="disc" size="2rem" weight={1.6} />
                <p class="browse-state-title">Nothing here yet</p>
                {page.kind === 'list' && page.note ? (
                  <p class="browse-state-hint">{page.note}</p>
                ) : null}
              </div>
            ) : (
              <>
                {rows.map((row, i) => (
                  <div key={`${i}:${row.u}`} class="cf-back-row">
                    {renderRow(row, onOpen)}
                  </div>
                ))}
                {page.kind === 'list' && (offset > 0 || page.more) ? (
                  <div class="cf-back-pager">
                    <Pressable
                      class="pager-btn"
                      onPress={() => setOffset(Math.max(0, offset - BROWSE_PAGE))}
                      disabled={offset === 0}
                      ariaLabel="Previous page"
                    >
                      <Icon name="chevronLeft" size="1.1rem" weight={2.2} />
                      <span>Back</span>
                    </Pressable>
                    <Pressable
                      class="pager-btn"
                      onPress={() => setOffset(offset + BROWSE_PAGE)}
                      disabled={!page.more}
                      ariaLabel="Next page"
                    >
                      <span>More</span>
                      <Icon name="chevronRight" size="1.1rem" weight={2.2} />
                    </Pressable>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Helpers ──────────────────────────────────────────────────────────────*/

/**
 * Past either end the row gives, but less and less: you can feel the end of
 * the list rather than hitting a wall.
 */
function rubberBand(p: number, max: number): number {
  if (p < 0) return -stretch(-p);
  if (p > max) return max + stretch(p - max);
  return p;
}

function stretch(over: number): number {
  return (over * 0.6) / (1 + over * 0.9);
}

/**
 * `ui.motion` from dashboard.yaml, as config/index.ts publishes it, so a
 * panel told to stop moving gets a cut instead of a glide.
 */
function motionScale(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--motion');
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return 1;
  if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
  return Math.max(0, Math.min(1, v));
}
