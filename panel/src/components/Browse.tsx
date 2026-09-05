import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { browse, link } from '~/net/socket.ts';
import { Artwork } from '~/components/Artwork.tsx';
import { speakers } from '~/state/selectors.ts';
import { sources } from '~/state/players.ts';
import * as act from '~/state/actions.ts';
import { BROWSE_PAGE } from '@shared/protocol.ts';
import type {
  BrowseRequest,
  BrowseResult,
  MediaItem,
  MediaKind,
  MusicSource,
  ServiceLink,
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
type TabRequest = Extract<
  BrowseRequest,
  { kind: 'library' } | { kind: 'search' } | { kind: 'sources' }
>;

interface Tab {
  id: string;
  label: string;
  icon: string;
  request: TabRequest;
}

const TABS: Tab[] = [
  {
    /*
     * ONE browse tab, opening on the household's own list of sources.
     *
     * There used to be six — Favorites, Playlists, Albums, Artists, Radio,
     * Services — and five of them were empty in a house with no NAS share and
     * nothing saved in the Sonos app. A fixed tab strip asserts what a
     * household has; this asks. What comes back is Favourites, then each music
     * service, then the library and saved stations if they exist at all, each
     * with a count, in one list you can read.
     */
    id: 'browse',
    label: 'Browse',
    icon: 'list',
    request: { kind: 'sources' },
  },
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
function searchSources(): { id: 'library' | number; label: string; ready: boolean }[] {
  return [
    { id: 'library' as const, label: 'Library', ready: true },
    /*
     * EVERY searchable service, connected or not.
     *
     * Hiding the unconnected ones left a household that has five services in
     * the Sonos app looking at a lone "Library" chip, with nothing on the
     * screen to suggest the others could be searched at all. A chip that
     * offers to connect is a path; an absent chip is a dead end.
     */
    ...sources.value
      .filter((s) => s.searchable)
      .map((s) => ({ id: s.sid, label: s.name, ready: s.ready })),
  ];
}

/** One level of the drill-down: what we opened, and what it was called. */
interface Crumb {
  uri: string;
  name: string;
  /** False for a place rather than a record — no "Play all" for Favourites. */
  playable: boolean;
  /**
   * The music service this level lives inside, if any.
   *
   * Inherited down the stack: anything opened from inside Plex is inside
   * Plex. It is what puts a search box on a service's page — the Sonos app
   * scopes search to the service you are looking at, and so does this.
   */
  sid?: number;
}

/** What to call a service in its own search box. */
function serviceName(sid: number): string {
  return sources.value.find((s) => s.sid === sid)?.name ?? 'this service';
}

/** A search chip's classes: selected, or offering to connect. */
function chipClass(id: 'library' | number, source: 'library' | number, ready: boolean): string {
  if (!ready) return 'browse-source is-offer';
  return id === source ? 'browse-source is-active' : 'browse-source';
}

export function Browse({ playerId, onClose }: { playerId: string; onClose: () => void }) {
  const [tab, setTab] = useState('browse');
  /*
   * Default to a service when one is connected, not to the library.
   *
   * Most households here have no NAS share, so the library is empty and
   * defaulting to it makes the first search anybody tries return nothing —
   * which reads as "search is broken" rather than "you searched an empty
   * shelf". `searchSources` puts the library first and services after it.
   */
  const [source, setSource] = useState<'library' | number>(
    () => sources.value.find((s) => s.ready && s.searchable)?.sid ?? 'library',
  );
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [chosen, setChosen] = useState<MediaItem | null>(null);
  /** The service being connected, if somebody is part-way through that. */
  const [linking, setLinking] = useState<MusicSource | null>(null);
  /** What has been typed into a service page's own search box. */
  const [insideQuery, setInsideQuery] = useState('');
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

    /*
     * Inside a service, its own search box wins over its browse tree.
     *
     * This is the shape the Sonos app uses and the reason a service page is
     * worth having at all: "search YouTube Music" belongs on the YouTube Music
     * page, next to its categories, not behind a chip on a separate screen.
     */
    const insideService = here?.sid !== undefined && insideQuery.trim().length > 0;

    const req: BrowseRequest = insideService
      ? { kind: 'search', text: insideQuery, source: here?.sid as number }
      : here
      ? { kind: 'item', uri: here.uri, offset }
      : current.request.kind === 'search'
        ? { kind: 'search', text: query, source }
        : current.request.kind === 'sources'
          ? // The service list is short by construction and does not page.
            { kind: 'sources' }
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
  }, [tab, offset, query, source, insideQuery, here?.uri]);

  const pick = (t: string): void => {
    setTab(t);
    setOffset(0);
    setPath([]);
    setInsideQuery('');
  };

  /**
   * Offer to connect a service, from wherever it was asked for.
   *
   * A search chip for a service nobody has linked yet is the commonest place
   * to discover that connecting is a thing — more so than the Browse list,
   * because searching is what somebody was already trying to do.
   */
  const connect = (sid: 'library' | number): void => {
    const service = typeof sid === 'number' ? sources.value.find((s) => s.sid === sid) : null;
    if (!service) return;
    if (service.linkable) setLinking(service);
    else setError(`${service.name} cannot be connected from here`);
  };

  /** Open an item's contents — an album's tracks, an artist's albums. */
  const open = (item: MediaItem): void => {
    /*
     * A music service that has not been connected yet opens the pairing
     * prompt rather than a folder. Browsing it would only produce "connect
     * Plex first", which is true and is not something you can act on from a
     * list of albums that failed to load.
     */
    const source = item.sid === undefined ? null : sources.value.find((s) => s.sid === item.sid);
    if (source && !source.ready) {
      setLinking(source.linkable ? source : null);
      if (!source.linkable) setError(`${source.name} cannot be connected from here`);
      return;
    }

    const inherited = item.sid ?? here?.sid;
    setPath((p) => [
      ...p,
      {
        uri: item.u,
        name: item.n,
        playable: item.o !== true,
        // The row names a service when it IS one; otherwise inherit, because
        // anything opened from inside a service is still inside it.
        ...(inherited === undefined ? {} : { sid: inherited }),
      },
    ]);
    setInsideQuery('');
    setOffset(0);
  };

  const back = (): void => {
    setPath((p) => p.slice(0, -1));
    setInsideQuery('');
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
          {here?.playable ? (
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
              {searchSources().map((s) => (
                <Pressable
                  key={s.id}
                  class={chipClass(s.id, source, s.ready)}
                  // An unconnected service asks to be connected rather than
                  // running a search that can only fail.
                  onPress={() => (s.ready ? setSource(s.id) : connect(s.id))}
                  ariaPressed={s.id === source}
                  ariaLabel={s.ready ? `Search ${s.label}` : `Connect ${s.label}`}
                >
                  {s.label}
                  {s.ready ? null : <Icon name="plus" size="0.9rem" weight={2.4} />}
                </Pressable>
              ))}
            </div>
            <SearchBox value={query} onSearch={setQuery} />
          </>
        ) : null}

        {/*
          A service's own page carries its own search box, scoped to it.
          That is the Sonos app's shape: "Search YouTube Music" sits above
          YouTube Music's own categories, so finding something in a service
          and browsing it are the same screen rather than two.
        */}
        {here?.sid !== undefined ? (
          <SearchBox
            value={insideQuery}
            onSearch={setInsideQuery}
            placeholder={`Search ${serviceName(here.sid)}`}
          />
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
            onConnect={connect}
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

      {linking ? <ConnectService source={linking} onDone={() => setLinking(null)} /> : null}
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
  onConnect,
}: {
  loading: boolean;
  error: string | null;
  result: BrowseResult | null;
  searching: boolean;
  query: string;
  onPick: (item: MediaItem) => void;
  onOpen: (item: MediaItem) => void;
  onConnect: (sid: number) => void;
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
      /*
       * The backend says WHY. An empty list and a broken one look identical on
       * a wall panel, and the commonest empty list here is entirely correct —
       * a household with no NAS share has no albums — so the difference has to
       * be stated rather than left to be guessed at.
       */
      /*
       * A service that needs connecting gets a BUTTON, not a sentence. Telling
       * somebody "connect SoundCloud first" on a screen with nothing to press
       * is the whole complaint this answers.
       */
      const needs = result.connect;
      return (
        <div class="browse-state">
          <Icon name={needs !== undefined ? 'speaker' : searching ? 'search' : 'disc'} size="2rem" weight={1.6} />
          <p class="browse-state-title">
            {needs !== undefined
              ? 'Not connected yet'
              : searching && query.trim().length > 0
                ? 'Nothing found'
                : 'Nothing here yet'}
          </p>
          {result.note ? <p class="browse-state-hint">{result.note}</p> : null}
          {needs !== undefined ? (
            <Pressable class="play-option is-primary" onPress={() => onConnect(needs)} ariaLabel="Connect">
              <Icon name="plus" size="1.2rem" weight={2.2} />
              <span>Connect</span>
            </Pressable>
          ) : null}
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
  // `o` says the row is a place rather than a record — a source, a category.
  const openOnly = item.o === true;
  const expandable = openOnly || (EXPANDABLE.has(item.k) && item.u !== '');

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

      {openOnly ? null : (
        <Pressable
          class="browse-play p-sm"
          onPress={() => onPick(item)}
          ariaLabel={`Play ${item.n}`}
          disabled={item.u === ''}
        >
          <Icon name="play" size="1.1rem" />
        </Pressable>
      )}
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
function SearchBox({
  value,
  onSearch,
  placeholder = 'Artist, album or song',
}: {
  value: string;
  onSearch: (text: string) => void;
  placeholder?: string;
}) {
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
        placeholder={placeholder}
        aria-label={placeholder}
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

/* ── Connecting a service ─────────────────────────────────────────────────*/

/**
 * Pair this app with a music service.
 *
 * **There is no redirect**, and that is the point rather than a limitation.
 * RoomOS gives the panel one tab, so `window.open` replaces the page it was
 * called from — an OAuth round trip would navigate away from the dashboard and
 * never come back. Sonos's own device-link flow happens to be exactly right
 * for that: a URL and a short code, typed on whatever phone is in the room,
 * while the panel waits.
 *
 * The waiting is polled rather than pushed, because the confirmation happens
 * somewhere this backend has no connection to.
 */
function ConnectService({ source, onDone }: { source: MusicSource; onDone: () => void }) {
  const [prompt, setPrompt] = useState<ServiceLink | null>(null);
  const [state, setState] = useState<'starting' | 'waiting' | 'linked' | 'failed'>('starting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;

    link(source.sid, 'begin')
      .then((r) => {
        if (stale) return;
        setPrompt(r);
        setState('waiting');
      })
      .catch((err: unknown) => {
        if (stale) return;
        setError(err instanceof Error ? err.message : 'Could not start');
        setState('failed');
      });

    return () => {
      stale = true;
    };
  }, [source.sid]);

  /*
   * Poll while the sheet is open.
   *
   * Every three seconds, and only while waiting. A service is entitled to
   * take as long as somebody takes to find their phone, so this is paced for
   * a person rather than for a machine.
   */
  useEffect(() => {
    if (state !== 'waiting') return;
    let stale = false;

    const timer = setInterval(() => {
      link(source.sid, 'poll')
        .then((r) => {
          if (stale || r.state !== 'linked') return;
          setState('linked');
        })
        .catch((err: unknown) => {
          if (stale) return;
          setError(err instanceof Error ? err.message : 'That did not work');
          setState('failed');
        });
    }, 3000);

    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [state, source.sid]);

  return (
    <div class="sheet-layer is-nested">
      <div class="sheet-scrim" onPointerDown={onDone} />
      <div class="sheet play-sheet" role="dialog" aria-label={`Connect ${source.name}`} aria-modal="true">
        <div class="sheet-head">
          <div class="sheet-titles">
            <h2 class="sheet-title truncate">Connect {source.name}</h2>
            <div class="sheet-subtitle truncate">
              {state === 'linked' ? 'Connected' : 'On your phone or computer'}
            </div>
          </div>
          <Pressable class="sheet-close p-sm" onPress={onDone} ariaLabel="Close">
            <Icon name="close" size="1.4rem" weight={2} />
          </Pressable>
        </div>

        <div class="sheet-body link-body">
          {state === 'starting' ? <p class="link-step">Asking {source.name}…</p> : null}

          {state === 'failed' ? <p class="link-error">{error}</p> : null}

          {state === 'linked' ? (
            <p class="link-step">
              {source.name} is connected. It is now in Services and in Search.
            </p>
          ) : null}

          {state === 'waiting' && prompt ? (
            <>
              <p class="link-step">Go to</p>
              {/* Selectable text, not a link: there is nowhere for it to open. */}
              <p class="link-url">{prompt.url}</p>
              {prompt.code ? (
                <>
                  <p class="link-step">and enter</p>
                  <p class="link-code">{prompt.code}</p>
                </>
              ) : null}
              <p class="link-hint">This screen will notice when you are done.</p>
            </>
          ) : null}
        </div>

        {state === 'linked' || state === 'failed' ? (
          <Pressable class="play-option is-primary" onPress={onDone} ariaLabel="Done">
            <span>Done</span>
          </Pressable>
        ) : null}
      </div>
    </div>
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
