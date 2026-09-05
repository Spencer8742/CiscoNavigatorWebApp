import { logger } from '~/lib/log.ts';
import type { MassClient } from '~/mass/client.ts';
import type { MassStore } from '~/mass/store.ts';
import type { MusicCommand } from '@shared/protocol.ts';

const log = logger('mass-cmd');

/**
 * The guard between a panel and Music Assistant.
 *
 * Same reasoning as the Home Assistant service guard, and it matters more
 * here, not less: Music Assistant's API is an *administrative* API. The same
 * socket that skips a track can delete a playlist, remove a provider, rewrite
 * player configuration and trigger a full library resync. A wall panel is a
 * device anyone in the room can touch, so it gets the twenty verbs a music
 * remote needs and nothing else.
 *
 * The allow-list is by exact command name. There is no prefix matching,
 * because `music/` would let `music/playlists/remove` through and
 * `players/cmd/` would include `set_option`.
 */

/**
 * Commands a panel may run.
 *
 * Notable absences, all deliberate:
 *
 *  - `players/cmd/play_announcement` — makes a speaker fetch and play any URL
 *  - `players/create_group_player`, `players/remove` — configuration, not use
 *  - `music/library/remove_item`, `music/playlists/remove` — destructive
 *  - `music/sync` — kicks off a full provider resync
 *  - anything under `config/`, `providers/`, `auth/`
 */
const ALLOWED = new Set([
  // Transport. These act on the queue rather than the player, because that is
  // what Music Assistant considers authoritative when it is the source.
  'player_queues/play',
  'player_queues/pause',
  'player_queues/play_pause',
  'player_queues/stop',
  'player_queues/next',
  'player_queues/previous',
  'player_queues/seek',
  'player_queues/shuffle',
  'player_queues/repeat',

  // The queue itself — the whole reason this connection exists.
  'player_queues/play_index',
  'player_queues/move_item',
  'player_queues/delete_item',
  'player_queues/clear',
  'player_queues/play_media',
  'player_queues/transfer',

  // Player-level controls.
  'players/cmd/play',
  'players/cmd/pause',
  'players/cmd/play_pause',
  'players/cmd/stop',
  'players/cmd/next',
  'players/cmd/previous',
  'players/cmd/power',
  'players/cmd/volume_set',
  'players/cmd/volume_up',
  'players/cmd/volume_down',
  'players/cmd/volume_mute',
  'players/cmd/group_volume',
  'players/cmd/select_source',

  // Grouping.
  'players/cmd/group',
  'players/cmd/group_many',
  'players/cmd/ungroup',
  'players/cmd/ungroup_many',
  'players/cmd/set_members',

  // Marking something a favourite is the one library WRITE a panel gets, and
  // it is reversible and harmless.
  'music/favorites/add_item',
  'music/favorites/remove_item',
]);

/**
 * Argument keys each command may carry, by key name rather than by command.
 *
 * Anything not listed is dropped. Music Assistant ignores unknown arguments
 * rather than rejecting them, which means an unfiltered pass-through would
 * silently hand it whatever a compromised panel invented.
 */
const ALLOWED_ARGS = new Set([
  'player_id',
  'player_ids',
  'queue_id',
  'target_player',
  'source_player',
  'child_player_ids',
  'powered',
  'volume_level',
  'muted',
  'position',
  'index',
  'seek_position',
  'fade_in',
  'shuffle_enabled',
  'repeat_mode',
  'queue_item_id',
  'item_id_or_index',
  'pos_shift',
  'media',
  'option',
  'radio_mode',
  'start_item',
  'source_id',
  'item',
  'media_type',
  'auto_play',
]);

/** Keys whose value is a player id and must therefore be checked. */
const PLAYER_ID_KEYS = ['player_id', 'target_player', 'source_player'];
/** Keys whose value is a LIST of player ids. */
const PLAYER_LIST_KEYS = ['player_ids', 'child_player_ids'];

const MAX_IDS = 64;
const MAX_STRING = 512;

/** Repeat modes Music Assistant accepts. */
const REPEAT_MODES = new Set(['off', 'one', 'all']);
/** Queue options for play_media. */
const QUEUE_OPTIONS = new Set(['play', 'replace', 'next', 'replace_next', 'add']);

/**
 * What `media` may contain — the same rule as the Home Assistant path.
 *
 * Music Assistant will play a bare file path or fetch an arbitrary URL if you
 * hand it one, which turns "play this album" into a way to read the Music
 * Assistant host's disk or to make it fetch a URL of the caller's choosing.
 * Library URIs all carry a scheme, so requiring one and refusing the network
 * and filesystem schemes leaves exactly the URIs that browsing produces.
 */
const URI_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const FORBIDDEN_SCHEMES = new Set(['file', 'http', 'https', 'ftp', 'data']);

export function isPlayableUri(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  if (raw.length === 0 || raw.length > MAX_STRING) return false;
  if (!URI_RE.test(raw)) return false;
  return !FORBIDDEN_SCHEMES.has(raw.slice(0, raw.indexOf(':')).toLowerCase());
}

export class MassCommands {
  readonly #client: MassClient;
  readonly #store: MassStore;

  constructor(client: MassClient, store: MassStore) {
    this.#client = client;
    this.#store = store;
  }

  /**
   * Perform one of the panel's verbs.
   *
   * The panel stopped sending Music Assistant command names when Sonos arrived
   * — it names a player and an intention, and the backend routes. This is the
   * translation back, and it is **deliberately throwaway**: `docs/SONOS.md`
   * phase 6 deletes this file along with the rest of `mass/`, at which point
   * the verbs go straight to Sonos and nothing has to be rewritten.
   *
   * Everything still funnels through `run()`, so the allow-list, the id checks
   * and the URI rules below apply exactly as before.
   */
  runVerb(cmd: MusicCommand): string | null {
    if (!this.#client.enabled) return 'Music Assistant is not configured';

    /*
     * Check the player FIRST.
     *
     * Several verbs below fall back to doing nothing when the player has no
     * queue, which is right for a speaker playing a physical input and wrong
     * for a player id that does not exist — that would turn an attempt to
     * reach past the allow-list into a silent success, which is
     * indistinguishable from a command that worked.
     */
    if (!this.#store.hasPlayer(cmd.player)) {
      log.warn(`Refused ${cmd.verb}: "${cmd.player}" is not a known player`);
      return 'Not permitted';
    }

    // Most commands act on the queue when Music Assistant is the source, and
    // the player only when it is not. `run()` re-validates whichever we choose.
    const queue = this.#store.snapshot().players.find((p) => p.id === cmd.player)?.queueId ?? null;

    const onQueue = (command: string, args: Record<string, unknown> = {}): string | null =>
      queue
        ? this.run(`player_queues/${command}`, { queue_id: queue, ...args })
        : this.run(`players/cmd/${command}`, { player_id: cmd.player });

    /** For the verbs that only exist on a queue. */
    const needsQueue = (fn: (id: string) => string | null): string | null =>
      queue ? fn(queue) : 'That speaker has no queue';

    switch (cmd.verb) {
      case 'playPause':
        return onQueue('play_pause');
      case 'play':
        return onQueue('play');
      case 'pause':
        return onQueue('pause');
      case 'stop':
        return onQueue('stop');
      case 'next':
        return onQueue('next');
      case 'previous':
        return onQueue('previous');

      case 'seek':
        return needsQueue((id) =>
          this.run('player_queues/seek', {
            queue_id: id,
            position: Math.max(0, Math.round(cmd.seconds)),
          }),
        );

      case 'volume':
        return this.run('players/cmd/volume_set', {
          player_id: cmd.player,
          volume_level: cmd.level,
        });

      case 'mute':
        return this.run('players/cmd/volume_mute', { player_id: cmd.player, muted: cmd.muted });

      case 'power':
        return this.run('players/cmd/power', { player_id: cmd.player, powered: cmd.on });

      case 'shuffle':
        return needsQueue((id) =>
          this.run('player_queues/shuffle', { queue_id: id, shuffle_enabled: cmd.on }),
        );

      case 'repeat':
        return needsQueue((id) =>
          this.run('player_queues/repeat', { queue_id: id, repeat_mode: cmd.mode }),
        );

      case 'group':
        return this.run('players/cmd/set_members', {
          player_id: cmd.player,
          // The leader is implied by the target, and Music Assistant rejects a
          // group that names itself as its own child.
          child_player_ids: Array.isArray(cmd.members)
            ? cmd.members.filter((id) => id !== cmd.player)
            : cmd.members,
        });

      case 'ungroup':
        return this.run('players/cmd/ungroup', { player_id: cmd.player });

      case 'playItem':
        return this.run('player_queues/play_media', {
          // A player's default queue shares its id, which is the fallback when
          // Music Assistant has not named one.
          queue_id: queue ?? cmd.player,
          media: cmd.item,
          option: cmd.enqueue,
          ...(cmd.radio ? { radio_mode: true } : {}),
        });

      case 'queueJump':
        return needsQueue((id) =>
          this.run('player_queues/play_index', { queue_id: id, index: cmd.index }),
        );

      case 'queueMove':
        return needsQueue((id) =>
          this.run('player_queues/move_item', {
            queue_id: id,
            queue_item_id: cmd.item,
            pos_shift: cmd.by,
          }),
        );

      case 'queueRemove':
        return needsQueue((id) =>
          this.run('player_queues/delete_item', { queue_id: id, item_id_or_index: cmd.item }),
        );

      case 'queueClear':
        return needsQueue((id) => this.run('player_queues/clear', { queue_id: id }));

      case 'favorite':
        return this.run(
          cmd.on ? 'music/favorites/add_item' : 'music/favorites/remove_item',
          { item: cmd.item },
        );
    }
  }

  /**
   * Validate and forward. Returns an error message for the panel, or null.
   *
   * Refusals are vague on purpose ("Not permitted") while the log line is
   * specific: a panel is not the place to explain the shape of an allow-list
   * to whoever is standing in front of it.
   */
  run(command: string, rawArgs: unknown): string | null {
    if (!this.#client.enabled) return 'Music Assistant is not configured';

    if (typeof command !== 'string' || !ALLOWED.has(command)) {
      log.warn(`Refused "${String(command)}": not an allowed command`);
      return 'Not permitted';
    }

    if (rawArgs !== undefined && (typeof rawArgs !== 'object' || rawArgs === null)) {
      return 'Not permitted';
    }

    const args = this.#filter(command, (rawArgs ?? {}) as Record<string, unknown>);
    if (args === null) return 'Not permitted';

    if (!this.#client.send(command, args)) {
      return 'Music Assistant is offline';
    }

    log.debug(`${command}`, args);
    return null;
  }

  /**
   * Drop unknown keys, then validate the ones that name something.
   *
   * Returns null to refuse the whole call. The distinction matters: an unknown
   * key is a version skew and is dropped silently, but a player id the panel
   * should not be able to name is an attempt to reach past the allow-list and
   * kills the command.
   */
  #filter(command: string, args: Record<string, unknown>): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};

    for (const key in args) {
      if (!ALLOWED_ARGS.has(key)) {
        log.debug(`Dropped disallowed argument "${key}" for ${command}`);
        continue;
      }
      out[key] = args[key];
    }

    /*
     * Every id has to name something Music Assistant actually told us about.
     * Without this, `players/cmd/group_many` would take any string and the
     * allow-list would be decoration — the same hole `group_members` opened on
     * the Home Assistant side.
     */
    for (const key of PLAYER_ID_KEYS) {
      const value = out[key];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !this.#store.hasPlayer(value)) {
        log.warn(`Refused ${command}: "${String(value)}" is not a known player`);
        return null;
      }
    }

    for (const key of PLAYER_LIST_KEYS) {
      const value = out[key];
      if (value === undefined) continue;
      if (!Array.isArray(value) || value.length > MAX_IDS) {
        log.warn(`Refused ${command}: ${key} is not a usable list`);
        return null;
      }
      for (const id of value) {
        if (typeof id !== 'string' || !this.#store.hasPlayer(id)) {
          log.warn(`Refused ${command}: "${String(id)}" is not a known player`);
          return null;
        }
      }
    }

    const queueId = out['queue_id'];
    if (queueId !== undefined) {
      if (typeof queueId !== 'string' || !this.#store.hasQueue(queueId)) {
        log.warn(`Refused ${command}: "${String(queueId)}" is not a known queue`);
        return null;
      }
    }

    const media = out['media'];
    if (media !== undefined) {
      const list = Array.isArray(media) ? media : [media];
      if (list.length === 0 || list.length > MAX_IDS || !list.every(isPlayableUri)) {
        log.warn(`Refused ${command}: media is not a library URI`);
        return null;
      }
    }

    const item = out['item'];
    if (item !== undefined && !isPlayableUri(item)) {
      log.warn(`Refused ${command}: item is not a library URI`);
      return null;
    }

    const volume = out['volume_level'];
    if (volume !== undefined) {
      if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 100) {
        log.warn(`Refused ${command}: volume_level out of range`);
        return null;
      }
      // Music Assistant's scale is an integer 0-100.
      out['volume_level'] = Math.round(volume);
    }

    const repeat = out['repeat_mode'];
    if (repeat !== undefined && (typeof repeat !== 'string' || !REPEAT_MODES.has(repeat))) {
      return null;
    }

    const option = out['option'];
    if (option !== undefined && (typeof option !== 'string' || !QUEUE_OPTIONS.has(option))) {
      return null;
    }

    // Everything left that we did not specifically shape must still be a
    // primitive: a nested object here would be arguments we never inspected.
    for (const key in out) {
      const value = out[key];
      if (key === 'media' || key === 'player_ids' || key === 'child_player_ids') continue;
      if (value === null) continue;
      const kind = typeof value;
      if (kind !== 'string' && kind !== 'number' && kind !== 'boolean') {
        log.warn(`Refused ${command}: argument "${key}" is not a primitive`);
        return null;
      }
      if (kind === 'string' && (value as string).length > MAX_STRING) return null;
    }

    return out;
  }
}
