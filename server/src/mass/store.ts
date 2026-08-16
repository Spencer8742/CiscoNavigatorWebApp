import { logger } from '~/lib/log.ts';
import type { MassClient, MassEvent } from '~/mass/client.ts';
import type { MediaArt } from '~/http/media-art.ts';
import type { MassMedia, MassPlayer, MassQueue } from '@shared/protocol.ts';

const log = logger('mass-store');

/**
 * Every speaker and every queue Music Assistant knows about.
 *
 * Filled once on connect and kept current by events — nothing here polls.
 * That is the practical difference between talking to Music Assistant and
 * going through Home Assistant: a queue edited on someone's phone reaches the
 * wall panel because Music Assistant said so, not because the panel asked
 * again a few seconds later.
 *
 * ## Coalescing
 *
 * Music Assistant is chatty during playback. `queue_time_updated` fires every
 * second per active queue, and starting a group of six speakers produces a
 * burst of `player_updated`. Forwarding each one would be a message per second
 * per speaker to a device whose CPU is behind a video pipeline.
 *
 * So updates mark the store dirty and a short timer publishes once. Position
 * is deliberately NOT part of that: the panel gets `elapsed` with the epoch
 * time it was measured and extrapolates locally, so a progress bar moves
 * smoothly on a stream that only ticks occasionally.
 */

/** Long enough to absorb a burst, short enough to feel immediate on a tap. */
const PUBLISH_DEBOUNCE_MS = 120;

/** MA player types that are infrastructure rather than speakers. */
const HIDDEN_TYPES = new Set(['protocol', 'display', 'visualizer', 'light']);

export interface MassStoreEvents {
  /** Something changed; here is the whole picture. */
  onChange(players: MassPlayer[], queues: MassQueue[]): void;
}

export class MassStore {
  readonly #client: MassClient;
  readonly #art: MediaArt;
  readonly #events: MassStoreEvents;

  /** player_id → raw Music Assistant player object. */
  readonly #players = new Map<string, Record<string, unknown>>();
  /** queue_id → raw Music Assistant queue object. */
  readonly #queues = new Map<string, Record<string, unknown>>();

  #dirty = false;
  #publishTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(client: MassClient, art: MediaArt, events: MassStoreEvents) {
    this.#client = client;
    this.#art = art;
    this.#events = events;
  }

  /** Fetch the world. Called on every (re)connect. */
  async refresh(): Promise<void> {
    try {
      const [players, queues] = await Promise.all([
        this.#client.command('players/all'),
        this.#client.command('player_queues/all'),
      ]);

      this.#players.clear();
      for (const p of asArray(players)) {
        const id = str(pick(p, 'player_id'));
        if (id) this.#players.set(id, p as Record<string, unknown>);
      }

      this.#queues.clear();
      for (const q of asArray(queues)) {
        const id = str(pick(q, 'queue_id'));
        if (id) this.#queues.set(id, q as Record<string, unknown>);
      }

      log.info(`Music Assistant: ${this.#players.size} players, ${this.#queues.size} queues`);
      this.#publishNow();
    } catch (err) {
      log.warn('Failed to fetch Music Assistant state:', err);
    }
  }

  /** Drop everything — the link is down and we no longer know. */
  clear(): void {
    this.#players.clear();
    this.#queues.clear();
    this.#publishNow();
  }

  /** Fold one event into the store. */
  apply(event: MassEvent): void {
    const id = event.object_id ?? '';
    const data = event.data as Record<string, unknown> | undefined;

    switch (event.event) {
      case 'player_added':
      case 'player_updated':
        if (id && data) {
          this.#players.set(id, data);
          this.#touch();
        }
        break;

      case 'player_removed':
        if (id && this.#players.delete(id)) this.#touch();
        break;

      case 'queue_added':
      case 'queue_updated':
        if (id && data) {
          this.#queues.set(id, data);
          this.#touch();
        }
        break;

      /*
       * Fires once a second per playing queue. It carries only the elapsed
       * time, which the panel already extrapolates from the last player
       * update — so folding it in would republish the whole world every
       * second to change a number nobody is reading from us.
       */
      case 'queue_time_updated':
        break;

      default:
        // Music Assistant emits plenty we do not model — provider events,
        // sync tasks, dashboards. Ignoring them is correct, not an error.
        break;
    }
  }

  /** The current picture, for a panel that has just connected. */
  snapshot(): { players: MassPlayer[]; queues: MassQueue[] } {
    const players: MassPlayer[] = [];
    for (const [id, raw] of this.#players) {
      const player = this.#describe(id, raw);
      if (player) players.push(player);
    }
    // Alphabetical, so a panel that has filed nothing still gets a stable
    // order rather than whatever order Music Assistant happened to answer in.
    players.sort((a, b) => a.name.localeCompare(b.name));

    const queues: MassQueue[] = [];
    for (const [id, raw] of this.#queues) {
      queues.push({
        id,
        name: str(pick(raw, 'display_name')) ?? str(pick(raw, 'name')) ?? id,
        count: num(pick(raw, 'items')) ?? 0,
        index: num(pick(raw, 'current_index')),
        shuffle: pick(raw, 'shuffle_enabled') === true,
        repeat: str(pick(raw, 'repeat_mode')) ?? 'off',
      });
    }

    return { players, queues };
  }

  /** True when this queue id is one Music Assistant actually told us about. */
  hasQueue(queueId: string): boolean {
    return this.#queues.has(queueId);
  }

  /** True when this player id is one Music Assistant actually told us about. */
  hasPlayer(playerId: string): boolean {
    return this.#players.has(playerId);
  }

  get playerCount(): number {
    return this.#players.size;
  }

  /* ── Publishing ────────────────────────────────────────────────────────*/

  #touch(): void {
    this.#dirty = true;
    if (this.#publishTimer) return;
    this.#publishTimer = setTimeout(() => {
      this.#publishTimer = undefined;
      if (this.#dirty) this.#publishNow();
    }, PUBLISH_DEBOUNCE_MS);
  }

  #publishNow(): void {
    this.#dirty = false;
    const { players, queues } = this.snapshot();
    this.#events.onChange(players, queues);
  }

  dispose(): void {
    clearTimeout(this.#publishTimer);
    this.#publishTimer = undefined;
  }

  /* ── Shaping ───────────────────────────────────────────────────────────*/

  /**
   * Music Assistant's player → what the panel needs.
   *
   * Returns null for the things that are technically players but are not
   * speakers anyone points at: the protocol wrappers behind an AirPlay device,
   * light and visualizer "players", and anything the user has hidden or
   * disabled in Music Assistant itself. Respecting `hide_in_ui` matters — it
   * is the user having already answered "should this appear on a dashboard?".
   */
  #describe(id: string, raw: Record<string, unknown>): MassPlayer | null {
    const type = str(pick(raw, 'type')) ?? 'player';
    if (HIDDEN_TYPES.has(type)) return null;
    if (pick(raw, 'enabled') === false) return null;
    if (pick(raw, 'hide_in_ui') === true) return null;

    const members = asArray(pick(raw, 'group_members')).filter(
      (m): m is string => typeof m === 'string',
    );
    const canGroupWith = asArray(pick(raw, 'can_group_with')).filter(
      (m): m is string => typeof m === 'string',
    );

    /*
     * `active_source` is the queue id when Music Assistant is what the player
     * is playing, and something provider-specific when it is not — a physical
     * line-in, say. Falling back to the player id matches Music Assistant's
     * own convention that a player's default queue shares its id.
     */
    const source = str(pick(raw, 'active_source'));
    const queueId = source && this.#queues.has(source) ? source : this.#queues.has(id) ? id : null;

    return {
      id,
      name: str(pick(raw, 'display_name')) ?? str(pick(raw, 'name')) ?? id,
      type,
      available: pick(raw, 'available') !== false,
      state: str(pick(raw, 'playback_state')) ?? 'idle',
      powered: typeof pick(raw, 'powered') === 'boolean' ? (pick(raw, 'powered') as boolean) : null,
      volume: num(pick(raw, 'volume_level')),
      muted: pick(raw, 'volume_muted') === true,
      members,
      syncedTo: str(pick(raw, 'synced_to')),
      canGroupWith,
      queueId,
      groupVolume: num(pick(raw, 'group_volume')) ?? num(pick(raw, 'volume_level')),
      media: this.#media(pick(raw, 'current_media')),
    };
  }

  #media(raw: unknown): MassMedia | null {
    if (!raw || typeof raw !== 'object') return null;

    const title = str(pick(raw, 'title'));
    if (!title) return null;

    // `image_url` is already a URL on the Music Assistant server, so it goes
    // through the same registry as every other cover — the panel never sees
    // a Music Assistant address.
    const art = this.#art.register(pick(raw, 'image_url'));

    const elapsed = num(pick(raw, 'elapsed_time'));
    const at = num(pick(raw, 'elapsed_time_last_updated'));

    return {
      title,
      artist: str(pick(raw, 'artist')),
      album: str(pick(raw, 'album')),
      art,
      duration: num(pick(raw, 'duration')),
      elapsed,
      // Music Assistant reports this as a UTC timestamp in float SECONDS.
      // Sending it on as-is would make the panel's progress bar think every
      // track started in 1970.
      elapsedAt: at === null ? null : Math.round(at * 1000),
    };
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────────*/

function pick(raw: unknown, key: string): unknown {
  if (!raw || typeof raw !== 'object') return undefined;
  return (raw as Record<string, unknown>)[key];
}

function asArray(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

function str(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function num(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}
