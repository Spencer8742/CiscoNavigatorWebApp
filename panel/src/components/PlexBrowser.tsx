import { useEffect, useState } from 'preact/hooks';
import { Artwork } from '~/components/Artwork.tsx';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { plex } from '~/net/socket.ts';
import { formatDuration } from '~/lib/format.ts';
import { markActivity, showToast } from '~/state/ui.ts';
import { PLEX_PAGE } from '@shared/protocol.ts';
import type { PlexItem, PlexKind, PlexResult, PlexTarget } from '@shared/protocol.ts';

/**
 * Browse Plex, then choose where to play what you found.
 *
 * Everything comes off the Plex server at the moment it is asked for — no
 * library is kept here — and one page is held at a time, replaced rather than
 * appended, for the same memory reasons as the music browser
 * (components/Browse.tsx, docs/ROOMOS.md §2).
 *
 * Playing is a second step on purpose. "Where" is the whole point of this
 * screen: the same film could go to the living room or the bedroom, and the
 * Apple TV currently selected above is only the likely answer, not the
 * certain one.
 */

/** One level of the drill-down. */
interface Crumb {
  id: string;
  title: string;
  library: boolean;
  /** The item itself, when it can be played as a whole (a season, an album). */
  item: PlexItem | null;
}

export function PlexBrowser({ preferred }: { preferred: string | null }) {
  const [path, setPath] = useState<Crumb[]>([]);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<PlexResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState<PlexItem | null>(null);
  const here = path[path.length - 1] ?? null;

  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError(null);
    plex(here ? { kind: 'open', id: here.id, library: here.library, offset } : { kind: 'home' })
      .then((r) => {
        if (stale) return;
        setResult(r);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (stale) return;
        setResult(null);
        setError(err instanceof Error ? err.message : 'Could not load Plex');
        setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [here?.id, offset, attempt]);

  const open = (item: PlexItem): void => {
    markActivity();
    setPath((p) => [
      ...p,
      { id: item.id, title: item.title, library: item.kind === 'library', item: item.playable ? item : null },
    ]);
    setOffset(0);
  };

  const back = (): void => {
    markActivity();
    setPath((p) => p.slice(0, -1));
    setOffset(0);
  };

  const pick = (item: PlexItem): void => {
    markActivity();
    setChosen(item);
  };

  const title = here ? here.title : result?.kind === 'home' ? result.server : 'Plex';

  return (
    <section class="plex">
      <header class="plex-head">
        {here ? (
          <Pressable class="sheet-back p-sm" onPress={back} ariaLabel="Back">
            <Icon name="chevronLeft" size="1.4rem" weight={2.2} />
          </Pressable>
        ) : null}
        <h2 class="plex-title truncate">{title}</h2>
        {here?.item ? (
          <Pressable
            class="plex-play-all"
            onPress={() => pick(here.item as PlexItem)}
            ariaLabel={`Play all of ${here.title}`}
          >
            <Icon name="play" size="1rem" />
            <span>Play all</span>
          </Pressable>
        ) : null}
      </header>

      <div class="plex-body">
        {loading ? (
          <div class="browse-state"><div class="spinner" aria-label="Loading" /></div>
        ) : error ? (
          <div class="browse-state">
            <Icon name="alert" size="2rem" weight={1.6} />
            <p class="browse-state-title">{error}</p>
            <Pressable class="pager-btn" onPress={() => setAttempt((n) => n + 1)} ariaLabel="Try again">
              <Icon name="refresh" size="1.1rem" />
              <span>Try again</span>
            </Pressable>
          </div>
        ) : result?.kind === 'home' ? (
          result.sections.map((section) =>
            section.title === 'Libraries' ? (
              <div key={section.title}>
                <div class="group-section">{section.title}</div>
                {section.items.length ? (
                  <div class="plex-libraries">
                    {section.items.map((item) => (
                      <Row key={item.id} item={item} onOpen={open} onPick={pick} />
                    ))}
                  </div>
                ) : (
                  <p class="browse-note">This Plex server has no movie or TV libraries.</p>
                )}
              </div>
            ) : (
              <div key={section.title}>
                <div class="group-section">{section.title}</div>
                <div class="plex-shelf">
                  {section.items.map((item) => (
                    <Card key={item.id} item={item} onOpen={open} onPick={pick} />
                  ))}
                </div>
              </div>
            ),
          )
        ) : result?.kind === 'list' ? (
          result.items.length ? (
            // Films, shows, seasons and albums get a poster wall, the way
            // Plex itself shows a library. Episodes and songs stay rows: one
            // show's poster repeated down a season says nothing.
            result.items.every((item) => item.kind !== 'episode' && SHAPE[item.kind] !== null) ? (
              <div class="plex-grid">
                {result.items.map((item) => <Card key={item.id} item={item} onOpen={open} onPick={pick} />)}
              </div>
            ) : (
              result.items.map((item) => <Row key={item.id} item={item} onOpen={open} onPick={pick} />)
            )
          ) : (
            <div class="browse-state">
              <Icon name="tv" size="2rem" weight={1.6} />
              <p class="browse-state-title">Nothing here</p>
            </div>
          )
        ) : null}
      </div>

      {!loading && result?.kind === 'list' && (offset > 0 || result.more) ? (
        <div class="browse-pager">
          <Pressable
            class="pager-btn"
            onPress={() => setOffset(Math.max(0, offset - PLEX_PAGE))}
            disabled={offset === 0}
            ariaLabel="Previous page"
          >
            <Icon name="chevronLeft" size="1.1rem" weight={2.2} />
            <span>Back</span>
          </Pressable>
          <span class="pager-count">Page {Math.floor(offset / PLEX_PAGE) + 1}</span>
          <Pressable
            class="pager-btn"
            onPress={() => setOffset(offset + PLEX_PAGE)}
            disabled={!result.more}
            ariaLabel="Next page"
          >
            <span>More</span>
            <Icon name="chevronRight" size="1.1rem" weight={2.2} />
          </Pressable>
        </div>
      ) : null}

      {chosen ? <PlayOn item={chosen} preferred={preferred} onClose={() => setChosen(null)} /> : null}
    </section>
  );
}

/**
 * A row: opens when it has contents, plays when it is one thing.
 *
 * A season or an album is both, so like the music browser it gets both
 * targets — the row opens it, the button on the right plays it whole.
 */
function Row({ item, onOpen, onPick }: RowProps) {
  const both = item.browsable && item.playable;
  return (
    <div class="browse-row">
      <Pressable
        as="div"
        class="browse-main"
        onPress={() => (item.browsable ? onOpen(item) : onPick(item))}
        ariaLabel={item.browsable ? `Open ${item.title}` : `Play ${item.title}`}
      >
        <Artwork src={item.art} icon={KIND_ICON[item.kind]} />
        <div class="browse-meta">
          <div class="browse-name truncate">{item.title}</div>
          <div class="browse-sub truncate">{detail(item)}</div>
        </div>
        {item.browsable ? <Icon name="chevronRight" size="1.1rem" weight={2} /> : null}
        {item.watched ? <Icon name="check" size="1.1rem" weight={2.2} class="plex-watched" /> : null}
      </Pressable>
      {both || (!item.browsable && item.playable) ? (
        <Pressable class="browse-play p-sm" onPress={() => onPick(item)} ariaLabel={`Play ${item.title}`}>
          <Icon name="play" size="1.1rem" />
        </Pressable>
      ) : null}
    </div>
  );
}

/**
 * A poster: on the Continue Watching and Recently Added shelves, and in an
 * opened library. Video is 2:3 like a one-sheet, music is a square sleeve.
 */
function Card({ item, onOpen, onPick }: RowProps) {
  const progress = item.resume && item.duration ? Math.min(1, item.resume / item.duration) : 0;
  return (
    <Pressable
      class={SHAPE[item.kind] === 'poster' ? 'plex-card is-poster' : 'plex-card'}
      onPress={() => (item.playable && !item.browsable ? onPick(item) : onOpen(item))}
      ariaLabel={item.title}
    >
      <span class="plex-poster">
        <Artwork src={item.art} icon={KIND_ICON[item.kind]} />
        {item.watched && !progress ? (
          <span class="plex-poster-badge"><Icon name="check" size="0.9rem" weight={2.6} /></span>
        ) : null}
        {progress > 0 ? (
          <span class="plex-progress"><span style={{ transform: `scaleX(${progress})` }} /></span>
        ) : null}
      </span>
      <span class="plex-card-title truncate">{item.kind === 'episode' && item.subtitle ? item.subtitle.split(' · ')[0] : item.title}</span>
      <span class="plex-card-sub truncate">
        {item.kind === 'episode' ? item.title : (item.subtitle ?? '')}
      </span>
    </Pressable>
  );
}

interface RowProps {
  item: PlexItem;
  onOpen: (item: PlexItem) => void;
  onPick: (item: PlexItem) => void;
}

/* ── Choosing where ─────────────────────────────────────────────────────── */

/**
 * "Play on…": every place this could go, with the Apple TV you were looking
 * at first.
 *
 * An Apple TV that is asleep or showing another app is still listed — waking
 * it and opening Plex is part of playing there — so the wait after a tap can
 * be several seconds. The row says so while it happens rather than leaving a
 * tap that seems to have done nothing.
 */
function PlayOn({ item, preferred, onClose }: { item: PlexItem; preferred: string | null; onClose: () => void }) {
  const [targets, setTargets] = useState<PlexTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [resume, setResume] = useState(item.resume !== null);

  useEffect(() => {
    let stale = false;
    plex({ kind: 'targets' })
      .then((r) => {
        if (stale || r.kind !== 'targets') return;
        setTargets([...r.targets].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred)));
      })
      .catch((err: unknown) => {
        if (!stale) setError(err instanceof Error ? err.message : 'Could not find players');
      });
    return () => {
      stale = true;
    };
  }, []);

  const play = (target: PlexTarget): void => {
    if (busy) return;
    markActivity();
    setBusy(target.id);
    setError(null);
    plex({ kind: 'play', id: item.id, target: target.id, resume })
      .then(() => {
        showToast(`Playing ${item.title} on ${target.name}`);
        onClose();
      })
      .catch((err: unknown) => {
        setBusy(null);
        setError(err instanceof Error ? err.message : 'Could not start playback');
      });
  };

  return (
    <div class="sheet-layer is-nested" onPointerDown={() => markActivity()}>
      <div class="sheet-scrim" onPointerDown={busy ? undefined : onClose} />
      <div class="sheet play-sheet" role="dialog" aria-label={`Play ${item.title}`} aria-modal="true">
        <div class="sheet-head">
          <div class="sheet-titles">
            <h2 class="sheet-title truncate">{item.title}</h2>
            <div class="sheet-subtitle truncate">{detail(item)}</div>
          </div>
          <Pressable class="sheet-close p-sm" onPress={onClose} ariaLabel="Close">
            <Icon name="close" size="1.4rem" weight={2} />
          </Pressable>
        </div>

        <div class="sheet-body scroll">
          {item.resume !== null ? (
            <div class="segmented plex-resume" role="group" aria-label="Where to start">
              <Pressable
                class={resume ? 'seg-item is-active' : 'seg-item'}
                onPress={() => setResume(true)}
                ariaPressed={resume}
                ariaLabel="Resume"
              >
                Resume from {formatDuration(item.resume)}
              </Pressable>
              <Pressable
                class={!resume ? 'seg-item is-active' : 'seg-item'}
                onPress={() => setResume(false)}
                ariaPressed={!resume}
                ariaLabel="Start over"
              >
                Start over
              </Pressable>
            </div>
          ) : null}

          <div class="sheet-section-label">Play on</div>
          {targets === null && !error ? (
            <div class="browse-state"><div class="spinner" aria-label="Finding players" /></div>
          ) : null}
          {targets?.length === 0 ? (
            <p class="browse-note">
              Nothing to play on. Add an Apple TV under <code>controls.appleTvs</code>, mark a Mac
              under <code>controls.ssh</code> with <code>iina: true</code>, or open Plex on a player on
              this network.
            </p>
          ) : null}
          {targets?.map((target, index) => (
            <Pressable
              key={target.id}
              class={index === 0 && preferred && target.id === preferred ? 'play-option is-primary' : 'play-option'}
              onPress={() => play(target)}
              disabled={busy !== null && busy !== target.id}
              ariaLabel={`Play on ${target.name}`}
            >
              {busy === target.id ? <span class="spinner plex-spinner" /> : <Icon name={target.appleTv ? 'tv' : 'play'} size="1.3rem" />}
              <span class="plex-target">
                <span class="truncate">{target.name}</span>
                <small class="truncate">
                  {busy === target.id
                    ? target.appleTv ? 'Opening Plex…' : 'Starting…'
                    : target.product}
                </small>
              </span>
            </Pressable>
          ))}
          {error ? <p class="apple-tv-error">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}

function detail(item: PlexItem): string {
  const parts: string[] = [];
  if (item.subtitle) parts.push(item.subtitle);
  else parts.push(KIND_LABEL[item.kind]);
  if (item.resume && item.duration) parts.push(`${formatDuration(item.duration - item.resume)} left`);
  return parts.join(' · ');
}

const KIND_LABEL: Record<PlexKind, string> = {
  library: 'Library',
  movie: 'Movie',
  show: 'TV show',
  season: 'Season',
  episode: 'Episode',
  artist: 'Artist',
  album: 'Album',
  track: 'Song',
  clip: 'Video',
  folder: 'Folder',
};

/** How a kind is drawn as a card, or null when it is only ever a row. */
const SHAPE: Record<PlexKind, 'poster' | 'square' | null> = {
  library: null,
  movie: 'poster',
  show: 'poster',
  season: 'poster',
  episode: 'poster',
  artist: 'square',
  album: 'square',
  track: null,
  clip: 'poster',
  folder: null,
};

const KIND_ICON: Record<PlexKind, string> = {
  library: 'list',
  movie: 'tv',
  show: 'tv',
  season: 'tv',
  episode: 'tv',
  artist: 'media',
  album: 'disc',
  track: 'media',
  clip: 'tv',
  folder: 'list',
};
