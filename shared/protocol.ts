/**
 * The panel <-> backend WebSocket protocol.
 *
 * Design notes:
 *
 * - The panel opens exactly ONE socket and never polls. Everything the panel
 *   needs arrives on it: config, entity state, media state, slideshow cues.
 *
 * - The first frame after connect is always `hello`, carrying a COMPLETE
 *   snapshot. The panel can therefore paint a correct screen from a cold
 *   start in one round trip, with no auth handshake and no follow-up
 *   requests. This is what makes recovery from RoomOS's daily storage wipe
 *   invisible to the user.
 *
 * - State updates reuse Home Assistant's own compressed `subscribe_entities`
 *   diff shape (added / changed / deleted). Keeping the wire format identical
 *   to HA's means the diff-application code is written and tested once and
 *   runs on both ends.
 *
 * See docs/ARCHITECTURE.md §6.
 */

import type { DashboardConfig, KeyLightOp } from './config.ts';

/* ── Entity state ──────────────────────────────────────────────────────── */

export interface EntityState {
  /** entity_id, e.g. "light.kitchen" */
  id: string;
  /** state string, e.g. "on" */
  s: string;
  /** attributes */
  a: Record<string, unknown>;
  /** last_changed, epoch ms */
  lc: number;
  /** last_updated, epoch ms */
  lu: number;
}

/** A partial update to one entity. Absent keys are unchanged. */
export interface EntityDiff {
  s?: string;
  /** attributes to set or replace */
  a?: Record<string, unknown>;
  /** attribute keys to delete */
  r?: string[];
  lc?: number;
  lu?: number;
}

export interface StatePatch {
  /** entities added (full state) */
  add?: Record<string, EntityState>;
  /** entities changed (diff only) */
  chg?: Record<string, EntityDiff>;
  /** entity ids removed */
  del?: string[];
}

/* ── Connection health ─────────────────────────────────────────────────── */

export type LinkState = 'connected' | 'connecting' | 'disconnected';

export interface BackendHealth {
  ha: LinkState;
  immich: LinkState;
  /**
   * Sonos, spoken to directly on the LAN. 'disabled' when SONOS_HOST is unset
   * and discovery is off.
   *
   * There is no socket to Sonos — control is stateless SOAP on port 1400 — so
   * 'connected' means the household answered a topology request recently.
   */
  sonos: LinkState | 'disabled';
  /**
   * Why Sonos is unhappy. A wrong address, a network that blocks discovery and
   * UPnP switched off in the Sonos app all present as an empty Media screen,
   * and they need three different things done about them.
   */
  sonosError: string | null;
  /**
   * How Sonos state is arriving.
   *
   * `live` means the speakers are pushing changes, which is what makes the
   * panel keep up with a volume knob turned anywhere else. `polling` is the
   * fallback for when those pushes cannot reach the backend — almost always
   * Docker bridge networking — and is shown rather than hidden because the
   * symptom (a panel that responds to taps but lags behind the house) is
   * otherwise impossible to attribute.
   */
  sonosUpdates: 'live' | 'polling' | 'off';
  /**
   * Why Immich is unhappy, if it is — already human-readable, and including
   * whatever Immich itself said. Null when the last request succeeded.
   *
   * This exists because an empty slideshow and an unreachable Immich look
   * identical on screen, and the panel is on a wall where nobody will think
   * to go and read the container logs.
   */
  immichError: string | null;
  /** ISO timestamp of the backend's last successful HA message. */
  haLastMessage: string | null;
  /** Backend uptime in seconds — useful for spotting container restarts. */
  uptime: number;
  version: string;
}

/* ── Photos ────────────────────────────────────────────────────────────── */

export interface PhotoRef {
  /** Immich asset id. Fetch via /img/{id}?s=preview — never the original. */
  id: string;
  /** Pixel dimensions of the ORIGINAL, used to pick contain vs cover. */
  w: number;
  h: number;
  /** ThumbHash, base64. ~25 bytes that decode to a blurred placeholder. */
  th?: string;
  /** Capture time, ISO. */
  taken?: string;
  city?: string;
  country?: string;
}

/* ── Speakers ──────────────────────────────────────────────────────────── */

/**
 * A speaker, as Sonos describes it.
 *
 * This replaces reading `media_player` entities from Home Assistant. Sonos
 * knows things that model has nowhere to put: which zone coordinates a group,
 * which speakers are following it, and whether two are bonded as one.
 *
 * Volume is 0-100, which is Sonos's own scale — converting it anywhere is how
 * a slider ends up setting a speaker to 1% of what was asked for.
 */
export interface Player {
  id: string;
  name: string;
  /** 'player' when it is one speaker, 'stereo_pair' when two are bonded. */
  type: string;
  available: boolean;
  /** 'playing' | 'paused' | 'buffering' | 'idle'. */
  state: string;
  /** Always null for Sonos, which has no power concept. */
  powered: boolean | null;
  /** 0-100, or null when the player has no volume control. */
  volume: number | null;
  muted: boolean;
  /** Everyone playing in sync with this player. Empty when ungrouped. */
  members: string[];
  /** The player this one is synced to, if it is a follower. */
  syncedTo: string | null;
  /** Speakers this one can group with — for Sonos, every other zone. */
  canGroupWith: string[];
  /** The queue driving this player — the id every queue command needs. */
  queueId: string | null;
  /** Group volume when this is a group leader, else the player's own. */
  groupVolume: number | null;
  /** What is on it right now. */
  media: NowPlaying | null;
  /**
   * Tone, −10 to +10, and loudness. Null until the speaker has said.
   *
   * Per speaker rather than per group, like volume: they describe the room the
   * speaker stands in, and two grouped speakers in different rooms want
   * different bass and the same music.
   */
  bass: number | null;
  treble: number | null;
  loudness: boolean | null;
  /**
   * When the sleep timer will stop this group, as epoch ms. Null when none.
   *
   * An instant rather than a remaining duration, so the panel can count down
   * without the backend re-sending a number every second.
   */
  sleepAt: number | null;
}

export interface NowPlaying {
  title: string | null;
  artist: string | null;
  album: string | null;
  /** Proxied artwork path on this origin. */
  art: string | null;
  duration: number | null;
  /** Seconds into the track at `elapsedAt`. */
  elapsed: number | null;
  /** Epoch ms the elapsed time was measured, so the panel can extrapolate. */
  elapsedAt: number | null;
}

/** The state of a player's queue, minus the items themselves. */
export interface PlayerQueue {
  id: string;
  name: string;
  /** How many items the queue holds. */
  count: number;
  index: number | null;
  shuffle: boolean;
  /** 'off' | 'one' | 'all'. */
  repeat: string;
}

/** One row of a queue. */
export interface QueueEntry {
  /** The queue object id, `Q:0/5` — what move and remove act on. */
  id: string;
  name: string;
  /** "Artist · Album". */
  sub: string | null;
  art: string | null;
  duration: number | null;
  /** Position in the queue, so the panel can show and jump to it. */
  index: number;
}

/* ── Music browsing ────────────────────────────────────────────────────── */

/** The kinds of thing that can appear in a browse result. */
export type MediaKind =
  | 'artist'
  | 'album'
  | 'track'
  | 'playlist'
  | 'radio'
  | 'podcast'
  | 'audiobook';

export const MEDIA_KINDS: readonly MediaKind[] = [
  'artist',
  'album',
  'track',
  'playlist',
  'radio',
  'podcast',
  'audiobook',
];

/**
 * One browsable thing.
 *
 * Short keys, and only the four fields a list row actually draws. A library
 * page is sixty of these and a DIDL entry carries a dozen fields apiece —
 * sending that raw would triple the frame for data the panel would
 * immediately discard, on a device with a hard memory ceiling.
 */
export interface MediaItem {
  /**
   * An opaque key this backend minted. The only thing needed to play it.
   *
   * NOT a URI: Sonos will fetch whatever URI it is handed, so the panel is
   * never given one. See server/src/sonos/uris.ts.
   */
  u: string;
  /** Name. */
  n: string;
  /** Kind. */
  k: MediaKind;
  /** Second line — artist, or "artist · album". */
  s?: string;
  /** Artwork path on THIS origin, already proxied. See http/media-art.ts. */
  a?: string;
  /** Favourited upstream. Absent when the state is unknown, which for Sonos
   *  is always — favourites are managed in the Sonos app, not from here. */
  f?: boolean;
  /**
   * This row can be OPENED but not played.
   *
   * True for the browse root's sources — "Favourites" and "Music Library" are
   * places, not records — and for a service row the service itself marked
   * unplayable. Without it the panel draws a play button that produces a
   * refusal, which reads as a bug rather than as a category.
   */
  o?: true;
  /**
   * The music service this row IS, on the service list only.
   *
   * Present so the panel can tell "open this" from "connect this first"
   * without matching on the subtitle text, and so it has the id the link
   * flow needs. Absent on every other kind of row, including rows from
   * inside a service.
   */
  sid?: number;
}

/**
 * A music service this household has — Sonos Radio, Plex, SoundCloud…
 *
 * The panel gets these rather than discovering them, because which services
 * exist and whether each is usable are both facts about the household and its
 * stored credentials, neither of which a wall panel should be reasoning about.
 */
export interface MusicSource {
  /** Sonos's service id — the `sid` in every URI it produces. */
  sid: number;
  name: string;
  /** Browsable right now: it needs no login, or this app is linked to it. */
  ready: boolean;
  /** The service will answer a catalog search. */
  searchable: boolean;
  /**
   * Connecting is offerable. False for a service that needs a password, which
   * cannot be typed on a shared screen and is not asked for.
   */
  linkable: boolean;
  /** Why account linking is unavailable for this service's sign-in method. */
  blocked?: string;
  /** Last failed connection attempt. Retry remains available. */
  lastError?: string;
}

/** Where a device link has got to. */
export interface ServiceLink {
  sid: number;
  /** 'prompt' — go here and enter this; 'waiting' — not confirmed yet. */
  state: 'prompt' | 'waiting' | 'linked';
  /** Where to go. Shown as text: the panel has no second tab to open. */
  url?: string;
  /** The code to type there, when the service does not display its own. */
  code?: string;
}

/**
 * What the panel is asking to see.
 *
 * `library` is the workhorse: Favorites, Recently Played and each of the
 * category tabs are all the same call with different sort and filter, which is
 * why there is one request kind rather than six.
 */
export type BrowseRequest =
  | {
      kind: 'library';
      media: MediaKind;
      /** The Favourites container, which on Sonos is a place not a filter. */
      favorite?: boolean;
      /**
       * How many items to skip — an ITEM offset, as Sonos itself uses, not a
       * page number. Page size is fixed by the backend at `BROWSE_PAGE`, so a
       * caller pages by adding that.
       */
      offset?: number;
    }
  /**
   * A text search, against one source.
   *
   * There is no "search everything": the local library is searched by object
   * id and a streaming catalog only by that service's own API. So the source
   * is named rather than guessed, which is two taps instead of one and the
   * honest shape of the system underneath.
   */
  /**
   * `source` is `'library'` for what the speakers hold, or a service's `sid`
   * for its own catalog. A number rather than a name because the panel is
   * given the services in `hello` and echoes back what it was told.
   */
  | { kind: 'search'; text: string; source?: 'library' | number }
  /**
   * A page of a music service's own tree.
   *
   * `id` is the service's id for a container, or absent for its top level.
   * These ids come from a previous page of the same service, so the panel
   * never composes one.
   */
  | { kind: 'service'; sid: number; id?: string; offset?: number }
  /**
   * Everywhere music can come from, as one list of rows to open.
   *
   * The top of the browser, and the reason there is no tab strip: which
   * sources a household HAS is a fact about that household, not something to
   * hard-code six of. A house with no NAS share has no Albums tab to offer,
   * and a house with Plex and SoundCloud should not have to find them behind
   * a tab called "Services".
   *
   * It is also how the Sonos app's own Browse screen works, and it means
   * opening Plex reuses the drill-down that opening an album already uses.
   */
  | { kind: 'sources' }
  /**
   * Every service Sonos offers, for adding one detection missed.
   *
   * Detection reads the household — its accounts, its favourites, its saved
   * stations — and a service that is set up but has none of those leaves no
   * trace to find. This is the deliberate way past that: a long list nobody
   * has to look at unless something they know they have is absent.
   */
  | { kind: 'catalog' }
  /**
   * The contents of one item — an album's tracks, an artist's albums, a
   * playlist's tracks.
   *
   * The reason browsing stopped being a flat list: tapping an album should be
   * able to mean "show me track 7", not only "play the whole thing".
   */
  | { kind: 'item'; uri: string; offset?: number }
  /** The actual rows of a player's queue. */
  | { kind: 'queue'; queueId: string; offset?: number };

/** A single flat list — a library page, or one section of search results. */
export interface BrowseList {
  kind: 'list';
  items: MediaItem[];
  offset: number;
  /** Whether another page exists. */
  more: boolean;
  /**
   * This service needs connecting before it can answer, and its `sid`.
   *
   * The difference between an explanation and a button. "Connect SoundCloud
   * first" told somebody what was wrong and gave them nowhere to do anything
   * about it; carrying the id means the empty state can offer the pairing
   * flow where they are already looking.
   */
  connect?: number;
  /**
   * Why this list is empty, when it is.
   *
   * An empty list and a broken one look identical on a wall panel, and the
   * commonest empty list here is entirely correct — a household with no NAS
   * share has no Albums, and saying so is the difference between "this works
   * and you have none" and "this is broken".
   */
  note?: string;
}

/** Search results, grouped by media type in the order they should be shown. */
export interface BrowseGroups {
  kind: 'groups';
  groups: { name: string; items: MediaItem[] }[];
}

/**
 * A page of the actual queue.
 *
 * This is the thing the Home Assistant integration could not give us: a
 * summary with a current item and a count, but never the rows, nor the
 * commands that reorder and remove them. Those exist only on the speaker's
 * own API, which is why the backend talks to it directly.
 */
export interface QueuePage {
  kind: 'queuePage';
  queueId: string;
  entries: QueueEntry[];
  offset: number;
  /** Total items, so the panel can show "12 of 340" without walking it. */
  total: number;
  /** Which index is playing, so the current row can be marked. */
  current: number | null;
}

export type BrowseResult = BrowseList | BrowseGroups | QueuePage;

/* ── Music commands ────────────────────────────────────────────────────── */

/** What to do with the queue when playing something new. */
export type Enqueue = 'play' | 'replace' | 'next' | 'replace_next' | 'add';

/**
 * Everything the panel can ask of a speaker.
 *
 * A closed set of verbs, deliberately, and the reason is a safety property
 * rather than tidiness. Sonos's local API has no authentication, and the same
 * port that pauses a track can rename rooms, rewrite alarms and write
 * music-service credentials. With an upstream command name on the wire the
 * guarantee is "the allow-list is complete" — something that can be
 * overlooked into being false. With a verb it is "no other action exists",
 * which cannot.
 *
 * `player` is always a player id, never a queue id: a Sonos queue belongs to a
 * group rather than to a speaker, and resolving that is the backend's job.
 */
export type MusicCommand =
  | { verb: 'playPause' | 'play' | 'pause' | 'stop' | 'next' | 'previous'; player: string }
  /** Seconds from the start of the current track. */
  | { verb: 'seek'; player: string; seconds: number }
  /** 0-100. Both systems use that scale; converting anywhere is a bug. */
  | { verb: 'volume'; player: string; level: number }
  | { verb: 'mute'; player: string; muted: boolean }
  /** Accepted and refused: Sonos speakers have no power concept. */
  | { verb: 'power'; player: string; on: boolean }
  | { verb: 'shuffle'; player: string; on: boolean }
  | { verb: 'repeat'; player: string; mode: string }
  /** Set the group led by `player` to exactly these members. Absolute. */
  | { verb: 'group'; player: string; members: string[] }
  | { verb: 'ungroup'; player: string }
  | { verb: 'playItem'; player: string; item: string; enqueue: Enqueue; radio?: boolean }
  | { verb: 'queueJump'; player: string; index: number }
  /** `by` is a position shift, not an index. */
  | { verb: 'queueMove'; player: string; item: string; by: number }
  | { verb: 'queueRemove'; player: string; item: string }
  | { verb: 'queueClear'; player: string }
  | { verb: 'favorite'; player: string; item: string; on: boolean }
  /**
   * Volume for the whole group at once, 0-100.
   *
   * Sonos scales every member proportionally and keeps their relative balance,
   * which is what makes it different from setting each speaker in turn — that
   * would flatten a deliberately quiet speaker up to match the others.
   */
  | { verb: 'groupVolume'; player: string; level: number }
  /** Tone, −10 to +10. Per speaker, like volume. */
  | { verb: 'bass' | 'treble'; player: string; level: number }
  | { verb: 'loudness'; player: string; on: boolean }
  /** Blend the end of one track into the next. Per group. */
  | { verb: 'crossfade'; player: string; on: boolean }
  /**
   * Stop this group after `minutes`. Zero cancels a running timer.
   *
   * Sonos holds the timer itself, so it survives this backend restarting —
   * which is the whole reason not to implement it with a `setTimeout` here.
   */
  | { verb: 'sleep'; player: string; minutes: number }
  /**
   * Play a physical input instead of the queue.
   *
   * `tv` is a soundbar's optical or HDMI-ARC input and `line` an analogue one;
   * `queue` puts a speaker back on its own queue, which is how you leave.
   * A speaker without the named input refuses, and that refusal is the answer
   * rather than something to pre-empt with a capability table.
   */
  | { verb: 'input'; player: string; source: 'tv' | 'line' | 'queue' };

/**
 * Every verb, for the runtime check the type system cannot do.
 *
 * A panel is a device on a wall that anyone can touch, and the socket carries
 * JSON — so "the union is exhaustive" is a compile-time fact about our code,
 * not about what arrives. Checking membership here is what makes an
 * unrecognised verb a refusal rather than a silent no-op, and it is the
 * property the test suite asserts in place of the old allow-list of upstream
 * command names.
 */
export const MUSIC_VERBS: readonly string[] = [
  'playPause',
  'play',
  'pause',
  'stop',
  'next',
  'previous',
  'seek',
  'volume',
  'mute',
  'power',
  'shuffle',
  'repeat',
  'group',
  'ungroup',
  'playItem',
  'queueJump',
  'queueMove',
  'queueRemove',
  'queueClear',
  'favorite',
  'groupVolume',
  'bass',
  'treble',
  'loudness',
  'crossfade',
  'sleep',
  'input',
];

/** How many items one library page holds. Fixed here so a panel cannot ask
 *  for five hundred rows and then be killed for the memory it took. */
export const BROWSE_PAGE = 60;
/** Per-type cap on search results. */
export const SEARCH_LIMIT = 12;

/* ── Server → panel ────────────────────────────────────────────────────── */

/* ── Elgato Key Lights ─────────────────────────────────────────────────── */

/**
 * One Key Light, as the panel sees it.
 *
 * Normalised away from Elgato's wire format on the backend: `on` is a
 * boolean rather than 0/1, and `temperature` is KELVIN rather than the mired
 * value the light actually speaks. The panel should never have to know that
 * 213 means 4700 K, and the conversion has exactly one home.
 */
/**
 * What a television in `controls.tvs` is doing, as far as the backend knows.
 *
 * `input` is the socket it is showing — HDMI_2 — or null when it is off, or
 * showing an app rather than an input. Null is a real answer and is drawn as
 * one: a key that keeps the last label would be confidently wrong exactly
 * when somebody has changed the input with the TV's own remote.
 */
export interface TvState {
  id: string;
  input: string | null;
  /**
   * True when the television itself said so, false when this is only the
   * input the panel last selected.
   *
   * The distinction is shown rather than smoothed over: a set that never
   * reports its foreground app leaves the panel with nothing but its own
   * last instruction, which somebody holding the remote can have made wrong.
   */
  confirmed: boolean;
}

export interface KeyLightState {
  id: string;
  name: string;
  /** False when the light did not answer. Its last known values are kept. */
  reachable: boolean;
  on: boolean;
  /** 0–100, the light's own scale. */
  brightness: number;
  /** Kelvin, 2900–7000. */
  temperature: number;
}

/** The range every Elgato Key Light supports, in Kelvin. */
export const KEY_LIGHT_MIN_KELVIN = 2900;
export const KEY_LIGHT_MAX_KELVIN = 7000;

export type ServerMessage =
  /** Always first. Complete snapshot; the panel can render immediately. */
  | {
      t: 'hello';
      config: DashboardConfig;
      states: Record<string, EntityState>;
      health: BackendHealth;
      /** Server time, so the panel's clock is right even if the device's isn't. */
      now: number;
      prefs: PanelPrefs;
      /** Every Sonos speaker, if a household was found. */
      players: Player[];
      /** Queue state for each of those players, keyed by queue id. */
      queues: PlayerQueue[];
      /** Every Elgato Key Light named in `controls.keylights`. */
      keylights: KeyLightState[];
      tvs: TvState[];
      /** Music services this household has. Empty until they are discovered. */
      sources: MusicSource[];
    }
  /** Incremental entity state. */
  | { t: 'patch'; patch: StatePatch }
  /**
   * Speaker state changed.
   *
   * Sent whole rather than as a diff. A house has tens of speakers, not the
   * hundreds of entities that made diffing Home Assistant worth the
   * complexity, and a player carries its now-playing metadata — which changes
   * as a unit anyway when the track does.
   */
  | { t: 'players'; players: Player[]; queues: PlayerQueue[] }
  /**
   * Elgato Key Light state changed.
   *
   * Sent whole, like `players`: there are two or three of these and each one
   * is four fields. A diff would be larger than the thing it describes.
   */
  | { t: 'keylights'; lights: KeyLightState[] }
  /**
   * The music services changed — discovered, connected, or disconnected.
   *
   * Sent whole for the same reason as `players`: a household has a handful of
   * services and each is five short fields.
   */
  | { t: 'sources'; sources: MusicSource[] }
  /** Where a device link has got to, in answer to a `link` request. */
  | { t: 'link'; ref: number; link: ServiceLink }
  | { t: 'tvs'; tvs: TvState[] }
  /** Config file changed on disk and revalidated. */
  | { t: 'config'; config: DashboardConfig }
  /** Backend link health changed. */
  | { t: 'health'; health: BackendHealth }
  /** A preference changed — on this panel or another one. */
  | { t: 'prefs'; prefs: PanelPrefs }
  /** A batch of photos for the slideshow to preload. */
  | { t: 'photos'; photos: PhotoRef[] }
  /** Answer to a `browse` request. `ref` matches the request's id. */
  | { t: 'browse'; ref: number; result: BrowseResult }
  /** A command the panel sent failed. `ref` matches the command's id. */
  | { t: 'error'; ref?: number; code: string; message: string }
  /** Heartbeat response. */
  | { t: 'pong'; ref: number };

/* ── Panel → server ────────────────────────────────────────────────────── */

export type ClientMessage =
  /**
   * Call a Home Assistant service. The backend validates `target` against the
   * config allow-list before forwarding — the panel cannot reach an entity
   * that dashboard.yaml never named.
   */
  | {
      t: 'call';
      id: number;
      domain: string;
      service: string;
      entity: string;
      data?: Record<string, unknown>;
    }
  /**
   * Drive a speaker.
   *
   * Fire-and-forget, like `call`: the authoritative result arrives moments
   * later as a `players` push. Every id is validated against what Sonos
   * actually told the backend about, for the same reason the Home Assistant
   * path does. See `MusicCommand` for why this carries a verb rather than an
   * upstream command name.
   */
  | { t: 'music'; id: number; cmd: MusicCommand }
  /** Ask for the next N slideshow photos. */
  | { t: 'photos'; id: number; count: number }
  /**
   * Ask for something to look at.
   *
   * The only request/reply pair besides photos. Everything else in this
   * protocol is either a push or fire-and-forget, because a wall panel that
   * waits on a round trip feels broken — but "list my albums" has no answer
   * until the answer arrives, so this one waits, with a spinner.
   */
  | { t: 'browse'; id: number; req: BrowseRequest }
  /**
   * Connect or disconnect a music service.
   *
   * `begin` asks the service for a link code, `poll` asks whether the person
   * has confirmed it yet, `forget` throws the token away. Polling rather than
   * pushing because the confirmation happens on somebody's phone, out of
   * sight of anything this backend is connected to.
   */
  | { t: 'link'; id: number; sid: number; op: 'begin' | 'poll' | 'forget' }
  /**
   * Run a macro button from `controls.pages`.
   *
   * Carries the button's ID and nothing else — no URL, no Companion
   * coordinates, no webhook name. The backend looks the button up in the
   * config it already holds and performs whatever that says, so the set of
   * requests a panel can cause is exactly the set written in dashboard.yaml.
   * See shared/config.ts for why that is not merely tidier.
   */
  | { t: 'control'; id: number; button: string }
  /**
   * Drive an Elgato Key Light.
   *
   * Separate from `control` because a light is a control rather than a
   * button: it carries a value and it has state to come back. `light` is
   * checked against `controls.keylights` — `all` addresses every one.
   */
  | { t: 'keylight'; id: number; light: string; op: KeyLightOp; value?: number }
  /**
   * Choose an input on a `sources:` control key.
   *
   * Names the CONTROL ITEM, not the entity or the service — the same rule as
   * `control` above, for the same reason. The backend resolves the item in
   * dashboard.yaml, so a panel cannot aim select_source at a media player
   * that no page put there.
   */
  | { t: 'source'; id: number; item: string; value: string }
  /** Heartbeat. Detects half-open sockets that TCP will not report. */
  | { t: 'ping'; id: number }
  /**
   * Change a panel preference.
   *
   * The backend validates the key and value against a fixed allow-list and
   * persists them, then broadcasts the result to every panel. Preferences
   * cannot live in the browser: RoomOS deletes web storage daily by default
   * (docs/ROOMOS.md §3), so a setting chosen at the panel would silently
   * revert overnight.
   */
  | { t: 'pref'; id: number; key: 'homeSide'; value: string }
  /**
   * Rearrange the player list.
   *
   * Carries the COMPLETE layout rather than a move instruction. It is
   * idempotent, it needs no server-side merge, and two panels rearranging at
   * once cannot interleave into a state neither of them asked for — the last
   * one simply wins, which is the right outcome for a display preference.
   */
  | { t: 'layout'; id: number; layout: PlayerLayout };

/* ── Panel preferences ─────────────────────────────────────────────────── */

/**
 * Settings chosen at the panel rather than in `dashboard.yaml`.
 *
 * Deliberately tiny. Anything that needs typing belongs in the YAML, where a
 * real keyboard exists — the RoomOS soft keyboard has no numeric, date or
 * colour modes (docs/ROOMOS.md §6). These are things you pick by tapping.
 */
export interface PanelPrefs {
  /**
   * What fills the panel beside Favorites on the Home screen.
   *
   * `media` falls back to the photo when nothing is playing, so the space is
   * never empty — which is the entire reason it exists.
   */
  homeSide: 'media' | 'photos';
  /** How the player list is arranged. See `PlayerLayout`. */
  players: PlayerLayout;
}

/**
 * Which speakers sit under which heading, and in what order.
 *
 * Section NAMES come from `media.sections` in dashboard.yaml, because naming
 * needs a keyboard. Which speaker goes where is decided by tapping, so it
 * lives here — a machine-owned file the panel may rewrite, never the user's
 * hand-written YAML.
 *
 * Sparse on purpose: a speaker that appears in neither map falls into the
 * first section automatically. Discovering a new speaker therefore needs no
 * write at all, and an empty layout is a perfectly good starting state.
 */
export interface PlayerLayout {
  /** section name → entity ids, in display order. */
  sections: Record<string, string[]>;
  /** Speakers deliberately kept off the list — laptops, servers, phones. */
  hidden: string[];
}

export const DEFAULT_PREFS: PanelPrefs = {
  homeSide: 'media',
  players: { sections: {}, hidden: [] },
};

/** Caps, so a compromised panel cannot write unbounded data to disk. */
export const LAYOUT_LIMITS = { sections: 12, playersPerSection: 100, hidden: 200 } as const;

/**
 * Allowed values for the simple string preferences.
 *
 * `players` is not here: it is structured rather than an enum, and is
 * validated separately by the prefs store against the sections the config
 * actually declares.
 */
export const PREF_VALUES: Record<string, readonly string[]> = {
  homeSide: ['media', 'photos'],
};

/** Application-level heartbeat interval. A Wi-Fi roam can leave a socket
 *  half-open for minutes before TCP notices; this catches it in seconds. */
export const HEARTBEAT_MS = 25_000;
/** Miss this many heartbeats and we tear the socket down and reconnect. */
export const HEARTBEAT_TIMEOUT_MS = 12_000;

