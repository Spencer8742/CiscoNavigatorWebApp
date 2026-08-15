import { signal, type Signal } from '@preact/signals';
import { isMusicAssistantPlayer, type EntityState, type StatePatch } from '@shared/protocol.ts';

/**
 * The entity store: one signal per entity.
 *
 * This is the single most important performance decision in the panel.
 *
 * The naive design keeps all entities in one object and re-renders whatever
 * subscribes to it. With ~200 entities in a busy house you get a re-render
 * storm: a motion sensor tripping in the hall re-runs every component on
 * screen. On a CPU that RoomOS deliberately deprioritises behind the video
 * pipeline (docs/ROOMOS.md §2), that is visible jank.
 *
 * Here, each entity owns a signal. A component that reads
 * `entity('light.kitchen').value` subscribes to THAT entity alone. When the
 * hall sensor changes, the kitchen light's subtree is not touched — no
 * component function runs, no VDOM is diffed. Update cost scales with what
 * changed, not with what is on screen.
 */

const store = new Map<string, Signal<EntityState | null>>();

/**
 * Ids of every Music Assistant speaker currently known.
 *
 * A separate signal rather than something derived by iterating `store`,
 * because `store` is a plain Map: a computed that walked it would neither
 * notice a speaker appearing nor stop at the ones it cares about — it would
 * subscribe to all two hundred entities and reintroduce exactly the re-render
 * storm this file exists to prevent.
 *
 * This changes only when the SET of speakers changes, which is on connect, on
 * resync, and when someone adds a speaker to Music Assistant. Their states
 * change through their own signals as usual.
 */
export const maPlayerIds = signal<string[]>([]);

/** Recompute the speaker list, writing only when it genuinely differs. */
function refreshMaPlayers(): void {
  const found: string[] = [];
  for (const [id, sig] of store) {
    const state = sig.peek();
    if (state && isMusicAssistantPlayer(id, state)) found.push(id);
  }
  found.sort();

  const prev = maPlayerIds.peek();
  if (prev.length === found.length && prev.every((id, i) => id === found[i])) return;
  maPlayerIds.value = found;
}

/**
 * Get (or lazily create) the signal for an entity.
 *
 * Creating on demand means a component can reference an entity that Home
 * Assistant has not sent yet — during startup, or because it is genuinely
 * missing from HA — and it will simply render its unavailable state, then
 * light up when the entity appears. No null checks scattered through the UI,
 * no crash from a typo in dashboard.yaml.
 */
export function entity(id: string): Signal<EntityState | null> {
  let sig = store.get(id);
  if (!sig) {
    sig = signal<EntityState | null>(null);
    store.set(id, sig);
  }
  return sig;
}

/** Snapshot read, for logic that should not subscribe. */
export function peekEntity(id: string): EntityState | null {
  return store.get(id)?.peek() ?? null;
}

/** Replace the whole world. Used on `hello`, including after a reconnect. */
export function applySnapshot(states: Record<string, EntityState>): void {
  // Null out anything that has vanished, rather than deleting the signal —
  // components holding a reference keep working and just render unavailable.
  for (const [id, sig] of store) {
    if (!(id in states) && sig.peek() !== null) sig.value = null;
  }
  for (const id in states) {
    const next = states[id];
    if (next) entity(id).value = next;
  }
  refreshMaPlayers();
}

/**
 * Apply an incremental patch.
 *
 * Mirrors Home Assistant's own `subscribe_entities` diff format, so this is
 * the same logic the backend runs — written once, in one shape, on both ends.
 */
export function applyPatch(patch: StatePatch): void {
  // Only an add or a delete can change WHICH speakers exist; a state change
  // on one that already exists cannot.
  const membershipChanged = Boolean(patch.add) || Boolean(patch.del);

  if (patch.add) {
    for (const id in patch.add) {
      const next = patch.add[id];
      if (next) entity(id).value = next;
    }
  }

  if (patch.chg) {
    for (const id in patch.chg) {
      const diff = patch.chg[id];
      if (!diff) continue;
      const sig = entity(id);
      const prev = sig.peek();
      if (!prev) continue; // a change for an entity we never saw added

      // Attributes are copied rather than mutated: signals compare by
      // reference, and mutating in place would silently skip the update.
      let attrs = prev.a;
      if (diff.a || diff.r) {
        attrs = { ...prev.a };
        if (diff.a) Object.assign(attrs, diff.a);
        if (diff.r) for (const key of diff.r) delete attrs[key];
      }

      sig.value = {
        id,
        s: diff.s ?? prev.s,
        a: attrs,
        lc: diff.lc ?? prev.lc,
        lu: diff.lu ?? prev.lu,
      };
    }
  }

  if (patch.del) {
    for (const id of patch.del) {
      const sig = store.get(id);
      if (sig && sig.peek() !== null) sig.value = null;
    }
  }

  if (membershipChanged) refreshMaPlayers();
}

/**
 * Optimistic local write.
 *
 * When a finger moves a brightness slider we update the signal immediately so
 * the thumb tracks the finger in the same frame, then send the command. Home
 * Assistant's real state arrives ~20 ms later and overwrites this — normally
 * with the same value, so nothing visibly changes. If the command failed, HA's
 * state is authoritative and the control snaps back, which is the correct
 * behaviour: the UI must never claim a light is on when it isn't.
 */
export function optimistic(id: string, s: string, attrs?: Record<string, unknown>): void {
  const sig = entity(id);
  const prev = sig.peek();
  const now = Date.now();
  sig.value = {
    id,
    s,
    a: attrs ? { ...(prev?.a ?? {}), ...attrs } : (prev?.a ?? {}),
    lc: prev?.s === s ? (prev?.lc ?? now) : now,
    lu: now,
  };
}

/** Diagnostics only (Settings screen). */
export function entityCount(): number {
  let n = 0;
  for (const sig of store.values()) if (sig.peek() !== null) n += 1;
  return n;
}
