import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { browse } from '~/net/socket.ts';
import { Artwork } from '~/components/Artwork.tsx';
import { speakers } from '~/state/selectors.ts';
import * as act from '~/state/actions.ts';
import { BROWSE_PAGE } from '@shared/protocol.ts';
import type {
  BrowseRequest,
  BrowseResult,
  MediaItem,
  MediaKind,
} from '@shared/protocol.ts';

/**
 * The music browser.
 *
 * Everything here comes off the speakers themselves — this app keeps no
 * library, no cache of album names and no search index of its own. Which means
 * whatever you favourited in the Sonos app this morning is here, and the panel
 * never disagrees with the Sonos app about what exists.
 *
 * ## Why tabs rather than a folder tree
 *
 * Home Assistant's media browser is a hierarchy you walk down: source, then
 * category, then letter, then album. That is fine with a mouse. On a wall
 * panel it is four taps and a soft keyboard before you hear anything, and
 * every one of those taps is a round trip.
 *
 * These are six flat views over the same call, with the one you actually use
 * — what you favourited in the Sonos app — first and needing no typing at all.
 *
 * There is no "Recently played". Sonos keeps no play history, locally or in
 * its cloud API, and inventing one from what this panel happened to start
 * would be a narrower thing wearing the same label.
 *
 * ## Memory
 *
 * One page of sixty rows is held at a time, and paging forward REPLACES the
 * list rather than appending. An infinite scroll that accumulates a thousand
 * rows and a thousand decoded cover images is exactly the kind of slow leak
 * that gets a RoomOS web view terminated a few hours later (docs/ROOMOS.md §2)
 * — and nobody scrolls a wall panel for ten minutes anyway.
 */

/** A tab is a library view or a search — never a queue lookup. */
type TabRequest = Extract<BrowseRequest, { kind: 'library' } | { kind: 'search' }>;

interface Tab {
  id: string;
  label: string;
  icon: string;
  request: TabRequest;
}

const TABS: Tab[] = [
  {
    id: 'favorites',
    label: 'Favorites',
    icon: 'heart',
    /*
     * The one that earns its place at the front. On Sonos, Favorites is a
     * PLACE rather than a filter — whatever you starred in the Sonos app, of
     * any kind, from any service — and it plays with no service login on this
     * side at all. For a wall panel it is most of what anyone reaches for.
     */
    request: { kind: 'library', media: 'track', favorite: true },
  },
  {
    id: 'playlists',
    label: 'Playlists',
    icon: 'list',
    request: { kind: 'library', media: 'playlist' },
  },
  { id: 'albums', label: 'Albums', icon: 'disc', request: { kind: 'library', media: 'album' } },
  { id: 'artists', label: 'Artists', icon: 'media', request: { kind: 'library', media: 'artist' } },
  { id: 'radio', label: 'Radio', icon: 'radio', request: { kind: 'library', media: 'radio' } },
  { id: 'search', label: 'Search', icon: 'search', request: { kind: 'search', text: '' } },
];

/**
 * Where a search looks.
 *
 * There is no "search everything": the local library is searched by object id
 * on the speakers, and a streaming catalog only through that service's own
 * API. Naming the source is two taps instead of one, and it is the honest
 * shape of the system rather than a guess that silently misses half of it.
 */
const SOURCES: { id: 'library' | 'spotify'; label: string }[] = [
  { id: 'library', label: 'Library' },
  { id: 'spotify', label: 'Spotify' },
];

/** One level of the drill-down: what we opened, and what it was called. */
interface Crumb {
  uri: string;
  name: string;
}

export function Browse({ playerId, onClose }: { playerId: string; onClose: () => void }) {
  const [tab, setTab] = useState('favorites');
  const [source, setSource] = useState<'library' | 'spotify'>('library');
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [chosen, setChosen] = useState<MediaItem | null>(null);
  /**
   * The drill-down stack.
   *
   * A stack rather than a route, so Back always means "up one" and closing
   * the sheet forgets the whole path — which is what you want on a panel that
   * anyone might walk up to next.
   */
  const [path, setPath] = useState<Crumb[]>([]);

  const current = TABS.find((t) => t.id === tab) ?? (TABS[0] as Tab);
  const here = path[path.length - 1] ?? null;
  const playerName = speakers.value.find((s) => s.id === playerId)?.name ?? playerId;

  /*
   * Load whenever the view changes.
   *
   * `stale` rather than an AbortController because there is nothing to abort —
   * the request is a WebSocket message already on its way. What matters is
   * that a slow answer to a tab you have since left cannot overwrite the one
   * you are looking at, which is otherwise very easy to trigger by tapping
   * along the tab strip.
   */
  useEffect(() => {
    let stale = false;

    const req: BrowseRequest = here
      ? { kind: 'item', uri: here.uri, offset }
      : current.request.kind === 'search'
        ? { kind: 'search', text: query, source }
        : { ...current.request, offset };

    // An empty search box is not a request; it is the state before one.
    if (req.kind === 'search' && req.text.trim().length === 0) {
      setResult({ kind: 'groups', groups: [] });
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    browse(req)
      .then((r) => {
        if (stale) return;
        setResult(r);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (stale) return;
        setResult(null);
        setError(err instanceof Error ? err.message : 'Could not load');
        setLoading(false);
      });

    return () => {
      stale = true;
    };
  }, [tab, offset, query, source, here?.uri]);

  const pick = (t: string): void => {
    setTab(t);
    setOffset(0);
    setPath([]);
  };

  /** Open an item's contents — an album's tracks, an artist's albums. */
  const open = (item: MediaItem): void => {
    setPath((p) => [...p, { uri: item.u, name: item.n }]);
    setOffset(0);
  };

  const back = (): void => {
    setPath((p) => p.slice(0, -1));
    setOffset(0);
  };

  return (
    <div class="sheet-layer">
      <div class="sheet-scrim" onPointerDown={onClose} />

      <div class="sheet browse-sheet" role="dialog" aria-label="Browse music" aria-modal="true">
        <div class="sheet-head">
          {here ? (
            <Pressable class="sheet-back p-sm" onPress={back} ariaLabel="Back">
              <Icon name="chevronLeft" size="1.4rem" weight={2.2} />
            </Pressable>
          ) : null}
          <div class="sheet-titles">
            <h2 class="sheet-title truncate">{here ? here.name : 'Browse'}</h2>
            <div class="sheet-subtitle truncate">Play on {playerName}</div>
          </div>
          {here ? (
            <Pressable
              class="sheet-edit p-sm"
              onPress={() => setChosen({ u: here.uri, n: here.name, k: 'album' })}
              ariaLabel={`Play all of ${here.name}`}
            >
              Play all
            </Pressable>
          ) : null}
          <Pressable class="sheet-close p-sm" onPress={onClose} ariaLabel="Close">
            <Icon name="close" size="1.4rem" weight={2} />
          </Pressable>
        </div>

        {/* The tab strip disappears while drilled in: it would offer to jump
            somewhere else from a screen whose whole job is "you are inside
            this album", and Back is the only navigation that makes sense there. */}
        {here ? null : (
          <div class="browse-tabs" role="tablist">
            {TABS.map((t) => (
              <Pressable
                key={t.id}
                class={t.id === tab ? 'browse-tab is-active' : 'browse-tab'}
                onPress={() => pick(t.id)}
                ariaPressed={t.id === tab}
                ariaLabel={t.label}
              >
                <Icon name={t.icon} size="1.1rem" weight={1.8} />
                <span>{t.label}</span>
              </Pressable>
            ))}
          </div>
        )}

        {tab === 'search' && !here ? (
          <>
            <div class="browse-sources" role="group" aria-label="Where to search">
              {SOURCES.map((s) => (
                <Pressable
                  key={s.id}
                  class={s.id === source ? 'browse-source is-active' : 'browse-source'}
                  onPress={() => setSource(s.id)}
                  ariaPressed={s.id === source}
                  ariaLabel={`Search ${s.label}`}
                >
                  {s.label}
                </Pressable>
              ))}
            </div>
            <SearchBox value={query} onSearch={setQuery} />
          </>
        ) : null}

        <div class="sheet-body scroll browse-body">
          <Results
            loading={loading}
            error={error}
            result={result}
            searching={tab === 'search' && !here}
            query={query}
            onPick={setChosen}
            onOpen={open}
          />
        </div>

        {result?.kind === 'list' && (offset > 0 || result.more) ? (
          <div class="browse-pager">
            <Pressable
              class="pager-btn"
              onPress={() => setOffset(Math.max(0, offset - BROWSE_PAGE))}
              disabled={offset === 0}
              ariaLabel="Previous page"
            >
              <Icon name="chevronLeft" size="1.1rem" weight={2.2} />
              <span>Back</span>
            </Pressable>
            {/* `offset` counts ITEMS, as Sonos does. The page number is a
                display detail derived from it, not the thing being sent. */}
            <span class="pager-count">Page {Math.floor(offset / BROWSE_PAGE) + 1}</span>
            <Pressable
              class="pager-btn"
              onPress={() => setOffset(offset + BROWSE_PAGE)}
              disabled={!result.more}
              ariaLabel="Next page"
            >
              <span>More</span>
              <Icon name="chevronRight" size="1.1rem" weight={2.2} />
            </Pressable>
          </div>
        ) : null}
      </div>

      {chosen ? (
        <PlayOptions
          item={chosen}
          playerId={playerId}
          playerName={playerName}
          onDone={() => {
            setChosen(null);
            onClose();
          }}
          onCancel={() => setChosen(null)}
        />
      ) : null}
    </div>
  );
}

/* ── Results ──────────────────────────────────────────────────────────────*/

function Results({
  loading,
  error,
  result,
  searching,
  query,
  onPick,
  onOpen,
}: {
  loading: boolean;
  error: string | null;
  result: BrowseResult | null;
  searching: boolean;
  query: string;
  onPick: (item: MediaItem) => void;
  onOpen: (item: MediaItem) => void;
}) {
  if (loading) {
    return (
      <div class="browse-state">
        <div class="spinner" aria-label="Loading" />
      </div>
    );
  }

  if (error) {
    return (
      <div class="browse-state">
        <Icon name="alert" size="2rem" weight={1.6} />
        <p class="browse-state-title">{error}</p>
        <p class="browse-state-hint">
          Transport and volume still work — this is only the library.
        </p>
      </div>
    );
  }

  if (result?.kind === 'groups') {
    if (result.groups.length === 0) {
      return (
        <div class="browse-state">
          <Icon name="search" size="2rem" weight={1.6} />
          <p class="browse-state-title">
            {searching && query.trim().length > 0 ? 'Nothing found' : 'Search your library'}
          </p>
        </div>
      );
    }
    return (
      <>
        {result.groups.map((group) => (
          <div key={group.name}>
            <div class="group-section">{group.name}</div>
            {group.items.map((item) => (
              <ItemRow key={item.u} item={item} onPick={onPick} onOpen={onOpen} />
            ))}
          </div>
        ))}
      </>
    );
  }

  if (result?.kind === 'list') {
    if (result.items.length === 0) {
      return (
        <div class="browse-state">
          <Icon name="disc" size="2rem" weight={1.6} />
          <p class="browse-state-title">Nothing here yet</p>
          <p class="browse-state-hint">
            Sonos reported nothing of this kind. Favorites and playlists come from the
            Sonos app; albums and artists need a music library set up there.
          </p>
        </div>
      );
    }
    return (
      <>
        {result.items.map((item) => (
          <ItemRow key={item.u} item={item} onPick={onPick} onOpen={onOpen} />
        ))}
      </>
    );
  }

  return null;
}

/** Kinds whose contents can be opened rather than only played. */
const EXPANDABLE = new Set<MediaKind>(['album', 'artist', 'playlist', 'podcast']);

/**
 * One browsable row.
 *
 * An album has two reasonable meanings for a tap — "play this" and "show me
 * what is on it" — so it gets both: the row opens it, and a play button on
 * the right plays it. A track has only one meaning, so the whole row plays.
 */
function ItemRow({
  item,
  onPick,
  onOpen,
}: {
  item: MediaItem;
  onPick: (item: MediaItem) => void;
  onOpen: (item: MediaItem) => void;
}) {
  const expandable = EXPANDABLE.has(item.k) && item.u !== '';

  return (
    <div class="browse-row">
      <Pressable
        as="div"
        class="browse-main"
        onPress={() => (expandable ? onOpen(item) : onPick(item))}
        ariaLabel={expandable ? `Open ${item.n}` : item.n}
        disabled={item.u === ''}
      >
        <Artwork src={item.a} icon={KIND_ICON[item.k]} />
        <div class="browse-meta">
          <div class="browse-name truncate">{item.n}</div>
          <div class="browse-sub truncate">{item.s ?? KIND_LABEL[item.k]}</div>
        </div>
        {expandable ? <Icon name="chevronRight" size="1.1rem" weight={2} /> : null}
      </Pressable>

      <Pressable
        class="browse-play p-sm"
        onPress={() => onPick(item)}
        ariaLabel={`Play ${item.n}`}
        disabled={item.u === ''}
      >
        <Icon name="play" size="1.1rem" />
      </Pressable>
    </div>
  );
}

/* ── Search ───────────────────────────────────────────────────────────────*/

/**
 * The one place in this app that asks for typing.
 *
 * RoomOS's soft keyboard has no numeric, date or color modes and is generally
 * something to design around (docs/ROOMOS.md §6) — which is why searching is
 * the last tab rather than the first, and why nothing else here needs it.
 *
 * The query is submitted rather than live: searching on every keystroke would
 * fire a request per letter at the speakers or at a streaming service, and
 * the answers would arrive out of order on a link this app cannot assume is
 * fast.
 */
function SearchBox({ value, onSearch }: { value: string; onSearch: (text: string) => void }) {
  const [text, setText] = useState(value);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const submit = (): void => onSearch(text.trim());

  return (
    <form
      class="browse-search"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Icon name="search" size="1.2rem" weight={1.9} />
      <input
        ref={input}
        class="browse-input"
        type="search"
        value={text}
        placeholder="Artist, album or song"
        aria-label="Search music"
        enterkeyhint="search"
        autocomplete="off"
        autocorrect="off"
        spellcheck={false}
        maxLength={120}
        onInput={(e) => setText((e.target as HTMLInputElement).value)}
      />
      <Pressable class="browse-go" onPress={submit} ariaLabel="Search">
        Search
      </Pressable>
    </form>
  );
}

/* ── Playing it ───────────────────────────────────────────────────────────*/

/**
 * What to do with the thing that was tapped.
 *
 * A tap could reasonably mean "play this now" or "put it after what is
 * playing", and guessing wrong on a speaker somebody else is listening to is
 * rude. Three explicit choices, each a full-width target.
 */
function PlayOptions({
  item,
  playerId,
  playerName,
  onDone,
  onCancel,
}: {
  item: MediaItem;
  playerId: string;
  playerName: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const choose = (fn: () => void): void => {
    fn();
    onDone();
  };

  // Radio never ends and cannot meaningfully be queued behind anything.
  const queueable = item.k !== 'radio';

  return (
    <div class="sheet-layer is-nested">
      <div class="sheet-scrim" onPointerDown={onCancel} />
      <div class="sheet play-sheet" role="dialog" aria-label={item.n} aria-modal="true">
        <div class="sheet-head">
          <div class="sheet-titles">
            <h2 class="sheet-title truncate">{item.n}</h2>
            <div class="sheet-subtitle truncate">{item.s ?? KIND_LABEL[item.k]}</div>
          </div>
          <Pressable class="sheet-close p-sm" onPress={onCancel} ariaLabel="Close">
            <Icon name="close" size="1.4rem" weight={2} />
          </Pressable>
        </div>

        <div class="sheet-body">
          <Pressable
            class="play-option is-primary"
            onPress={() => choose(() => act.playItem(playerId, item.u, { enqueue: 'replace' }))}
            ariaLabel={`Play on ${playerName}`}
          >
            <Icon name="play" size="1.3rem" />
            <span>Play on {playerName}</span>
          </Pressable>

          {queueable ? (
            <>
              <Pressable
                class="play-option"
                onPress={() => choose(() => act.playItem(playerId, item.u, { enqueue: 'next' }))}
                ariaLabel="Play next"
              >
                <Icon name="next" size="1.3rem" />
                <span>Play next</span>
              </Pressable>

              <Pressable
                class="play-option"
                onPress={() => choose(() => act.playItem(playerId, item.u, { enqueue: 'add' }))}
                ariaLabel="Add to queue"
              >
                <Icon name="plus" size="1.3rem" weight={2.2} />
                <span>Add to queue</span>
              </Pressable>

              {/* Keeps going with similar music once this finishes — the
                  difference between hearing one artist and hearing an evening
                  of them. */}
              <Pressable
                class="play-option"
                onPress={() =>
                  choose(() => act.playItem(playerId, item.u, { enqueue: 'replace', radio: true }))
                }
                ariaLabel="Start a radio station"
              >
                <Icon name="radio" size="1.3rem" weight={1.8} />
                <span>Start radio from this</span>
              </Pressable>
            </>
          ) : null}

          {/* Only offered when the current state is actually known —
              otherwise the button would be a guess at which way it toggles.
              Sonos never sets it: favourites are managed in the Sonos app. */}
          {item.f !== undefined ? (
            <Pressable
              class="play-option"
              onPress={() => {
                act.setFavorite(playerId, item.u, !item.f);
                onCancel();
              }}
              ariaLabel={item.f ? 'Remove from favorites' : 'Add to favorites'}
            >
              <Icon name="heart" size="1.3rem" weight={item.f ? 2.4 : 1.8} />
              <span>{item.f ? 'Remove from favorites' : 'Add to favorites'}</span>
            </Pressable>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<MediaKind, string> = {
  artist: 'Artist',
  album: 'Album',
  track: 'Song',
  playlist: 'Playlist',
  radio: 'Radio',
  podcast: 'Podcast',
  audiobook: 'Audiobook',
};

const KIND_ICON: Record<MediaKind, string> = {
  artist: 'media',
  album: 'disc',
  track: 'media',
  playlist: 'list',
  radio: 'radio',
  podcast: 'media',
  audiobook: 'media',
};
