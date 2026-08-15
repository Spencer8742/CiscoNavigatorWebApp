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

import type { DashboardConfig } from './config.ts';

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

/* ── Server → panel ────────────────────────────────────────────────────── */

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
    }
  /** Incremental entity state. */
  | { t: 'patch'; patch: StatePatch }
  /** Config file changed on disk and revalidated. */
  | { t: 'config'; config: DashboardConfig }
  /** Backend link health changed. */
  | { t: 'health'; health: BackendHealth }
  /** A preference changed — on this panel or another one. */
  | { t: 'prefs'; prefs: PanelPrefs }
  /** A batch of photos for the slideshow to preload. */
  | { t: 'photos'; photos: PhotoRef[] }
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
  /** Ask for the next N slideshow photos. */
  | { t: 'photos'; id: number; count: number }
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

/* ── Music Assistant ───────────────────────────────────────────────────── */

/**
 * The attribute Music Assistant's Home Assistant integration puts on every
 * media_player entity it creates, and which nothing else sets.
 *
 * It is how this app tells an MA speaker from any other media player without
 * knowing anything about config entries or the entity registry. Values come
 * from MA's `PlayerType`: `player`, `stereo_pair`, `group`, and a few kinds
 * that are not speakers.
 */
export const MA_PLAYER_TYPE_ATTR = 'mass_player_type';

/**
 * MA player types that are not speakers you would send music to.
 *
 * `protocol` players are wrapped by a Universal Player and explicitly "hidden
 * from the UI" in MA's own documentation; the rest are visualisers rather
 * than outputs.
 */
const MA_NON_SPEAKER_TYPES = new Set(['protocol', 'display', 'visualizer', 'light']);

/** Home Assistant's `MediaPlayerEntityFeature.GROUPING` bit. */
export const MEDIA_FEATURE_GROUPING = 524_288;
/** `MediaPlayerEntityFeature.VOLUME_SET`. */
export const MEDIA_FEATURE_VOLUME_SET = 4;

/** Whether this entity is a Music Assistant speaker. */
export function isMusicAssistantPlayer(entityId: string, state: EntityState): boolean {
  if (!entityId.startsWith('media_player.')) return false;
  const type = state.a[MA_PLAYER_TYPE_ATTR];
  return typeof type === 'string' && !MA_NON_SPEAKER_TYPES.has(type);
}

/** Whether this player can be joined to others. */
export function canGroup(state: EntityState | null | undefined): boolean {
  const features = state?.a['supported_features'];
  return typeof features === 'number' && (features & MEDIA_FEATURE_GROUPING) !== 0;
}

/** Entity ids currently playing in sync with this one, including itself. */
export function groupMembers(state: EntityState | null | undefined): string[] {
  const raw = state?.a['group_members'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}
