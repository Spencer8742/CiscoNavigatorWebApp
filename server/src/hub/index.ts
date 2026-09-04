import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import { logger } from '~/lib/log.ts';
import type { PanelAuth } from '~/http/auth.ts';
import type { ConfigStore } from '~/config/load.ts';
import type {
  BackendHealth,
  BrowseRequest,
  BrowseResult,
  KeyLightState,
  TvState,
  MassPlayer,
  MassQueue,
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
  /** Current Music Assistant players and queues, sent in `hello`. */
  getPlayers: () => { players: MassPlayer[]; queues: MassQueue[] };
  /** Run a Music Assistant command. Returns an error string, or null. */
  onMassCommand?: (command: string, args: unknown) => string | null;
  /** Current panel preferences, sent in `hello`. */
  getPrefs: () => PanelPrefs;
  /** Apply a preference change. Returns an error string, or null. */
  onPref?: (key: string, value: string) => string | null;
  /** Apply a player-layout change. Returns an error string, or null. */
  onLayout?: (layout: unknown) => string | null;
  /** Current Elgato Key Light states, sent in `hello`. */
  getKeyLights: () => KeyLightState[];
  getTvs: () => TvState[];
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
    const panel: Panel = { socket, alive: true, id: this.#seq };
    this.#panels.add(panel);

    const from = req.socket.remoteAddress ?? 'unknown';
    log.info(`Panel #${panel.id} connected from ${from} (${this.#panels.size} total)`);

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
      prefs: this.#deps.getPrefs(),
      players: music.players,
      queues: music.queues,
      keylights: this.#deps.getKeyLights(),
      tvs: this.#deps.getTvs(),
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
        const problem = this.#deps.onLayout(msg.layout);
        if (problem) {
          this.#send(panel, { t: 'error', ref: msg.id, code: 'layout_rejected', message: problem });
        }
        break;
      }

      case 'pref': {
        if (!this.#deps.onPref) return;
        const problem = this.#deps.onPref(msg.key, msg.value);
        if (problem) {
          this.#send(panel, { t: 'error', ref: msg.id, code: 'pref_rejected', message: problem });
        }
        // The broadcast is driven by the store's change event rather than
        // sent from here, so a panel that changes a preference and one that
        // merely observes it both learn about it the same way.
        break;
      }

      case 'mass': {
        if (!this.#deps.onMassCommand) {
          this.#send(panel, {
            t: 'error',
            ref: msg.id,
            code: 'mass_unavailable',
            message: 'Music Assistant is not configured',
          });
          return;
        }
        const problem = this.#deps.onMassCommand(msg.command, msg.args);
        if (problem) {
          this.#send(panel, { t: 'error', ref: msg.id, code: 'mass_failed', message: problem });
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

  broadcastPrefs(prefs: PanelPrefs): void {
    this.broadcast({ t: 'prefs', prefs });
  }

  broadcastPlayers(players: MassPlayer[], queues: MassQueue[]): void {
    this.broadcast({ t: 'players', players, queues });
  }

  broadcastKeyLights(lights: KeyLightState[]): void {
    this.broadcast({ t: 'keylights', lights });
  }

  broadcastTvs(tvs: TvState[]): void {
    this.broadcast({ t: 'tvs', tvs });
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
