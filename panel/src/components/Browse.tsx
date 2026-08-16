import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { browse } from '~/net/socket.ts';
import { getToken } from '~/net/auth.ts';
import { friendlyName } from '~/domains/registry.ts';
import { entity } from '~/state/entities.ts';
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
 * Everything here comes from Music Assistant's own services — this app keeps
 * no library, no cache of album names and no search index of its own. Which
 * means whatever you added to Music Assistant this morning is here, and the
 * panel never disagrees with the Music Assistant app about what exists.
 *
 * ## Why tabs rather than a folder tree
 *
 * Home Assistant's media browser is a hierarchy you walk down: source, then
 * category, then letter, then album. That is fine with a mouse. On a wall
 * panel it is four taps and a soft keyboard before you hear anything, and
 * every one of those taps is a round trip.
 *
 * These are seven flat views over the same library call, with the two you
 * actually use — what you played recently, and what you marked as a favorite —
 * first and needing no typing at all.
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
    id: 'recent',
    label: 'Recent',
    icon: 'clock',
    // Music Assistant has no history service; a library sorted by last played
    // is the same thing and needs no state of our own.
    request: { kind: 'library', media: 'track', recent: true },
  },
  {
    id: 'favorites',
    label: 'Favorites',
    icon: 'heart',
    request: { kind: 'library', media: 'album', favorite: true },
  },
  { id: 'albums', label: 'Albums', icon: 'disc', request: { kind: 'library', media: 'album' } },
  { id: 'artists', label: 'Artists', icon: 'media', request: { kind: 'library', media: 'artist' } },
  {
    id: 'playlists',
    label: 'Playlists',
    icon: 'list',
    request: { kind: 'library', media: 'playlist' },
  },
  { id: 'radio', label: 'Radio', icon: 'radio', request: { kind: 'library', media: 'radio' } },
  { id: 'search', label: 'Search', icon: 'search', request: { kind: 'search', text: '' } },
];

export function Browse({ playerId, onClose }: { playerId: string; onClose: () => void }) {
  const [tab, setTab] = useState('recent');
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [chosen, setChosen] = useState<MediaItem | null>(null);

  const current = TABS.find((t) => t.id === tab) ?? (TABS[0] as Tab);
  const playerName = friendlyName(entity(playerId).value, playerId);

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

    const req: BrowseRequest =
      current.request.kind === 'search'
        ? { kind: 'search', text: query }
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
  }, [tab, offset, query]);

  const pick = (t: string): void => {
    setTab(t);
    setOffset(0);
  };

  return (
    <div class="sheet-layer">
      <div class="sheet-scrim" onPointerDown={onClose} />

      <div class="sheet browse-sheet" role="dialog" aria-label="Browse music" aria-modal="true">
        <div class="sheet-head">
          <div class="sheet-titles">
            <h2 class="sheet-title truncate">Browse</h2>
            <div class="sheet-subtitle truncate">Play on {playerName}</div>
          </div>
          <Pressable class="sheet-close p-sm" onPress={onClose} ariaLabel="Close">
            <Icon name="close" size="1.4rem" weight={2} />
          </Pressable>
        </div>

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

        {tab === 'search' ? <SearchBox value={query} onSearch={setQuery} /> : null}

        <div class="sheet-body scroll browse-body">
          <Results
            loading={loading}
            error={error}
            result={result}
            searching={tab === 'search'}
            query={query}
            onPick={setChosen}
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
            {/* `offset` counts ITEMS, as Music Assistant does. The page number
                is a display detail derived from it, not the thing being sent. */}
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
}: {
  loading: boolean;
  error: string | null;
  result: BrowseResult | null;
  searching: boolean;
  query: string;
  onPick: (item: MediaItem) => void;
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
          Browsing needs the Music Assistant integration in Home Assistant. Speakers and
          playback work without it.
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
              <ItemRow key={item.u} item={item} onPick={onPick} />
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
            Music Assistant has no items of this kind in its library.
          </p>
        </div>
      );
    }
    return (
      <>
        {result.items.map((item) => (
          <ItemRow key={item.u} item={item} onPick={onPick} />
        ))}
      </>
    );
  }

  return null;
}

function ItemRow({ item, onPick }: { item: MediaItem; onPick: (item: MediaItem) => void }) {
  return (
    <Pressable
      as="div"
      class="browse-row"
      onPress={() => onPick(item)}
      ariaLabel={item.n}
      disabled={item.u === ''}
    >
      <Cover item={item} />
      <div class="browse-meta">
        <div class="browse-name truncate">{item.n}</div>
        <div class="browse-sub truncate">{item.s ?? KIND_LABEL[item.k]}</div>
      </div>
      <Icon name="chevronRight" size="1.1rem" weight={2} />
    </Pressable>
  );
}

/**
 * Cover art, or a glyph when there is none.
 *
 * `loading="lazy"` matters more here than anywhere else in the app: a page is
 * sixty covers, and decoding sixty images at once on this hardware is a visible
 * stall on a screen the user is trying to scroll.
 */
function Cover({ item }: { item: MediaItem }) {
  const [failed, setFailed] = useState(false);
  const token = getToken();

  if (!item.a || failed) {
    return (
      <div class="browse-cover is-empty">
        <Icon name={KIND_ICON[item.k]} size="1.3rem" weight={1.6} />
      </div>
    );
  }

  const src = `${item.a}${token ? `&t=${encodeURIComponent(token)}` : ''}`;

  return (
    <div class="browse-cover">
      <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
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
 * fire a request per letter through Home Assistant to Music Assistant to
 * whichever streaming provider is behind it, and the answers would arrive out
 * of order on a link this app cannot assume is fast.
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

              {/* Music Assistant keeps going with similar music once this
                  finishes — the difference between hearing one artist and
                  hearing an evening of them. */}
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
