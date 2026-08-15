/**
 * Home Assistant's WebSocket wire format.
 *
 * These types were written against Home Assistant's own source rather than
 * from memory, because the compressed-state format is easy to get subtly
 * wrong and the failure mode is a dashboard that looks right until an
 * attribute is removed:
 *
 *   homeassistant/components/websocket_api/messages.py
 *   homeassistant/core.py            (State.as_compressed_state)
 *
 * The three details that most often trip people up:
 *
 *  1. Removals use the key **`r`**, not `d`.
 *  2. Changes are nested under **`+`** (additions/changes) and **`-`**
 *     (removals), not flat.
 *  3. `lc` / `lu` are **floating-point seconds**, not milliseconds.
 *
 * And one that is not documented anywhere obvious: `lu` is OMITTED from an
 * add when it equals `lc`, and on a change HA sends `lc` *or* `lu` but never
 * both — if `lc` is present, `lu` is implicitly the same value.
 */

/** `{ COMPRESSED_STATE_* }` — one entity in an `a` (added) payload. */
export interface HaCompressedState {
  /** state */
  s: string;
  /** attributes */
  a: Record<string, unknown>;
  /** context: an id string, or an object when parent_id/user_id are set */
  c?: string | Record<string, unknown>;
  /** last_changed, epoch SECONDS (float) */
  lc: number;
  /** last_updated, epoch SECONDS (float). Omitted when equal to lc. */
  lu?: number;
}

/** The `+` half of a change: keys that were added or changed. */
export interface HaStateAdditions {
  s?: string;
  /** only the attributes that changed */
  a?: Record<string, unknown>;
  c?: string | Record<string, unknown>;
  lc?: number;
  lu?: number;
}

/** The `-` half of a change: keys that were removed. */
export interface HaStateRemovals {
  /** attribute names that no longer exist */
  a?: string[];
}

export interface HaStateDiff {
  '+'?: HaStateAdditions;
  '-'?: HaStateRemovals;
}

/** The payload of a `subscribe_entities` event. */
export interface HaEntityEvent {
  /** added — full compressed state */
  a?: Record<string, HaCompressedState>;
  /** changed — diff only */
  c?: Record<string, HaStateDiff>;
  /** removed — entity ids. NOTE: `r`, not `d`. */
  r?: string[];
}

/**
 * Messages we act on.
 *
 * Deliberately has NO catch-all member: adding `{ type: string }` to the
 * union would collapse discriminated narrowing everywhere and force casts in
 * each branch. Unknown message types are handled at runtime instead — see
 * `HaClient.#handle` — since Home Assistant sends plenty of types we never
 * subscribed to and ignoring them is correct, not an error.
 */
export type HaIncoming =
  | { type: 'auth_required'; ha_version?: string }
  | { type: 'auth_ok'; ha_version?: string }
  | { type: 'auth_invalid'; message?: string }
  | {
      id: number;
      type: 'result';
      success: boolean;
      result?: unknown;
      error?: { code: string; message: string };
    }
  | { id: number; type: 'event'; event: HaEntityEvent }
  | { id: number; type: 'pong' };

/** HA epoch-seconds float → epoch milliseconds integer. */
export function toMillis(seconds: number | undefined, fallback: number): number {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? Math.round(seconds * 1000)
    : fallback;
}
