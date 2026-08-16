import { useEffect, useState } from 'preact/hooks';
import { castConfig, immichConfig, timeOpts } from '~/config/index.ts';
import { now } from '~/state/clock.ts';
import { formatDate, formatMeridiem, formatTime } from '~/lib/format.ts';
import {
  advance,
  currentSlide,
  photoUrl,
  photosReady,
  releaseImages,
  setPairing,
} from '~/media/photos.ts';
import {
  anythingPlaying,
  defaultPlayerId,
  houseAlerts,
  speakers,
  statusItems,
  weather,
} from '~/state/selectors.ts';
import { Icon } from '~/components/Icon.tsx';
import { getToken } from '~/net/auth.ts';
import { castPaneOverride } from '~/lib/cast.ts';
import { CAST_PANES, type CastPane } from '@shared/config.ts';

/**
 * What a Google Nest Hub shows.
 *
 * ## Why this is a separate screen rather than the dashboard scaled down
 *
 * A cast page is a *display*. It is reached by casting, which means no
 * guaranteed touch, no navigation, and a device that will take its screen back
 * for a timer or a voice answer whenever it feels like it. Trying to squeeze
 * the real dashboard onto that produces something that looks interactive and
 * mostly is not, which is worse than an honest read-only view.
 *
 * So: a handful of panes that rotate on their own, typography sized to be read
 * from across a kitchen rather than tapped, and nothing that needs a finger.
 *
 * ## Interaction
 *
 * `lib/cast.ts` asks the platform for touch, and a Nest Hub does honour it
 * (confirmed August 2026) — so tapping advances to the next pane. If you want
 * the real, fully interactive dashboard instead, cast `?pane=dashboard`; these
 * panes remain the better choice for a display you only ever read, and the
 * only choice if Google stops delivering touch.
 *
 * ## One display, one job
 *
 * `?pane=media` pins a display to a single pane. That is per-URL rather than
 * per-config because it is how these are actually used: the kitchen Hub wants
 * what is playing and the hallway one wants the clock, and they share one
 * `dashboard.yaml`.
 */

/**
 * `?pane=` pins this display to one thing. Read once — it is part of the URL
 * the device was cast, and that cannot change without a re-cast.
 */
const PINNED = (() => {
  const raw = castPaneOverride();
  return raw && (CAST_PANES as readonly string[]).includes(raw) ? (raw as CastPane) : null;
})();

export function Cast() {
  const cfg = castConfig.value;
  const panes = PINNED ? [PINNED] : cfg.panes.length > 0 ? cfg.panes : (['clock'] as CastPane[]);

  const [index, setIndex] = useState(0);
  const pane = panes[index % panes.length] ?? 'clock';

  /*
   * Rotate.
   *
   * `rotateSeconds: 0` pins the first pane, which is the right behaviour for
   * a display someone put in a specific place for a specific reason.
   */
  useEffect(() => {
    if (PINNED || panes.length < 2 || cfg.rotateSeconds <= 0) return;
    const timer = setInterval(
      () => setIndex((i) => i + 1),
      Math.max(5, cfg.rotateSeconds) * 1000,
    );
    return () => clearInterval(timer);
  }, [panes.length, cfg.rotateSeconds]);

  /*
   * Jump to the music when music starts.
   *
   * A display in the kitchen showing the weather while someone is picking an
   * album is showing the wrong thing. Only fires on the transition into
   * playing, so it does not fight the rotation for the whole album.
   */
  const playing = anythingPlaying.value;
  useEffect(() => {
    // A pinned display was pinned on purpose; do not second-guess it.
    if (PINNED || !cfg.followMusic || !playing) return;
    const at = panes.indexOf('media');
    if (at >= 0) setIndex(at);
  }, [playing, cfg.followMusic, panes]);

  return (
    <div
      class="cast"
      onPointerDown={() => setIndex((i) => i + 1)}
      data-pane={pane}
    >
      {cfg.audioKeepAlive ? <SilentLoop /> : null}
      <Pane kind={pane} />
    </div>
  );
}

function Pane({ kind }: { kind: CastPane }) {
  switch (kind) {
    case 'status':
      return <StatusPane />;
    case 'media':
      return <MediaPane />;
    case 'photos':
      return <PhotoPane />;
    default:
      return <ClockPane />;
  }
}

/* ── Clock ────────────────────────────────────────────────────────────────*/

function ClockPane() {
  const t = timeOpts.value;
  const d = now.value;
  const w = weather.value;
  const alerts = houseAlerts.value;

  return (
    <div class="cast-pane cast-clock">
      <div class="cast-time">
        {formatTime(d, t)}
        {t.hour12 ? <span class="cast-meridiem">{formatMeridiem(d, t)}</span> : null}
      </div>
      <div class="cast-date">{formatDate(d, t)}</div>

      {w ? (
        <div class="cast-weather">
          <Icon name={w.icon} size="2.2rem" weight={1.5} />
          <span>{w.value}</span>
        </div>
      ) : null}

      {/* Alerts outrank everything: an unlocked door is the one thing worth
          interrupting a clock for. */}
      {alerts.length > 0 ? (
        <div class="cast-alerts">
          {alerts.slice(0, 3).map((a) => (
            <div key={a.entity} class="cast-alert">
              <Icon name="alert" size="1.4rem" weight={1.9} />
              <span>{a.label}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ── Status ───────────────────────────────────────────────────────────────*/

function StatusPane() {
  const items = statusItems.value;
  const alerts = houseAlerts.value;

  if (items.length === 0 && alerts.length === 0) return <ClockPane />;

  return (
    <div class="cast-pane cast-status">
      <div class="cast-grid">
        {items.slice(0, 6).map((item) => (
          <div key={item.id} class="cast-stat">
            <div class="cast-stat-value">{item.value}</div>
            <div class="cast-stat-label">{item.label}</div>
          </div>
        ))}
      </div>

      {alerts.length > 0 ? (
        <div class="cast-alerts">
          {alerts.slice(0, 3).map((a) => (
            <div key={a.entity} class="cast-alert">
              <Icon name="alert" size="1.4rem" weight={1.9} />
              <span>{a.label}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ── Now playing ──────────────────────────────────────────────────────────*/

function MediaPane() {
  const all = speakers.value;
  // Prefer whatever is actually making noise over the configured default: on
  // a display, "what is playing" is the entire question.
  const player =
    all.find((s) => s.state === 'playing' && s.media?.title) ??
    all.find((s) => s.id === defaultPlayerId.value);

  const media = player?.media;
  if (!media?.title) return <ClockPane />;

  return (
    <div class="cast-pane cast-media">
      <CastArt src={media.art} />
      <div class="cast-media-meta">
        <div class="cast-track truncate">{media.title}</div>
        {media.artist ? <div class="cast-artist truncate">{media.artist}</div> : null}
        {media.album ? <div class="cast-album truncate">{media.album}</div> : null}
        <div class="cast-room">
          <Icon name="speaker" size="1.2rem" weight={1.8} />
          <span class="truncate">{player?.name}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Cover art with a glyph fallback.
 *
 * Not the shared `Artwork` component: that one is sized for a list row and
 * carries the browse styling. What it shares is the reason it exists — a
 * browser's broken-image icon, on a display nobody can touch to fix, reads as
 * "this thing is broken" rather than "this album has no cover".
 */
function CastArt({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  const token = getToken();

  useEffect(() => setFailed(false), [src]);

  if (!src || failed) {
    return (
      <div class="cast-art">
        <Icon name="media" size="5rem" weight={1.2} />
      </div>
    );
  }

  return (
    <div class="cast-art">
      <img
        src={`${src}${token ? `&t=${encodeURIComponent(token)}` : ''}`}
        alt=""
        decoding="async"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

/* ── Photos ───────────────────────────────────────────────────────────────*/

/**
 * The Immich slideshow, minus the screensaver's overlays.
 *
 * Reuses `media/photos.ts` wholesale, which matters for the memory rule that
 * module enforces: it holds at most two decoded images and releases them on
 * unmount. A Nest Hub has less headroom than the Navigator, not more.
 */
function PhotoPane() {
  const immich = immichConfig.value;
  const slide = currentSlide.value;
  const ready = photosReady.value;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    setPairing(immich.pairPortraits);

    const step = async (): Promise<void> => {
      if (cancelled) return;
      await advance();
      if (cancelled) return;
      timer = setTimeout(() => void step(), Math.max(5, immich.intervalSeconds) * 1000);
    };
    void step();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      releaseImages();
    };
  }, [immich.pairPortraits, immich.intervalSeconds]);

  if (!ready || slide.length === 0) return <ClockPane />;

  return (
    <div class="cast-pane cast-photos" data-count={slide.length}>
      {slide.map((photo) => (
        <img key={photo.id} src={photoUrl(photo.id, 'full')} alt="" decoding="async" />
      ))}
    </div>
  );
}

/* ── Keep-alive ───────────────────────────────────────────────────────────*/

/**
 * A silent loop, to hold the cast session open.
 *
 * Off unless `cast.audioKeepAlive` is set, and worth understanding before you
 * turn it on: this takes the device's audio focus. On a Nest Hub that is also
 * a Music Assistant speaker, that may interrupt or block playback on the very
 * speaker you are looking at. `disableIdleTimeout` in lib/cast.ts is the
 * primary mechanism and costs nothing; this is the fallback for when it is
 * not enough.
 */
function SilentLoop() {
  return (
    <audio
      src="/silence.wav"
      autoPlay
      loop
      // Not `muted`: a muted element may not count as playback at all, which
      // would defeat the entire point of having it.
      aria-hidden="true"
      style={{ display: 'none' }}
    />
  );
}
