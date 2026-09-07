import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';

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
  #http;
  #port;
  #sockets = new Set();

  /** entity_id → { s, a, lc, lu } with timestamps in SECONDS, as HA uses. */
  states = new Map();

  /** Every call_service message received, for assertions. */
  serviceCalls = [];

  /** Every conversation/process message received, for assertions. */
  conversations = [];

  /** Response text for conversation/process. */
  conversationSpeech = 'Done';

  /** Every assist_pipeline/run message received, for assertions. */
  assistPipelineRuns = [];

  /** Raw PCM chunks received for assist_pipeline/run, without the handler byte. */
  assistAudioChunks = [];

  /** Transcript returned by the mock STT stage. */
  assistTranscript = 'turn on the office lights';

  /** Generated TTS audio returned by the mock TTS proxy. */
  assistTtsAudio = Buffer.from('mock-tts-audio');

  /**
   * Every webhook POST received, as { id, body }.
   *
   * Webhooks are plain HTTP rather than WebSocket, which is why this mock
   * owns its HTTP server explicitly instead of letting `ws` create one.
   */
  webhooks = [];

  /** Set to true to reject the token instead of accepting it. */
  rejectAuth = false;

  /** Set false to send messages individually even when coalescing is on. */
  coalesce = true;

    constructor(port) {
    this.#port = port;
  }

  /** Restartable, so tests can simulate a full outage and a recovery. */
  async start() {
    this.#http = createServer((req, res) => this.#onRequest(req, res));
    this.#wss = new WebSocketServer({ server: this.#http });
    await new Promise((resolve) => this.#http.listen(this.#port, '127.0.0.1', resolve));

    this.#wss.on('connection', (ws) => {
      this.#sockets.add(ws);
      const session = {
        authed: false,
        subscriptionId: null,
        coalescing: false,
        pipeline: null,
      };

      ws.on('close', () => this.#sockets.delete(ws));
      ws.on('message', (data) => this.#onMessage(ws, session, data));

      ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.8.0' }));
    });
  }

  /**
   * Home Assistant's REST surface, to the extent anything here uses it.
   *
   * Only the REST surfaces the backend uses. Note the 200 for an unknown
   * webhook id: that is what Home Assistant really does — deliberately, so a
   * webhook id cannot be probed — which is why a webhook button that appears
   * to do nothing means a missing automation rather than a broken panel.
   */
  #onRequest(req, res) {
    if (req.method === 'GET' && /^\/api\/tts_proxy\/mock\.mp3/.test(req.url ?? '')) {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(this.assistTtsAudio);
      return;
    }

    const match = /^\/api\/webhook\/([^/?]+)/.exec(req.url ?? '');
    if (!match || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      this.webhooks.push({ id: match[1], body });
      res.writeHead(200).end();
    });
  }

  #onMessage(ws, session, data) {
    if (session.pipeline && Buffer.isBuffer(data)) {
      this.#onPipelineAudio(ws, session, data);
      return;
    }

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

      case 'call_service':
        this.serviceCalls.push(msg);

        // Behave like a real media player for grouping, so a test exercises the
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

      case 'conversation/process':
        this.conversations.push(msg);
        ws.send(JSON.stringify({
          id: msg.id,
          type: 'result',
          success: true,
          result: {
            conversation_id: msg.conversation_id ?? 'mock-conversation',
            response: {
              response_type: 'action_done',
              speech: {
                plain: {
                  speech: this.conversationSpeech,
                },
              },
              data: {
                success: [],
                failed: [],
              },
            },
          },
        }));
        break;

      case 'assist_pipeline/run':
        this.assistPipelineRuns.push(msg);
        if (msg.start_stage === 'intent') {
          ws.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result: null }));
          ws.send(JSON.stringify({
            id: msg.id,
            type: 'event',
            event: {
              type: 'intent-end',
              data: { intent_output: this.#intentOutput('mock-text-conversation') },
            },
          }));
          ws.send(JSON.stringify({
            id: msg.id,
            type: 'event',
            event: {
              type: 'tts-end',
              data: {
                tts_output: {
                  url: '/api/tts_proxy/mock.mp3',
                  mime_type: 'audio/mpeg',
                },
              },
            },
          }));
          ws.send(JSON.stringify({ id: msg.id, type: 'event', event: { type: 'run-end', data: {} } }));
          break;
        }

        session.pipeline = {
          id: msg.id,
          handler: 7,
          chunks: [],
          mode: msg.start_stage,
          endStage: msg.end_stage,
          finished: false,
        };
        ws.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result: null }));
        ws.send(JSON.stringify({
          id: msg.id,
          type: 'event',
          event: {
            type: 'run-start',
            data: {
              runner_data: {
                stt_binary_handler_id: 7,
                timeout: msg.timeout ?? 45,
              },
            },
          },
        }));
        if (msg.start_stage === 'wake_word') {
          ws.send(JSON.stringify({
            id: msg.id,
            type: 'event',
            event: {
              type: 'wake_word-start',
              data: {
                engine: 'mock-wake-word',
                metadata: { sample_rate: msg.input?.sample_rate },
              },
            },
          }));
          break;
        }
        ws.send(JSON.stringify({
          id: msg.id,
          type: 'event',
          event: {
            type: 'stt-start',
            data: {
              engine: 'mock-stt',
              metadata: { sample_rate: msg.input?.sample_rate },
            },
          },
        }));
        break;

      default:
        ws.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result: null }));
    }
  }

  #onPipelineAudio(ws, session, data) {
    const pipeline = session.pipeline;
    if (!pipeline) return;
    if (data[0] !== pipeline.handler) return;

    if (pipeline.mode === 'wake_word') {
      pipeline.chunks.push(Buffer.from(data.subarray(1)));
      const received = pipeline.chunks.reduce((total, chunk) => total + chunk.length, 0);
      if (!pipeline.finished && received >= 4096) {
        pipeline.finished = true;
        this.assistAudioChunks.push(...pipeline.chunks);
        const id = pipeline.id;
        const endStage = pipeline.endStage;
        session.pipeline = null;
        ws.send(JSON.stringify({
          id,
          type: 'event',
          event: {
            type: 'wake_word-end',
            data: {
              wake_word_output: {
                wake_word_id: 'okay_nabu',
                timestamp: 250,
              },
            },
          },
        }));
        this.#finishVoicePipeline(ws, id, 'mock-wake-conversation', endStage);
      }
      return;
    }

    if (data.length === 1) {
      this.assistAudioChunks.push(...pipeline.chunks);
      const id = pipeline.id;
      const endStage = pipeline.endStage;
      session.pipeline = null;
      this.#finishVoicePipeline(ws, id, 'mock-voice-conversation', endStage);
      return;
    }

    pipeline.chunks.push(Buffer.from(data.subarray(1)));
  }

  #finishVoicePipeline(ws, id, conversationId, endStage) {
    ws.send(JSON.stringify({
      id,
      type: 'event',
      event: {
        type: 'stt-end',
        data: { stt_output: { text: this.assistTranscript } },
      },
    }));
    if (endStage === 'stt') {
      ws.send(JSON.stringify({ id, type: 'event', event: { type: 'run-end', data: {} } }));
      return;
    }
    ws.send(JSON.stringify({
      id,
      type: 'event',
      event: {
        type: 'intent-end',
        data: {
          intent_output: this.#intentOutput(conversationId),
        },
      },
    }));
    ws.send(JSON.stringify({
      id,
      type: 'event',
      event: {
        type: 'tts-end',
        data: {
          tts_output: {
            url: '/api/tts_proxy/mock.mp3',
            mime_type: 'audio/mpeg',
          },
        },
      },
    }));
    ws.send(JSON.stringify({ id, type: 'event', event: { type: 'run-end', data: {} } }));
  }

  #intentOutput(conversationId) {
    return {
      conversation_id: conversationId,
      response: {
        response_type: 'action_done',
        speech: {
          plain: {
            speech: this.conversationSpeech,
          },
        },
        data: {
          success: [],
          failed: [],
        },
      },
    };
  }

  /** Compressed add form. `lu` is omitted when it equals `lc`, as HA does. */
  #compress(state) {
    const out = { s: state.s, a: state.a, c: '01ABCDEF', lc: state.lc };
    if (state.lu !== state.lc) out.lu = state.lu;
    return out;
  }

  /**
   * Seed a media player.
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
   * Apply a join/unjoin the way a media player does.
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
    if (this.#http) {
      await new Promise((resolve) => this.#http.close(resolve));
      this.#http = null;
    }
  }
}
