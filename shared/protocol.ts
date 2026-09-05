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
  /** Music Assistant, spoken to directly. 'disabled' when MASS_URL is unset. */
  mass: LinkState | 'disabled';
  /**
   * Why Music Assistant is unhappy — most usefully, a missing or rejected
   * token, which is otherwise indistinguishable from the server being down.
   */
  massError: string | null;
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

/* ── Music Assistant players ───────────────────────────────────────────── */

/**
 * A speaker, as Music Assistant describes it.
 *
 * This replaces reading `media_player` entities from Home Assistant. Music
 * Assistant knows things Home Assistant's media_player model has nowhere to
 * put: which players a given speaker is *able* to group with, whether it is a
 * dedicated group or a synced child, and which queue is driving it.
 *
 * Volume is 0-100 here, not 0-1 — that is Music Assistant's own scale, and
 * converting twice is how off-by-a-factor-of-100 bugs happen.
 */
export interface MassPlayer {
  id: string;
  name: string;
  /** 'player' | 'stereo_pair' | 'group' — MA's own PlayerType. */
  type: string;
  available: boolean;
  /** 'playing' | 'paused' | 'idle' | 'playing'… MA's PlaybackState. */
  state: string;
  powered: boolean | null;
  /** 0-100, or null when the player has no volume control. */
  volume: number | null;
  muted: boolean;
  /** Everyone playing in sync with this player. Empty when ungrouped. */
  members: string[];
  /** The player this one is synced to, if it is a follower. */
  syncedTo: string | null;
  /** Players this one is ABLE to group with. Empty means grouping is off. */
  canGroupWith: string[];
  /** The queue driving this player — the id every queue command needs. */
  queueId: string | null;
  /** Group volume when this is a group leader, else the player's own. */
  groupVolume: number | null;
  /** What is on it right now. */
  media: MassMedia | null;
}

export interface MassMedia {
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
export interface MassQueue {
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
  /** MA's queue_item_id — what move and remove act on. */
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

/** The media types Music Assistant's library and search understand. */
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
 * page is sixty of these and Music Assistant's own item shape carries a dozen
 * fields per entry — sending that raw would triple the frame for data the
 * panel would immediately discard, on a device with a hard memory ceiling.
 */
export interface MediaItem {
  /** Music Assistant URI. The only thing needed to play it. */
  u: string;
  /** Name. */
  n: string;
  /** Kind. */
  k: MediaKind;
  /** Second line — artist, or "artist · album". */
  s?: string;
  /** Artwork path on THIS origin, already proxied. See http/media-art.ts. */
  a?: string;
  /** Favourited in Music Assistant. Absent when the item cannot be one. */
  f?: boolean;
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
      /** Only items marked favourite in Music Assistant. */
      favorite?: boolean;
      /** Sort by last played rather than by name. */
      recent?: boolean;
      /**
       * How many items to skip — an ITEM offset, as Music Assistant itself
       * uses, not a page number. Page size is fixed by the backend at
       * `BROWSE_PAGE`, so a caller pages by adding that.
       */
      offset?: number;
    }
  | { kind: 'search'; text: string }
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
}

/** Search results, grouped by media type in the order they should be shown. */
export interface BrowseGroups {
  kind: 'groups';
  groups: { name: string; items: MediaItem[] }[];
}

/**
 * A page of the actual queue.
 *
 * This is the thing the Home Assistant integration could not give us:
 * `music_assistant.get_queue` returns a summary — current item, next item, a
 * count. The rows, and the commands that reorder and remove them, exist only
 * on Music Assistant's own API, which is why the panel talks to it directly.
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
 * A closed set of verbs, deliberately, and it replaced a message that carried
 * a Music Assistant command name straight through. Two things came of that:
 *
 * **The panel stopped knowing which music system it is talking to.** It names
 * a player and an intention; the backend routes to Sonos or to Music Assistant
 * depending on which one owns that id. That is what lets both run at once
 * during the migration in `docs/SONOS.md`, and what makes phase 6 a deletion
 * rather than a rewrite.
 *
 * **The guard got stronger.** Sonos's local API has no authentication, and the
 * same port that pauses a track can rename rooms and rewrite alarms. With a
 * command name on the wire the safety property is "the allow-list is
 * complete"; with a verb it is "no other action exists", which is not a
 * property that can be overlooked into being false.
 *
 * `player` is always a player id, never a queue id — resolving a queue is the
 * backend's job, and the two systems disagree about what a queue even is.
 */
export type MusicCommand =
  | { verb: 'playPause' | 'play' | 'pause' | 'stop' | 'next' | 'previous'; player: string }
  /** Seconds from the start of the current track. */
  | { verb: 'seek'; player: string; seconds: number }
  /** 0-100. Both systems use that scale; converting anywhere is a bug. */
  | { verb: 'volume'; player: string; level: number }
  | { verb: 'mute'; player: string; muted: boolean }
  /** Music Assistant only. Sonos speakers have no power concept. */
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
  | { verb: 'favorite'; player: string; item: string; on: boolean };

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
      /** Every Music Assistant speaker, if MA is configured. */
      players: MassPlayer[];
      /** Queue state for each of those players, keyed by queue id. */
      queues: MassQueue[];
      /** Every Elgato Key Light named in `controls.keylights`. */
      keylights: KeyLightState[];
      tvs: TvState[];
    }
  /** Incremental entity state. */
  | { t: 'patch'; patch: StatePatch }
  /**
   * Music Assistant state changed.
   *
   * Sent whole rather than as a diff. A house has tens of speakers, not the
   * hundreds of entities that made diffing Home Assistant worth the
   * complexity, and a player carries its now-playing metadata — which changes
   * as a unit anyway when the track does.
   */
  | { t: 'players'; players: MassPlayer[]; queues: MassQueue[] }
  /**
   * Elgato Key Light state changed.
   *
   * Sent whole, like `players`: there are two or three of these and each one
   * is four fields. A diff would be larger than the thing it describes.
   */
  | { t: 'keylights'; lights: KeyLightState[] }
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
   * later as a `players` push. The backend routes by player id — Sonos zones
   * to Sonos, everything else to Music Assistant — and validates every id
   * against what the relevant system actually told it about, for the same
   * reason the Home Assistant path does. See `MusicCommand` for why this
   * carries a verb rather than an upstream command name.
   */
  | { t: 'music'; id: number; cmd: MusicCommand }
  /** Ask for the next N slideshow photos. */
  | { t: 'photos'; id: number; count: number }
  /**
   * Ask Music Assistant for something to look at.
   *
   * The only request/reply pair besides photos. Everything else in this
   * protocol is either a push or fire-and-forget, because a wall panel that
   * waits on a round trip feels broken — but "list my albums" has no answer
   * until the answer arrives, so this one waits, with a spinner.
   */
  | { t: 'browse'; id: number; req: BrowseRequest }
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

