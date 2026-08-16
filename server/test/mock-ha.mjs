import { WebSocketServer } from 'ws';

/** Music Assistant services registered with SupportsResponse.ONLY. */
const RESPONSE_SERVICES = new Set(['search', 'get_library', 'get_queue']);

/**
 * A mock Home Assistant WebSocket server.
 *
 * Speaks the real protocol, including the parts that are easy to get wrong
 * and impossible to verify by reading:
 *
 *  - the auth handshake and its `auth_invalid` branch
 *  - `supported_features` / `coalesce_messages`, and actually COALESCING
 *    (sending a JSON array rather than separate frames) when it is on
 *  - the compressed `subscribe_entities` format: `a` / `c` / `r`, the `+`/`-`
 *    nesting, `lc`/`lu` in float SECONDS, and `lu` omitted when equal to `lc`
 *
 * Existing so the bridge can be tested against the format Home Assistant
 * actually sends rather than the one we assume it sends.
 */
export class MockHomeAssistant {
  #wss;
  #port;
  #sockets = new Set();

  /** entity_id → { s, a, lc, lu } with timestamps in SECONDS, as HA uses. */
  states = new Map();

  /** Every call_service message received, for assertions. */
  serviceCalls = [];

  /** Set to true to reject the token instead of accepting it. */
  rejectAuth = false;

  /** Set false to send messages individually even when coalescing is on. */
  coalesce = true;

  /** entity_id → registry entry, as `config/entity_registry/get` returns it. */
  registry = new Map();

  /** The config entry id that `music_assistant.search` will accept. */
  maConfigEntry = 'ma01entry';

  /**
   * Music Assistant's library, by media type.
   *
   * Items are in MA's OWN response shape — `uri`, `name`, `media_type`,
   * `image`, nested `artists` — not the app's. Normalising in the mock would
   * mean the test never exercises the code that does the normalising, which is
   * where the bugs are.
   */
  maLibrary = new Map();

  /** What `music_assistant.get_queue` reports, by entity id. */
  maQueues = new Map();

  constructor(port) {
    this.#port = port;
  }

  /** Restartable, so tests can simulate a full outage and a recovery. */
  async start() {
    this.#wss = new WebSocketServer({ port: this.#port });
    await new Promise((resolve) => this.#wss.once('listening', resolve));

    this.#wss.on('connection', (ws) => {
      this.#sockets.add(ws);
      const session = { authed: false, subscriptionId: null, coalescing: false };

      ws.on('close', () => this.#sockets.delete(ws));
      ws.on('message', (data) => this.#onMessage(ws, session, data));

      ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.8.0' }));
    });
  }

  #onMessage(ws, session, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'auth') {
      if (this.rejectAuth) {
        ws.send(JSON.stringify({ type: 'auth_invalid', message: 'invalid access token' }));
        return;
      }
      session.authed = true;
      ws.send(JSON.stringify({ type: 'auth_ok', ha_version: '2026.8.0' }));
      return;
    }

    if (!session.authed) return;

    switch (msg.type) {
      case 'supported_features':
        session.coalescing = Boolean(msg.features?.coalesce_messages);
        ws.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result: null }));
        break;

      case 'subscribe_entities': {
        session.subscriptionId = msg.id;
        ws.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result: null }));

        // The full-state snapshot, in HA's compressed `a` form.
        const added = {};
        for (const [id, state] of this.states) added[id] = this.#compress(state);
        ws.send(JSON.stringify({ id: msg.id, type: 'event', event: { a: added } }));
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ id: msg.id, type: 'pong' }));
        break;

      case 'config/entity_registry/get': {
        const entry = this.registry.get(msg.entity_id);
        if (!entry) {
          ws.send(
            JSON.stringify({
              id: msg.id,
              type: 'result',
              success: false,
              error: { code: 'not_found', message: 'Entity not found' },
            }),
          );
          break;
        }
        ws.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result: entry }));
        break;
      }

      case 'call_service':
        this.serviceCalls.push(msg);

        // Services that RETURN something. Home Assistant only includes the
        // response when the caller sets return_response, and refuses the call
        // when a response-only service is asked without it — both of which the
        // mock reproduces, because getting that wrong is exactly the mistake
        // this half of the protocol invites.
        if (msg.domain === 'music_assistant' && RESPONSE_SERVICES.has(msg.service)) {
          if (!msg.return_response) {
            ws.send(
              JSON.stringify({
                id: msg.id,
                type: 'result',
                success: false,
                error: {
                  code: 'service_validation_error',
                  message: 'The service requires the response to be returned',
                },
              }),
            );
            break;
          }
          const answer = this.#musicAssistant(msg);
          ws.send(JSON.stringify({ id: msg.id, type: 'result', success: answer.ok, ...(answer.ok ? { result: { context: {}, response: answer.response } } : { error: answer.error }) }));
          break;
        }

        // Behave like Music Assistant for grouping, so a test exercises the
        // whole round trip — tap, service call, state change, UI update —
        // rather than only asserting that a call went out.
        if (msg.domain === 'media_player' && (msg.service === 'join' || msg.service === 'unjoin')) {
          this.#applyGrouping(msg);
        }
        // Volume too, so a test can assert on the resulting STATE rather than
        // on the fact that a call went out — the two are not the same claim.
        if (msg.domain === 'media_player' && msg.service === 'volume_set') {
          const target = msg.target?.entity_id;
          const id = Array.isArray(target) ? target[0] : target;
          const level = msg.service_data?.volume_level;
          if (id && this.states.has(id) && typeof level === 'number') {
            this.change(id, { attributes: { volume_level: level } });
          }
        }
        ws.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result: {} }));
        break;

      default:
        ws.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result: null }));
    }
  }

  /** Compressed add form. `lu` is omitted when it equals `lc`, as HA does. */
  #compress(state) {
    const out = { s: state.s, a: state.a, c: '01ABCDEF', lc: state.lc };
    if (state.lu !== state.lc) out.lu = state.lu;
    return out;
  }

  /**
   * Seed a Music Assistant speaker.
   *
   * The attributes that matter are the ones MA's own integration sets:
   * `mass_player_type` (which nothing else sets, and is how the app
   * recognises an MA player), `group_members`, and the GROUPING bit in
   * `supported_features`.
   */
  seedMaPlayer(id, name, { type = 'player', volume = 0.4, state = 'idle', grouping = true } = {}) {
    // GROUPING (524288) | VOLUME_SET (4) | VOLUME_MUTE (8) | PLAY | PAUSE
    const features = (grouping ? 524288 : 0) | 4 | 8 | 16384 | 1;
    this.seed(id, state, {
      friendly_name: name,
      mass_player_type: type,
      group_members: [],
      volume_level: volume,
      is_volume_muted: false,
      supported_features: features,
    });
  }

  /**
   * Apply a join/unjoin the way Music Assistant does.
   *
   * The important detail: EVERY member reports the same `group_members` list,
   * leader included — that is what lets the panel derive the whole group from
   * whichever player it happens to be showing.
   */
  #applyGrouping(msg) {
    const target = msg.target?.entity_id;
    const leader = Array.isArray(target) ? target[0] : target;
    if (!leader) return;

    if (msg.service === 'unjoin') {
      const members = [...(this.states.get(leader)?.a.group_members ?? [])];
      const remaining = members.filter((id) => id !== leader);
      this.change(leader, { attributes: { group_members: [] } });
      // One left behind is not a group.
      const next = remaining.length > 1 ? remaining : [];
      for (const id of remaining) this.change(id, { attributes: { group_members: next } });
      return;
    }

    const added = msg.service_data?.group_members ?? [];
    const members = [leader, ...added.filter((id) => id !== leader)];
    for (const id of members) {
      if (this.states.has(id)) this.change(id, { attributes: { group_members: members } });
    }
  }

  /* ── Music Assistant browsing ───────────────────────────────────────────*/

  /**
   * Seed the library.
   *
   * `count` items of `media` are generated with artwork URLs pointing at
   * `artBase`, so a test can assert those URLs never reach the panel.
   */
  seedLibrary(media, count, { artBase = 'http://music-assistant.local:8095/img' } = {}) {
    const items = [];
    for (let i = 0; i < count; i += 1) {
      const item = {
        media_type: media,
        uri: `library://${media}/${i}`,
        name: `${media} ${String(i).padStart(3, '0')}`,
        version: '',
        image: `${artBase}/${media}-${i}.jpg`,
        favorite: i % 4 === 0,
        explicit: false,
      };
      if (media === 'track' || media === 'album') {
        item.artists = [{ media_type: 'artist', uri: `library://artist/${i}`, name: `Artist ${i}` }];
      }
      if (media === 'track') {
        item.album = { media_type: 'album', uri: `library://album/${i}`, name: `Album ${i}` };
      }
      items.push(item);
    }
    this.maLibrary.set(media, items);
  }

  /** Register an entity with the entity registry, owned by a config entry. */
  seedRegistry(entityId, configEntryId = this.maConfigEntry) {
    this.registry.set(entityId, {
      entity_id: entityId,
      config_entry_id: configEntryId,
      platform: 'music_assistant',
      unique_id: `${entityId}-uid`,
    });
  }

  /** Answer one of Music Assistant's response-only services. */
  #musicAssistant(msg) {
    const data = msg.service_data ?? {};

    if (msg.service === 'get_queue') {
      const target = msg.target?.entity_id;
      const id = Array.isArray(target) ? target[0] : target;
      const queue = this.maQueues.get(id);
      if (!queue) {
        return { ok: false, error: { code: 'not_found', message: 'No queue for that player' } };
      }
      // A platform entity service answers keyed by entity id.
      return { ok: true, response: { [id]: queue } };
    }

    // Both library services are config-entry targeted, and HA rejects an
    // unknown entry — which is what makes the discovery step load-bearing.
    if (data.config_entry_id !== this.maConfigEntry) {
      return {
        ok: false,
        error: { code: 'not_found', message: 'Config entry not found or not loaded' },
      };
    }

    if (msg.service === 'get_library') {
      const all = this.maLibrary.get(data.media_type) ?? [];
      const filtered = data.favorite ? all.filter((x) => x.favorite) : all;
      const ordered =
        data.order_by === 'last_played_desc' ? [...filtered].reverse() : filtered;
      const offset = data.offset ?? 0;
      const limit = data.limit ?? 25;
      return {
        ok: true,
        response: {
          items: ordered.slice(offset, offset + limit),
          limit,
          offset,
          order_by: data.order_by ?? 'name',
          media_type: data.media_type,
        },
      };
    }

    // search
    const needle = String(data.name ?? '').toLowerCase();
    const limit = data.limit ?? 5;
    const matching = (media) =>
      (this.maLibrary.get(media) ?? [])
        .filter((x) => x.name.toLowerCase().includes(needle))
        .slice(0, limit);
    return {
      ok: true,
      response: {
        artists: matching('artist'),
        albums: matching('album'),
        tracks: matching('track'),
        playlists: matching('playlist'),
        radio: matching('radio'),
        audiobooks: [],
        podcasts: [],
      },
    };
  }

  /** Seed an entity before any client subscribes. */
  seed(id, s, attributes = {}) {
    const t = Date.now() / 1000;
    this.states.set(id, { s, a: attributes, lc: t, lu: t });
  }

  /**
   * Change an entity and push the diff, exactly as HA would: only changed
   * attributes under `+`, removed attribute NAMES under `-`.
   */
  change(id, { state, attributes, removeAttributes } = {}) {
    const prev = this.states.get(id);
    if (!prev) throw new Error(`mock-ha: unknown entity ${id}`);

    const t = Date.now() / 1000;
    const additions = {};

    if (state !== undefined && state !== prev.s) {
      additions.s = state;
      prev.s = state;
      prev.lc = t;
      prev.lu = t;
      additions.lc = t;
    } else {
      prev.lu = t;
      additions.lu = t;
    }

    if (attributes) {
      additions.a = { ...attributes };
      Object.assign(prev.a, attributes);
    }

    const diff = { '+': additions };

    if (removeAttributes?.length) {
      diff['-'] = { a: [...removeAttributes] };
      for (const key of removeAttributes) delete prev.a[key];
    }

    this.#broadcastEvent({ c: { [id]: diff } });
  }

  /** Remove an entity. NOTE the key is `r`, not `d`. */
  remove(id) {
    this.states.delete(id);
    this.#broadcastEvent({ r: [id] });
  }

  /**
   * Push several changes in one go. With coalescing on this goes out as a
   * single JSON ARRAY frame — the case that silently breaks a client which
   * assumes one message per frame.
   */
  burst(changes) {
    const frames = changes.map((c) => {
      const prev = this.states.get(c.id);
      const t = Date.now() / 1000;
      const additions = {};
      if (c.state !== undefined && c.state !== prev.s) {
        additions.s = c.state;
        prev.s = c.state;
        prev.lc = t;
        prev.lu = t;
        additions.lc = t;
      }
      if (c.attributes) {
        additions.a = { ...c.attributes };
        Object.assign(prev.a, c.attributes);
      }
      return { c: { [c.id]: { '+': additions } } };
    });

    for (const ws of this.#sockets) {
      const messages = frames.map((event) => ({ id: 2, type: 'event', event }));
      if (this.coalesce) {
        ws.send(JSON.stringify(messages));
      } else {
        for (const m of messages) ws.send(JSON.stringify(m));
      }
    }
  }

  #broadcastEvent(event) {
    const frame = JSON.stringify({ id: 2, type: 'event', event });
    for (const ws of this.#sockets) ws.send(frame);
  }

  /** Drop all connections without closing the server — simulates a restart. */
  dropConnections() {
    for (const ws of this.#sockets) ws.terminate();
    this.#sockets.clear();
  }

  get connectionCount() {
    return this.#sockets.size;
  }

  async stop() {
    if (!this.#wss) return;
    for (const ws of this.#sockets) ws.terminate();
    this.#sockets.clear();
    await new Promise((resolve) => this.#wss.close(resolve));
    this.#wss = null;
  }
}
