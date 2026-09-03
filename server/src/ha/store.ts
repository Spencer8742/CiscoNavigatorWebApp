import { logger } from '~/lib/log.ts';
import { toMillis, type HaEntityEvent } from '~/ha/protocol.ts';
import type { EntityDiff, EntityState, StatePatch } from '@shared/protocol.ts';
import type { DashboardConfig } from '@shared/config.ts';
import { allReferencedEntities } from '@shared/config.ts';

const log = logger('ha-store');

/**
 * The authoritative entity state.
 *
 * Two decisions worth explaining, because the obvious alternatives are worse:
 *
 * **1. We subscribe to everything and filter on the way OUT.**
 *
 * The alternative — asking Home Assistant for only the configured entities —
 * looks more efficient but means the backend is blind to anything not in the
 * config. Add an entity to `dashboard.yaml` and the panel shows "unavailable"
 * until that entity happens to change state, which for a rarely-used light
 * could be days. Holding every entity costs the backend a megabyte or two on
 * a machine with gigabytes; it costs the panel nothing, because the panel
 * only ever receives the filtered set.
 *
 * **2. Reconnects produce a DIFF, not a repaint.**
 *
 * When the link drops and comes back, HA sends the entire world again as an
 * `a` (added) payload. Forwarding that verbatim would push several hundred
 * kilobytes at every panel and re-render every card on screen — after a
 * two-second HA restart in which nothing actually changed. Instead
 * `beginResync()` marks the store, and the incoming snapshot is compared
 * against what we already had. Panels receive only genuine changes, so an HA
 * restart is invisible.
 */
export class HaStore {
  /** Every entity HA knows about, in OUR format (epoch ms, flat diffs). */
  readonly #states = new Map<string, EntityState>();

  /** Entity ids the config references. Only these are sent to panels. */
  #allowed = new Set<string>();

  /** Entity ids reported missing last time, so we log a change, not a tick. */
  #reportedMissing = new Set<string>();

  /** True between a resubscribe and the snapshot that follows it. */
  #resyncing = false;
  /** Entities seen during the current resync, to detect what disappeared. */
  #resyncSeen = new Set<string>();

  constructor(config: DashboardConfig) {
    this.setConfig(config);
  }

  /** Entities visible to panels, in panel format. */
  snapshot(): Record<string, EntityState> {
    const out: Record<string, EntityState> = {};
    for (const id of this.#allowed) {
      const state = this.#states.get(id);
      if (state) out[id] = state;
    }
    return out;
  }

  /** One entity, if the config references it. Null otherwise. */
  get(entityId: string): EntityState | null {
    if (!this.#allowed.has(entityId)) return null;
    return this.#states.get(entityId) ?? null;
  }

  /** True if the config references this entity. Used by the service guard. */
  isAllowed(entityId: string): boolean {
    return this.#allowed.has(entityId);
  }

  get entityCount(): number {
    return this.#states.size;
  }

  get visibleCount(): number {
    let n = 0;
    for (const id of this.#allowed) if (this.#states.has(id)) n += 1;
    return n;
  }

  /**
   * Apply a new dashboard config.
   *
   * Returns a patch describing what changed for panels: entities the config
   * newly references (which the panel has never seen but we already hold) and
   * entities it no longer references. Nothing else moves, so editing one room
   * in `dashboard.yaml` does not disturb the rest of the screen.
   */
  setConfig(config: DashboardConfig): StatePatch {
    const next = allReferencedEntities(config);

    const patch: StatePatch = {};

    for (const id of next) {
      if (this.#allowed.has(id)) continue;
      const state = this.#states.get(id);
      if (state) (patch.add ??= {})[id] = state;
    }

    for (const id of this.#allowed) {
      if (!next.has(id)) (patch.del ??= []).push(id);
    }

    this.#allowed = next;
    this.reportMissing();
    return patch;
  }

  /**
   * Log the entities `dashboard.yaml` names that Home Assistant does not have.
   *
   * Without this, a mistyped or misguessed entity id fails **silently**: the
   * store simply never has a state for it, the panel is sent nothing, and the
   * card renders as though it were still waiting. The one that motivated this
   * was a device tile written as `prefix: desk_pro` against a device whose
   * entities were registered under a different name — twenty-five ids, all
   * wrong, and nothing anywhere said so.
   *
   * Same reasoning as `immichError` in shared/protocol.ts: the panel is on a
   * wall, and "nothing is showing" has to explain itself somewhere.
   *
   * Only changes are logged. This is called on every snapshot, and a config
   * naming one absent entity should not print a line every time Home
   * Assistant restarts.
   */
  reportMissing(): void {
    // Before the first snapshot we hold nothing, so everything would look
    // missing. Absence is only evidence once HA has told us what it has.
    if (this.#states.size === 0) return;

    const missing = [...this.#allowed].filter((id) => !this.#states.has(id)).sort();
    const same =
      missing.length === this.#reportedMissing.size &&
      missing.every((id) => this.#reportedMissing.has(id));
    if (same) return;

    const had = this.#reportedMissing.size > 0;
    this.#reportedMissing = new Set(missing);

    if (missing.length === 0) {
      if (had) log.info('Every entity in dashboard.yaml now exists in Home Assistant.');
      return;
    }

    log.warn(
      `${missing.length} ${missing.length === 1 ? 'entity' : 'entities'} in dashboard.yaml ` +
        'do not exist in Home Assistant and will never show state:',
    );
    for (const id of missing) log.warn(`  ${id}`);
    log.warn('Check the spelling in Developer Tools -> States. A device tile written with');
    log.warn('`prefix:` derives its ids from the device name, so a renamed device needs the');
    log.warn('new prefix (or the slots written out individually).');
  }

  /**
   * Called when we are about to resubscribe, before the snapshot arrives.
   * See the class comment for why this is not just a clear-and-refill.
   */
  beginResync(): void {
    this.#resyncing = true;
    this.#resyncSeen.clear();
  }

  /**
   * Fold a Home Assistant entity event into the store.
   *
   * Returns the patch to forward to panels — already filtered to allow-listed
   * entities, so a busy house full of unconfigured sensors never wakes a
   * panel.
   */
  apply(event: HaEntityEvent): StatePatch {
    const patch: StatePatch = {};

    if (event.a) {
      for (const id in event.a) {
        const compressed = event.a[id];
        if (!compressed) continue;

        const lc = toMillis(compressed.lc, Date.now());
        const next: EntityState = {
          id,
          s: compressed.s,
          a: compressed.a ?? {},
          lc,
          // HA omits `lu` when it equals `lc`. Missing does not mean zero.
          lu: toMillis(compressed.lu, lc),
        };

        if (this.#resyncing) this.#resyncSeen.add(id);

        const prev = this.#states.get(id);
        this.#states.set(id, next);

        // Only entities the config names are ever sent to a panel.
        if (!this.#allowed.has(id)) continue;

        // During a resync, only report entities that genuinely differ. This
        // is what turns an HA restart from a full repaint into a no-op.
        if (this.#resyncing && prev && sameState(prev, next)) continue;

        (patch.add ??= {})[id] = next;
      }

      // The snapshot has landed; anything we held that HA did not send has
      // been removed from Home Assistant while we were disconnected.
      if (this.#resyncing) {
        for (const id of this.#states.keys()) {
          if (this.#resyncSeen.has(id)) continue;
          this.#states.delete(id);
          if (this.#allowed.has(id)) (patch.del ??= []).push(id);
        }
        this.#resyncing = false;
        this.#resyncSeen.clear();
        log.info(`Resync complete: ${this.#states.size} entities, ${this.visibleCount} visible`);
        // The snapshot is the only moment we can tell "Home Assistant has not
        // sent this yet" from "Home Assistant does not have this".
        this.reportMissing();
      }
    }

    if (event.c) {
      for (const id in event.c) {
        const diff = event.c[id];
        if (!diff) continue;

        const prev = this.#states.get(id);
        if (!prev) {
          // A change for an entity we never saw added. Rare, but it happens
          // if a subscription races an entity being created. Ignoring it is
          // safe: HA will send the full state on the next resync.
          continue;
        }

        const additions = diff['+'];
        const removals = diff['-'];

        let attrs = prev.a;
        if (additions?.a || removals?.a) {
          attrs = { ...prev.a };
          if (additions?.a) Object.assign(attrs, additions.a);
          if (removals?.a) for (const key of removals.a) delete attrs[key];
        }

        // HA sends `lc` OR `lu`, never both. When `lc` is present the state
        // changed, so last_updated tracks it.
        const lc = additions?.lc !== undefined ? toMillis(additions.lc, prev.lc) : prev.lc;
        const lu =
          additions?.lc !== undefined
            ? lc
            : additions?.lu !== undefined
              ? toMillis(additions.lu, prev.lu)
              : prev.lu;

        const next: EntityState = {
          id,
          s: additions?.s ?? prev.s,
          a: attrs,
          lc,
          lu,
        };

        this.#states.set(id, next);

        // Only entities the config names are ever sent to a panel.
        if (!this.#allowed.has(id)) continue;

        // Forward the diff, not the whole state. A light dimming sends ~90
        // bytes instead of ~1.2 KB — which is the whole reason for using
        // subscribe_entities rather than subscribe_events.
        const out: EntityDiff = {};
        if (additions?.s !== undefined) out.s = additions.s;
        if (additions?.a) out.a = additions.a;
        if (removals?.a?.length) out.r = removals.a;
        if (lc !== prev.lc) out.lc = lc;
        if (lu !== prev.lu) out.lu = lu;

        (patch.chg ??= {})[id] = out;
      }
    }

    // NOTE: `r`, not `d`. See ha/protocol.ts.
    if (event.r) {
      for (const id of event.r) {
        this.#states.delete(id);
        if (this.#allowed.has(id)) (patch.del ??= []).push(id);
      }
    }

    return patch;
  }

  /**
   * Mark every visible entity unavailable.
   *
   * Called when the HA link drops. The panel keeps rendering its cards — the
   * layout does not collapse and the user is not dropped onto an error screen
   * — but each control shows as unavailable rather than confidently reporting
   * a state we can no longer verify. Claiming a light is on when we have lost
   * contact is worse than admitting we do not know.
   */
  markUnavailable(): StatePatch {
    const patch: StatePatch = {};
    const now = Date.now();

    for (const id of this.#allowed) {
      const prev = this.#states.get(id);
      if (!prev || prev.s === 'unavailable') continue;
      const next: EntityState = { ...prev, s: 'unavailable', lu: now };
      this.#states.set(id, next);
      (patch.chg ??= {})[id] = { s: 'unavailable', lu: now };
    }

    return patch;
  }
}

/** Cheap equality for resync diffing. Attributes compare by JSON. */
function sameState(a: EntityState, b: EntityState): boolean {
  if (a.s !== b.s || a.lc !== b.lc || a.lu !== b.lu) return false;
  const aKeys = Object.keys(a.a);
  const bKeys = Object.keys(b.a);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const av = a.a[key];
    const bv = b.a[key];
    if (av === bv) continue;
    // Attribute values are frequently arrays or small objects (rgb_color,
    // hvac_modes, source_list), so a shallow compare is not enough.
    if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
  }
  return true;
}

export function isEmptyPatch(patch: StatePatch): boolean {
  return !patch.add && !patch.chg && !patch.del;
}
