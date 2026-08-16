import { WebSocketServer } from 'ws';

/**
 * A mock Music Assistant server.
 *
 * Speaks the real protocol, including the parts that are easy to assume wrong
 * and impossible to verify by reading:
 *
 *  - the **unsolicited server info frame** sent before anything is asked for,
 *    with no `message_id`
 *  - the **auth handshake** for schema >= 28, and its refusal branch
 *  - **partial results**: long lists arrive as several messages sharing one
 *    `message_id`, all but the last carrying `partial: true`. A client that
 *    treats the first as the whole answer silently truncates every long list,
 *    and only for people with big libraries
 *  - **events** pushed with no request behind them
 *
 * It exists so the backend is tested against the protocol Music Assistant
 * actually speaks rather than the one we assumed it speaks.
 */
export class MockMusicAssistant {
  #wss;
  #port;
  #sockets = new Set();

  /** Every command received, for assertions. */
  commands = [];

  /** Set to reject the auth token. */
  rejectAuth = false;
  /** Below 28 the server does not ask for a token at all. */
  schemaVersion = 35;
  token = 'mass-test-token';
  serverVersion = '2.10.3';
  baseUrl = 'http://music-assistant.local:8095';

  /** player_id → raw player object. */
  players = new Map();
  /** queue_id → raw queue object. */
  queues = new Map();
  /** queue_id → array of queue items. */
  queueItems = new Map();
  /** media type → array of library items, in MA's own shape. */
  library = new Map();
  /** Play history, newest first. */
  history = [];

  /**
   * Chunk list replies into this many items per message.
   *
   * Set low on purpose: a client that ignores `partial` passes every test at
   * the default of "one message per reply", which is exactly the bug this
   * mock exists to catch.
   */
  chunkSize = 25;

  constructor(port) {
    this.#port = port;
  }

  async start() {
    this.#wss = new WebSocketServer({ port: this.#port });
    await new Promise((resolve) => this.#wss.once('listening', resolve));

    this.#wss.on('connection', (ws) => {
      this.#sockets.add(ws);
      const session = { authed: this.schemaVersion < 28 };

      ws.on('close', () => this.#sockets.delete(ws));
      ws.on('message', (data) => this.#onMessage(ws, session, data));

      // The server info frame: unsolicited, first, and with no message_id.
      ws.send(
        JSON.stringify({
          server_id: 'mock-mass',
          server_version: this.serverVersion,
          schema_version: this.schemaVersion,
          min_supported_schema_version: 26,
          base_url: this.baseUrl,
          internal_url: this.baseUrl,
          name: 'Mock Music Assistant',
          onboard_done: true,
        }),
      );
    });
  }

  #onMessage(ws, session, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    const id = msg.message_id;
    const args = msg.args ?? {};

    if (msg.command === 'auth') {
      if (this.rejectAuth || args.token !== this.token) {
        ws.send(
          JSON.stringify({
            message_id: id,
            error_code: 3,
            details: 'Invalid or expired token',
          }),
        );
        return;
      }
      session.authed = true;
      ws.send(JSON.stringify({ message_id: id, result: { user_id: 'mock' } }));
      return;
    }

    // Everything else needs auth once the server is new enough to want it.
    if (!session.authed) {
      ws.send(JSON.stringify({ message_id: id, error_code: 3, details: 'Not authenticated' }));
      return;
    }

    this.commands.push(msg);

    const answer = this.#handle(msg.command, args);
    if (answer === undefined) {
      ws.send(JSON.stringify({ message_id: id, error_code: 1, details: 'Unknown command' }));
      return;
    }
    if (answer && answer.__error) {
      ws.send(JSON.stringify({ message_id: id, error_code: 2, details: answer.__error }));
      return;
    }

    this.#reply(ws, id, answer);
  }

  /** Send a result, chunked when it is a long list — as the real server does. */
  #reply(ws, id, result) {
    if (!Array.isArray(result) || result.length <= this.chunkSize) {
      ws.send(JSON.stringify({ message_id: id, result }));
      return;
    }

    let i = 0;
    while (i + this.chunkSize < result.length) {
      ws.send(
        JSON.stringify({
          message_id: id,
          result: result.slice(i, i + this.chunkSize),
          partial: true,
        }),
      );
      i += this.chunkSize;
    }
    // The final message carries the remainder and NO partial flag.
    ws.send(JSON.stringify({ message_id: id, result: result.slice(i) }));
  }

  #handle(command, args) {
    switch (command) {
      case 'players/all':
        return [...this.players.values()];

      case 'player_queues/all':
        return [...this.queues.values()];

      case 'player_queues/items': {
        const items = this.queueItems.get(args.queue_id) ?? [];
        const offset = args.offset ?? 0;
        return items.slice(offset, offset + (args.limit ?? 500));
      }

      case 'music/recently_played_items':
        return this.history.slice(0, args.limit ?? 10);

      case 'music/search': {
        const needle = String(args.search_query ?? '').toLowerCase();
        const limit = args.limit ?? 5;
        const match = (type) =>
          (this.library.get(type) ?? [])
            .filter((x) => x.name.toLowerCase().includes(needle))
            .slice(0, limit);
        return {
          artists: match('artist'),
          albums: match('album'),
          tracks: match('track'),
          playlists: match('playlist'),
          radio: match('radio'),
          podcasts: [],
          audiobooks: [],
        };
      }

      case 'music/item_by_uri': {
        for (const items of this.library.values()) {
          const found = items.find((x) => x.uri === args.uri);
          if (found) return found;
        }
        return { __error: 'Item not found' };
      }

      case 'music/albums/album_tracks':
      case 'music/playlists/playlist_tracks':
      case 'music/podcasts/podcast_episodes': {
        const tracks = this.children.get(args.item_id) ?? [];
        const offset = args.offset ?? 0;
        return args.limit ? tracks.slice(offset, offset + args.limit) : tracks;
      }

      case 'music/artists/artist_albums':
        return this.children.get(args.item_id) ?? [];

      case 'music/favorites/add_item':
      case 'music/favorites/remove_item':
        return null;

      default:
        if (command.startsWith('music/') && command.endsWith('/library_items')) {
          const type = command.split('/')[1].replace(/s$/, '');
          const all = this.library.get(type === 'radio' ? 'radio' : type) ?? [];
          const filtered = args.favorite ? all.filter((x) => x.favorite) : all;
          const offset = args.offset ?? 0;
          return filtered.slice(offset, offset + (args.limit ?? 25));
        }
        // Fire-and-forget commands: players/cmd/*, player_queues/* actions.
        if (command.startsWith('players/cmd/') || command.startsWith('player_queues/')) {
          return null;
        }
        return undefined;
    }
  }

  /* ── Seeding ────────────────────────────────────────────────────────────*/

  /** item_id → child items, for album tracks / artist albums / playlist tracks. */
  children = new Map();

  seedPlayer(id, name, extra = {}) {
    this.players.set(id, {
      player_id: id,
      provider: 'mock',
      type: 'player',
      name,
      display_name: name,
      available: true,
      playback_state: 'idle',
      powered: true,
      volume_level: 40,
      volume_muted: false,
      group_members: [],
      can_group_with: ['mock'],
      synced_to: null,
      active_source: id,
      current_media: null,
      enabled: true,
      hide_in_ui: false,
      icon: 'speaker',
      group_volume: 40,
      device_info: {},
      ...extra,
    });

    // Every player gets a queue sharing its id, as Music Assistant does.
    if (!this.queues.has(id)) {
      this.queues.set(id, {
        queue_id: id,
        display_name: name,
        name,
        active: true,
        items: 0,
        shuffle_enabled: false,
        repeat_mode: 'off',
        current_index: null,
        elapsed_time: 0,
      });
      this.queueItems.set(id, []);
    }
  }

  /** Fill a player's queue with n tracks. */
  seedQueue(queueId, count, currentIndex = 0) {
    const items = [];
    for (let i = 0; i < count; i += 1) {
      items.push({
        queue_item_id: `qi-${i}`,
        name: `queued ${String(i).padStart(3, '0')}`,
        duration: 180 + i,
        media_item: {
          media_type: 'track',
          uri: `library://track/${i}`,
          name: `queued ${String(i).padStart(3, '0')}`,
          artists: [{ media_type: 'artist', uri: `library://artist/${i}`, name: `Artist ${i}` }],
          album: { media_type: 'album', uri: `library://album/${i}`, name: `Album ${i}` },
          metadata: {
            images: [{ type: 'thumb', path: `/img/track-${i}.jpg`, provider: 'mock' }],
          },
        },
      });
    }
    this.queueItems.set(queueId, items);
    const queue = this.queues.get(queueId);
    if (queue) {
      queue.items = count;
      queue.current_index = count > 0 ? currentIndex : null;
    }
  }

  seedLibrary(type, count) {
    const items = [];
    for (let i = 0; i < count; i += 1) {
      const item = {
        media_type: type,
        uri: `library://${type}/${i}`,
        item_id: `${type}-${i}`,
        provider: 'library',
        name: `${type} ${String(i).padStart(3, '0')}`,
        version: '',
        favorite: i % 4 === 0,
        metadata: {
          images: [
            /*
             * Fanart first, and IDENTICAL across every item.
             *
             * Both details matter. First, because a client that takes
             * images[0] picks the backdrop where a cover belongs. Identical,
             * because that is what makes the mistake detectable: read the
             * thumbnail and every item gets a different artwork key, read
             * images[0] and they all collapse onto one.
             */
            { type: 'fanart', path: '/shared-fanart.jpg', provider: 'mock' },
            { type: 'thumb', path: `/thumb-${type}-${i}.jpg`, provider: 'mock' },
          ],
        },
      };
      if (type === 'track' || type === 'album') {
        item.artists = [
          { media_type: 'artist', uri: `library://artist/${i}`, name: `Artist ${i}` },
        ];
      }
      if (type === 'track') {
        item.album = { media_type: 'album', uri: `library://album/${i}`, name: `Album ${i}` };
      }
      items.push(item);
    }
    this.library.set(type, items);
    return items;
  }

  /** Give an item children, so drilling into it returns something. */
  seedChildren(itemId, items) {
    this.children.set(itemId, items);
  }

  seedHistory(items) {
    this.history = items;
  }

  /* ── Events ─────────────────────────────────────────────────────────────*/

  /** Push an event, as the server does when anything changes. */
  emit(event, objectId, data) {
    const frame = JSON.stringify({ event, object_id: objectId, data });
    for (const ws of this.#sockets) ws.send(frame);
  }

  /** Change a player and announce it, the way the real server would. */
  updatePlayer(id, changes) {
    const player = this.players.get(id);
    if (!player) throw new Error(`mock-mass: unknown player ${id}`);
    Object.assign(player, changes);
    this.emit('player_updated', id, player);
  }

  updateQueue(id, changes) {
    const queue = this.queues.get(id);
    if (!queue) throw new Error(`mock-mass: unknown queue ${id}`);
    Object.assign(queue, changes);
    this.emit('queue_updated', id, queue);
  }

  get connectionCount() {
    return this.#sockets.size;
  }

  dropConnections() {
    for (const ws of this.#sockets) ws.terminate();
    this.#sockets.clear();
  }

  async stop() {
    if (!this.#wss) return;
    for (const ws of this.#sockets) ws.terminate();
    this.#sockets.clear();
    await new Promise((resolve) => this.#wss.close(resolve));
    this.#wss = null;
  }
}
