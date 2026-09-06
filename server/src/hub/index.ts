import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import { logger } from '~/lib/log.ts';
import type { PanelAuth } from '~/http/auth.ts';
import type { ConfigStore } from '~/config/load.ts';
import { panelIdOf } from '@shared/protocol.ts';
import type {
  BackendHealth,
  AppleTvCommand,
  AppleTvSwipe,
  AppleTvState,
  BrowseRequest,
  BrowseResult,
  KeyLightState,
  TvState,
  Player,
  PlayerQueue,
  MusicCommand,
  MusicSource,
  ServiceLink,
  PanelPrefs,
  ClientMessage,
  EntityState,
  ServerMessage,
  StatePatch,
} from '@shared/protocol.ts';
import type { KeyLightOp } from '@shared/config.ts';

const log = logger('hub');

/**
 * The panel hub: every connected Navigator's WebSocket.
 *
 * Responsibilities, in order of importance:
 *
 * 1. **Send a complete snapshot on connect.** The first frame a panel
 *    receives is `hello`, carrying the config, all entity states and current
 *    link health. This is what makes reconnection invisible: no auth round
 *    trip, no follow-up requests, one frame and the screen is correct. It
 *    matters more than it sounds, because RoomOS wipes the device's storage
 *    daily and the panel reconnects from scratch every morning.
 *
 * 2. **Fan out diffs.** One JSON serialisation per patch, reused across every
 *    connected panel, rather than serialising per socket.
 *
 * 3. **Never let a slow or dead panel affect anything else.** Sends are
 *    guarded, failures close that socket only, and a panel that stops
 *    responding to pings is dropped rather than accumulating a send buffer.
 */

export interface HubDeps {
  auth: PanelAuth;
  config: ConfigStore;
  /** Current entity states, owned by the HA store (phase 2). */
  getStates: () => Record<string, EntityState>;
  getHealth: () => BackendHealth;
  /** Handle a service call from a panel. Returns an error string, or null. */
  onCall?: (msg: Extract<ClientMessage, { t: 'call' }>) => Promise<string | null>;
  /** Supply the next batch of slideshow photos (phase 6). */
  onPhotos?: (count: number) => Promise<ServerMessage | null>;
  /** Answer a music browse request, or throw with a user-visible reason. */
  onBrowse?: (req: BrowseRequest) => Promise<BrowseResult>;
  /** Current speakers and queues, sent in `hello`. */
  getPlayers: () => { players: Player[]; queues: PlayerQueue[] };
  /**
   * Drive a speaker. Returns an error string, or null.
   *
   * Carries a verb rather than an upstream command name, which is what makes
   * "no other action exists" a property of the wire format rather than of an
   * allow-list somebody has to keep complete. See `MusicCommand`.
   */
  onMusic?: (cmd: MusicCommand) => Promise<string | null>;
  /** This panel's preferences, sent in `hello`. */
  getPrefs: (panelId: string | null) => PanelPrefs;
  /** Apply a preference change, for the panel that asked. */
  onPref?: (key: string, value: unknown, panelId: string | null) => string | null;
  /** Apply a player-layout change, for the panel that asked. */
  onLayout?: (layout: unknown, panelId: string | null) => string | null;
  /** Current Elgato Key Light states, sent in `hello`. */
  getKeyLights: () => KeyLightState[];
  getTvs: () => TvState[];
  getAppleTvs: () => AppleTvState[];
  onAppleTv?: (device: string, op: AppleTvCommand) => Promise<string | null>;
  onAppleTvSwipe?: (device: string, gesture: AppleTvSwipe) => Promise<string | null>;
  onAppleTvApp?: (device: string, app: string) => Promise<string | null>;
  onAppleTvPair?: (device: string, op: 'begin' | 'pin' | 'cancel', pin?: string) => Promise<string | null>;
  /** Music services the household has, sent in `hello`. */
  getSources: () => MusicSource[];
  /**
   * Connect or disconnect a music service.
   *
   * Separate from `onMusic` because it is not a speaker command: nothing here
   * reaches a speaker, and the thing it changes is a stored credential.
   */
  onLink?: (sid: number, op: 'begin' | 'poll' | 'forget') => Promise<ServiceLink>;
  /** Run a macro button by id. Returns an error string, or null. */
  onControl?: (button: string) => Promise<string | null>;
  /** Drive a key light. Returns an error string, or null. */
  onKeyLight?: (light: string, op: KeyLightOp, value?: number) => Promise<string | null>;
  /** Choose an input on a `sources:` key. Returns an error string, or null. */
  onSource?: (item: string, value: string) => Promise<string | null>;
}

interface Panel {
  socket: WebSocket;
  /** Set by the pong handler; cleared before each ping sweep. */
  alive: boolean;
  id: number;
  /**
   * Which panel this is, from `?panel=` on its socket URL, or null when it
   * did not say. Null is a working state, not a degraded one — it means the
   * shared defaults, which is how every panel behaved before this existed.
   */
  panelId: string | null;
}

export class Hub {
  readonly #wss: WebSocketServer;
  readonly #deps: HubDeps;
  readonly #panels = new Set<Panel>();
  #sweep: ReturnType<typeof setInterval> | undefined;
  #seq = 0;

  constructor(server: Server, deps: HubDeps) {
    this.#deps = deps;

    // noServer: we own the upgrade handshake so we can reject unauthenticated
    // upgrades before any WebSocket state is allocated.
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

    server.on('upgrade', (req, socket, head) => {
      const url = req.url ?? '';
      if (!url.startsWith('/ws')) {
        socket.destroy();
        return;
      }
      if (!deps.auth.check(req)) {
        log.warn('Rejected unauthenticated WebSocket upgrade');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws, req));
    });

    // Push config changes to every panel. No reload — the panel applies the
    // new config to its signals and the affected parts of the UI update.
    deps.config.onChange((cfg) => {
      this.broadcast({ t: 'config', config: cfg });
    });

    this.#startSweep();
  }

  get panelCount(): number {
    return this.#panels.size;
  }

  #accept(socket: WebSocket, req: IncomingMessage): void {
    this.#seq += 1;
    const panel: Panel = { socket, alive: true, id: this.#seq, panelId: panelIdFrom(req.url) };
    this.#panels.add(panel);

    const from = req.socket.remoteAddress ?? 'unknown';
    const who = panel.panelId ? `"${panel.panelId}"` : 'unnamed';
    log.info(`Panel #${panel.id} (${who}) connected from ${from} (${this.#panels.size} total)`);

    socket.on('pong', () => {
      panel.alive = true;
    });

    socket.on('message', (data) => void this.#onMessage(panel, data));

    socket.on('close', () => {
      this.#panels.delete(panel);
      log.info(`Panel #${panel.id} disconnected (${this.#panels.size} remaining)`);
    });

    socket.on('error', (err) => {
      log.warn(`Panel #${panel.id} socket error:`, err);
      // 'close' always follows; cleanup happens there.
    });

    // The snapshot. Everything the panel needs to paint, in one frame.
    const music = this.#deps.getPlayers();
    this.#send(panel, {
      t: 'hello',
      config: this.#deps.config.current,
      states: this.#deps.getStates(),
      health: this.#deps.getHealth(),
      now: Date.now(),
      prefs: this.#deps.getPrefs(panel.panelId),
      players: music.players,
      queues: music.queues,
      keylights: this.#deps.getKeyLights(),
      tvs: this.#deps.getTvs(),
      appleTvs: this.#deps.getAppleTvs(),
      sources: this.#deps.getSources(),
    });
  }

  async #onMessage(panel: Panel, data: RawData): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString()) as ClientMessage;
    } catch {
      // Malformed input is not worth tearing down a working socket over.
      log.debug(`Panel #${panel.id} sent unparseable data`);
      return;
    }

    switch (msg.t) {
      case 'ping':
        this.#send(panel, { t: 'pong', ref: msg.id });
        break;

      case 'layout': {
        if (!this.#deps.onLayout) return;
        const problem = this.#deps.onLayout(msg.layout, panel.panelId);
        if (problem) {
          this.#send(panel, { t: 'error', ref: msg.id, code: 'layout_rejected', message: problem });
        }
        break;
      }

      case 'pref': {
        if (!this.#deps.onPref) return;
        const problem = this.#deps.onPref(msg.key, msg.value, panel.panelId);
        if (problem) {
          this.#send(panel, { t: 'error', ref: msg.id, code: 'pref_rejected', message: problem });
        }
        // The broadcast is driven by the store's change event rather than
        // sent from here, so a panel that changes a preference and one that
        // merely observes it both learn about it the same way.
        break;
      }

      case 'music': {
        if (!this.#deps.onMusic) {
          this.#send(panel, {
            t: 'error',
            ref: msg.id,
            code: 'music_unavailable',
            message: 'No music system is configured',
          });
          return;
        }
        const problem = await this.#deps.onMusic(msg.cmd);
        if (problem) {
          this.#send(panel, { t: 'error', ref: msg.id, code: 'music_failed', message: problem });
        }
        break;
      }

      case 'apple-tv': {
        if (!this.#deps.onAppleTv) return;
        const problem = await this.#deps.onAppleTv(msg.appleTv, msg.op);
        if (problem) this.#send(panel, { t: 'error', ref: msg.id, code: 'apple_tv_failed', message: problem });
        break;
      }

      case 'apple-tv-swipe': {
        if (!this.#deps.onAppleTvSwipe) return;
        const problem = await this.#deps.onAppleTvSwipe(msg.appleTv, msg);
        if (problem) this.#send(panel, { t: 'error', ref: msg.id, code: 'apple_tv_swipe_failed', message: problem });
        break;
      }

      case 'apple-tv-app': {
        if (!this.#deps.onAppleTvApp) return;
        const problem = await this.#deps.onAppleTvApp(msg.appleTv, msg.app);
        if (problem) this.#send(panel, { t: 'error', ref: msg.id, code: 'apple_tv_app_failed', message: problem });
        break;
      }

      case 'apple-tv-pair': {
        if (!this.#deps.onAppleTvPair) return;
        const problem = await this.#deps.onAppleTvPair(msg.appleTv, msg.op, msg.pin);
        if (problem) this.#send(panel, { t: 'error', ref: msg.id, code: 'apple_tv_pair_failed', message: problem });
        break;
      }

      case 'link': {
        if (!this.#deps.onLink) {
          this.#send(panel, {
            t: 'error',
            ref: msg.id,
            code: 'link_unavailable',
            message: 'No music system is configured',
          });
          return;
        }
        /*
         * A link is the one panel request that can take minutes: somebody has
         * to pick up a phone. So each poll is its own request/reply and the
         * backend holds nothing open — a socket that dropped halfway through
         * costs the person one more tap, not a stuck flow.
         */
        try {
          const link = await this.#deps.onLink(msg.sid, msg.op);
          this.#send(panel, { t: 'link', ref: msg.id, link });
        } catch (err) {
          this.#send(panel, {
            t: 'error',
            ref: msg.id,
            code: 'link_failed',
            message: err instanceof Error ? err.message : 'That did not work',
          });
        }
        break;
      }

      case 'call': {
        if (!this.#deps.onCall) {
          this.#send(panel, {
            t: 'error',
            ref: msg.id,
            code: 'ha_unavailable',
            message: 'Home Assistant is not configured',
          });
          return;
        }
        const error = await this.#deps.onCall(msg);
        if (error) {
          this.#send(panel, { t: 'error', ref: msg.id, code: 'call_failed', message: error });
        }
        break;
      }

      case 'control': {
        if (!this.#deps.onControl) return;
        const problem = await this.#deps.onControl(msg.button);
        if (problem) {
          this.#send(panel, { t: 'error', ref: msg.id, code: 'control_failed', message: problem });
        }
        break;
      }

      case 'keylight': {
        if (!this.#deps.onKeyLight) return;
        const problem = await this.#deps.onKeyLight(msg.light, msg.op, msg.value);
        if (problem) {
          this.#send(panel, { t: 'error', ref: msg.id, code: 'keylight_failed', message: problem });
        }
        break;
      }

      case 'source': {
        if (!this.#deps.onSource) return;
        const problem = await this.#deps.onSource(msg.item, msg.value);
        if (problem) {
          this.#send(panel, { t: 'error', ref: msg.id, code: 'source_failed', message: problem });
        }
        break;
      }

      case 'photos': {
        if (!this.#deps.onPhotos) {
          this.#send(panel, { t: 'photos', photos: [] });
          return;
        }
        const reply = await this.#deps.onPhotos(msg.count);
        if (reply) this.#send(panel, reply);
        break;
      }

      case 'browse': {
        if (!this.#deps.onBrowse) {
          this.#send(panel, {
            t: 'error',
            ref: msg.id,
            code: 'browse_failed',
            message: 'Music browsing is not available',
          });
          return;
        }
        try {
          const result = await this.#deps.onBrowse(msg.req);
          this.#send(panel, { t: 'browse', ref: msg.id, result });
        } catch (err) {
          // A browse always gets an answer of some kind: the panel is showing
          // a spinner and has no other way to learn the request died.
          const message = err instanceof Error ? err.message : 'Could not load';
          this.#send(panel, { t: 'error', ref: msg.id, code: 'browse_failed', message });
        }
        break;
      }
    }
  }

  /* ── Outbound ──────────────────────────────────────────────────────────*/

  /** Serialise once, send to all. */
  broadcast(msg: ServerMessage): void {
    if (this.#panels.size === 0) return;
    const frame = JSON.stringify(msg);
    for (const panel of this.#panels) {
      this.#raw(panel, frame);
    }
  }

  broadcastPatch(patch: StatePatch): void {
    if (!patch.add && !patch.chg && !patch.del) return;
    this.broadcast({ t: 'patch', patch });
  }

  broadcastHealth(health: BackendHealth): void {
    this.broadcast({ t: 'health', health });
  }

  /**
   * Send every connected panel the preferences that apply to IT.
   *
   * Not a broadcast: two panels resolve the same file to different answers.
   * Every panel is told on every change rather than only the ones whose scope
   * was touched, because a change to the shared block reaches any panel that
   * has not overridden that key — and deciding which those are is exactly the
   * resolution the store already does. Asking it per panel cannot drift from
   * what a fresh connection would receive.
   */
  refreshPrefs(): void {
    for (const panel of this.#panels) {
      this.#send(panel, { t: 'prefs', prefs: this.#deps.getPrefs(panel.panelId) });
    }
  }

  broadcastPlayers(players: Player[], queues: PlayerQueue[]): void {
    this.broadcast({ t: 'players', players, queues });
  }

  broadcastSources(sources: MusicSource[]): void {
    this.broadcast({ t: 'sources', sources });
  }

  broadcastKeyLights(lights: KeyLightState[]): void {
    this.broadcast({ t: 'keylights', lights });
  }

  broadcastTvs(tvs: TvState[]): void {
    this.broadcast({ t: 'tvs', tvs });
  }

  broadcastAppleTvs(appleTvs: AppleTvState[]): void {
    this.broadcast({ t: 'apple-tvs', appleTvs });
  }

  #send(panel: Panel, msg: ServerMessage): void {
    this.#raw(panel, JSON.stringify(msg));
  }

  #raw(panel: Panel, frame: string): void {
    if (panel.socket.readyState !== WebSocket.OPEN) return;
    try {
      panel.socket.send(frame);
    } catch (err) {
      log.warn(`Send to panel #${panel.id} failed:`, err);
      panel.socket.terminate();
      this.#panels.delete(panel);
    }
  }

  /* ── Liveness ──────────────────────────────────────────────────────────
     Protocol-level ping/pong, separate from the application heartbeat the
     panel sends. This one catches panels that have gone away without a close
     frame — a Navigator that lost Wi-Fi, or whose web view RoomOS terminated
     for exceeding its memory budget. Without it, dead sockets accumulate in
     a process that is meant to run for months. */

  #startSweep(): void {
    this.#sweep = setInterval(() => {
      for (const panel of this.#panels) {
        if (!panel.alive) {
          log.info(`Panel #${panel.id} failed liveness check — terminating`);
          panel.socket.terminate();
          this.#panels.delete(panel);
          continue;
        }
        panel.alive = false;
        try {
          panel.socket.ping();
        } catch {
          panel.socket.terminate();
          this.#panels.delete(panel);
        }
      }
    }, 30_000);
  }

  close(): void {
    clearInterval(this.#sweep);
    for (const panel of this.#panels) panel.socket.close(1001, 'server shutting down');
    this.#panels.clear();
    this.#wss.close();
  }
}

/**
 * The panel id on a socket URL, or null.
 *
 * The id rides in the query string for the same reason the token does: the
 * browser WebSocket API cannot set request headers, and RoomOS reloads the
 * provisioned URL and nothing else.
 */
function panelIdFrom(url: string | undefined): string | null {
  const q = (url ?? '').indexOf('?');
  if (q === -1) return null;
  return panelIdOf(new URLSearchParams((url ?? '').slice(q + 1)).get('panel'));
}
