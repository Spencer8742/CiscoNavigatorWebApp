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
    }
  /** Incremental entity state. */
  | { t: 'patch'; patch: StatePatch }
  /** Config file changed on disk and revalidated. */
  | { t: 'config'; config: DashboardConfig }
  /** Backend link health changed. */
  | { t: 'health'; health: BackendHealth }
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
  | { t: 'ping'; id: number };

/** Application-level heartbeat interval. A Wi-Fi roam can leave a socket
 *  half-open for minutes before TCP notices; this catches it in seconds. */
export const HEARTBEAT_MS = 25_000;
/** Miss this many heartbeats and we tear the socket down and reconnect. */
export const HEARTBEAT_TIMEOUT_MS = 12_000;
