import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath, URL } from 'node:url';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEnv } from '~/env.ts';
import { logger } from '~/lib/log.ts';
import { ConfigStore } from '~/config/load.ts';
import { StaticFiles } from '~/http/static.ts';
import { applySecurityHeaders } from '~/http/headers.ts';
import { PanelAuth } from '~/http/auth.ts';
import { ArtworkProxy } from '~/http/artwork.ts';
import { MediaArt } from '~/http/media-art.ts';
import { Hub } from '~/hub/index.ts';
import { HaClient } from '~/ha/client.ts';
import { HaStore, isEmptyPatch } from '~/ha/store.ts';
import { ServiceGuard } from '~/ha/services.ts';
import { MassClient } from '~/mass/client.ts';
import { MassStore } from '~/mass/store.ts';
import { MassCommands } from '~/mass/commands.ts';
import { MassBrowser } from '~/mass/browse.ts';
import { PrefsStore } from '~/config/prefs.ts';
import { ImmichClient } from '~/immich/client.ts';
import { ImmichImages } from '~/immich/images.ts';
import { Playlist } from '~/immich/playlist.ts';
import type { BackendHealth } from '@shared/protocol.ts';

const log = logger('server');

const VERSION = process.env['APP_VERSION'] ?? 'dev';
const STARTED_AT = Date.now();

/** One second of 8 kHz mono silence, as a WAV. See the /silence.wav route. */
const SILENCE = silentWav(8000);

function silentWav(samples: number): Buffer {
  const buf = Buffer.alloc(44 + samples);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); // PCM header size
  buf.writeUInt16LE(1, 20); // format: PCM
  buf.writeUInt16LE(1, 22); // channels: mono
  buf.writeUInt32LE(samples, 24); // sample rate
  buf.writeUInt32LE(samples, 28); // byte rate (8-bit mono = rate)
  buf.writeUInt16LE(1, 32); // block align
  buf.writeUInt16LE(8, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(samples, 40);
  // 8-bit PCM is unsigned: silence is 128, not 0.
  buf.fill(128, 44);
  return buf;
}

/**
 * Backend entry point.
 *
 * Wires: environment, config (with hot reload), static serving, the panel
 * WebSocket hub, the Home Assistant bridge, and health reporting. The Immich
 * client (phase 6) plugs into the remaining `HubDeps` hook without changing
 * anything else here.
 */

async function main(): Promise<void> {
  const env = loadEnv();

  const config = new ConfigStore(env.configPath);
  const loaded = await config.load();
  if (!loaded) {
    log.warn(
      `No usable config at ${config.path}. Starting with defaults — ` +
        'copy config/dashboard.example.yaml to get going.',
    );
  }
  config.watch();

  const auth = new PanelAuth(env.panelToken);
  const artwork = new ArtworkProxy(env.ha);
  const mediaArt = new MediaArt();

  /* ── Immich ──────────────────────────────────────────────────────────────
     The playlist holds the slideshow position server-side, so RoomOS wiping
     the panel's storage overnight does not restart the slideshow. */
  const immich = new ImmichClient(env.immich);
  const immichImages = new ImmichImages(env.immich);
  const playlist = new Playlist(immich, config.current);

  /** Liveness for the health report, refreshed on a slow timer. */
  let immichReachable = false;
  let lastImmichError: string | null = null;

  /**
   * Publish the current Immich status if it has changed.
   *
   * Called after every Immich interaction, not just the slow poll — a
   * slideshow refill that fails at 03:00 should light up the panel then,
   * rather than up to a minute later when the timer next fires.
   */
  const noteImmichStatus = (ok: boolean): void => {
    const err = immich.lastError?.message ?? null;
    // Re-publish when the *reason* changes too, not only the up/down bit:
    // going from a bad API key to a bad album id keeps health "disconnected"
    // while completely changing what the user has to go and fix.
    if (ok === immichReachable && err === lastImmichError) return;
    immichReachable = ok;
    lastImmichError = err;
    log.info(`Immich link: ${ok ? 'connected' : `disconnected — ${err ?? 'unknown'}`}`);
    hub.broadcastHealth(getHealth());
  };

  if (env.immich.enabled) {
    const pingImmich = async (): Promise<void> => {
      noteImmichStatus(await immich.ping());
    };
    void pingImmich();
    // Slow on purpose: Immich is used on demand, so this only feeds the
    // Settings screen. A tight poll would be pure noise.
    setInterval(() => void pingImmich(), 60_000).unref();
  }

  const panelRoot = resolvePanelRoot();
  log.info(`Serving panel from ${panelRoot}`);
  const files = new StaticFiles(panelRoot);

  /* ── Home Assistant bridge ───────────────────────────────────────────────
     The store is constructed before the client so it is ready to absorb the
     first snapshot, which arrives within milliseconds of authenticating. */

  const prefs = new PrefsStore(env.configPath);

  const store = new HaStore(config.current);

  /** Pending "we have genuinely lost touch" timer. See onStateChange below. */
  let unavailableTimer: ReturnType<typeof setTimeout> | undefined;

  const getHealth = (): BackendHealth => ({
    ha: env.ha.enabled ? haClient.state : 'disconnected',
    immich: env.immich.enabled ? (immichReachable ? 'connected' : 'disconnected') : 'disconnected',
    immichError: env.immich.enabled ? (immich.lastError?.message ?? null) : null,
    mass: env.mass.enabled ? massClient.state : 'disabled',
    massError: env.mass.enabled ? massClient.lastError : null,
    haLastMessage: haClient.lastMessageAt ? new Date(haClient.lastMessageAt).toISOString() : null,
    uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
    version: VERSION,
  });

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  const haClient = new HaClient(env.ha, {
    onEntityEvent(event) {
      const patch = store.apply(event);
      if (!isEmptyPatch(patch)) hub.broadcastPatch(patch);
    },

    onResubscribe() {
      // The whole world is about to be re-sent. Tell the store so it diffs
      // rather than repaints — see ha/store.ts.
      store.beginResync();
    },

    onStateChange(state) {
      log.info(`Home Assistant link: ${state}`);

      /*
       * Losing the link does NOT immediately grey out the dashboard.
       *
       * Home Assistant restarting for an update is a ten-to-thirty second
       * event that happens regularly. Marking every entity unavailable the
       * instant the socket drops would make each of those a visible,
       * full-screen flicker: everything greys out, then everything repaints.
       * It also defeats the resync diff in ha/store.ts entirely — if we mark
       * everything unavailable on the way down, then every entity genuinely
       * differs on the way back up and the "diff" is a full repaint.
       *
       * So: keep showing last-known state, and let the connection indicator
       * carry the honest signal that we are not currently in touch. Only
       * after the grace period — when this has stopped being a blip and
       * started being an outage — do we admit we no longer know, because at
       * that point continuing to claim a light is on would be a lie the user
       * might act on.
       */
      if (state === 'connected') {
        clearTimeout(unavailableTimer);
        unavailableTimer = undefined;
      } else if (unavailableTimer === undefined) {
        unavailableTimer = setTimeout(() => {
          unavailableTimer = undefined;
          log.warn(
            `Home Assistant unreachable for ${env.ha.unavailableGraceMs}ms — ` +
              'marking entities unavailable',
          );
          const patch = store.markUnavailable();
          if (!isEmptyPatch(patch)) hub.broadcastPatch(patch);
        }, env.ha.unavailableGraceMs);
      }

      hub.broadcastHealth(getHealth());
    },
  });

  // A preference set on one panel appears on every other one immediately.
  prefs.onChange((next) => hub.broadcastPrefs(next));

  const services = new ServiceGuard(haClient, store);

  /* ── Music Assistant ─────────────────────────────────────────────────────
     A second connection, and the only one this app opens besides Home
     Assistant. It is here because the music half of a wall panel — the queue,
     the library, real-time queue changes — is simply not in the slice of
     Music Assistant that Home Assistant exposes. See mass/client.ts. */

  const massClient = new MassClient(env.mass, {
    onEvent(event) {
      massStore.apply(event);
    },

    onReady() {
      // Refetch on every (re)connect rather than trusting what we held: while
      // the link was down the house kept playing, and a stale queue on a wall
      // is worse than a blank one.
      void massStore.refresh();
    },

    onStateChange(state) {
      log.info(`Music Assistant link: ${state}`);
      // Unlike Home Assistant, there is no grace period here. A speaker whose
      // state we cannot verify should stop claiming to be playing, and there
      // is no equivalent of "the light is probably still on".
      if (state !== 'connected') massStore.clear();
      hub.broadcastHealth(getHealth());
    },
  });

  const massStore = new MassStore(massClient, mediaArt, {
    onChange(players, queues) {
      hub.broadcastPlayers(players, queues);
    },
  });

  const massCommands = new MassCommands(massClient, massStore);
  const massBrowser = new MassBrowser(massClient, massStore, mediaArt);

  const hub = new Hub(server, {
    auth,
    config,
    getStates: () => store.snapshot(),
    getHealth,
    onCall: (msg) =>
      services.call({
        domain: msg.domain,
        service: msg.service,
        entity: msg.entity,
        data: msg.data,
      }),

    getPrefs: () => prefs.current,
    onPref: (key, value) => prefs.set(key, value),
    onLayout: (layout) => prefs.setLayout(layout, config.current.media.sections),

    getPlayers: () => massStore.snapshot(),
    onMassCommand: (command, args) => massCommands.run(command, args),
    onBrowse: (req) => massBrowser.browse(req),

    onPhotos: async (count) => {
      const photos = await playlist.take(count);
      // The refill that just ran is the most authoritative signal we have
      // about Immich, and it is the one the user is actually waiting on.
      if (env.immich.enabled) noteImmichStatus(immich.lastError === null);
      return { t: 'photos', photos };
    },
  });

  // A config edit changes which entities are visible. The store already holds
  // every entity Home Assistant knows about, so newly referenced ones can be
  // pushed immediately rather than waiting for them to change state.
  config.onChange((cfg) => {
    const patch = store.setConfig(cfg);
    if (!isEmptyPatch(patch)) hub.broadcastPatch(patch);
    playlist.setConfig(cfg);
  });

  haClient.start();
  massClient.start();

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? '/';
    const path = rawUrl.split('?')[0] ?? '/';

    /*
     * Cast mode relaxes exactly one thing: the CSP gains gstatic.com, because
     * holding a Nest Hub's screen requires Google's receiver SDK and that is
     * the only place it is served from. Keyed off the URL the device was
     * given, so an ordinary page load — and the Navigator — never sees it.
     */
    const q = rawUrl.indexOf('?');
    const query = new URLSearchParams(q === -1 ? '' : rawUrl.slice(q + 1));
    applySecurityHeaders(res, query.get('cast') === '1');

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }

    /*
     * /api/health is deliberately UNAUTHENTICATED and deliberately minimal.
     * It is the Docker healthcheck target, so it must work before any panel
     * has connected and must not require a token that a healthcheck would
     * have to be given. It exposes only liveness — no config, no entity
     * names, no versions of upstream services.
     */
    if (path === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, uptime: getHealth().uptime, panels: hub.panelCount }));
      return;
    }

    // Everything else under /api requires the panel token.
    if (path.startsWith('/api/') && !auth.check(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    /*
     * A second of silence, for cast mode's optional audio keep-alive.
     *
     * Generated rather than committed: it is 8 KB of zeroes and a 44-byte
     * header, and a binary blob in the repo that nobody can diff is worse
     * than four lines that say exactly what it is.
     */
    if (path === '/silence.wav') {
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': String(SILENCE.length),
        'cache-control': 'public, max-age=31536000, immutable',
      });
      res.end(req.method === 'HEAD' ? undefined : SILENCE);
      return;
    }

    if (path === '/api/config') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(config.current));
      return;
    }

    /*
     * Home Assistant media artwork.
     *
     * Authenticated like any other API route — note that this is reached via
     * an <img src>, and browsers do not attach Authorization headers to those,
     * so the panel appends ?t=<token>. PanelAuth accepts both forms.
     */
    /*
     * Cover art for browsing. `?k=` is a key this backend minted from a URL
     * Music Assistant gave us — the panel cannot name a URL. See
     * http/media-art.ts for why that distinction is the whole design.
     */
    if (path === '/img/art') {
      if (!auth.check(req)) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
      await mediaArt.serve(res, query.get('k'));
      return;
    }

    if (path === '/img/ha') {
      if (!auth.check(req)) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
      const p = query.get('p');
      if (!p) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('missing p');
        return;
      }
      await artwork.serve(req, res, p);
      return;
    }

    /*
     * Immich images. `/img/<asset-uuid>?s=grid|full`.
     *
     * The panel cannot name an Immich size here — see immich/images.ts. `s`
     * maps onto `thumbnail` and `preview` only, so there is no request the
     * panel can make that pulls a full-resolution original onto a device
     * that gets killed for using too much memory.
     */
    if (path.startsWith('/img/')) {
      if (!auth.check(req)) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
      const assetId = path.slice('/img/'.length);
      await immichImages.serve(req, res, assetId, query.get('s'));
      return;
    }

    await files.serve(req, res, path);
  }

  /*
   * A listen failure is unrecoverable, and must be FATAL.
   *
   * The process-level uncaughtException handler further down deliberately
   * keeps the backend alive through unexpected errors — one bad request must
   * never take every panel in the house down. But it would also swallow
   * EADDRINUSE, leaving a process that is running, healthy-looking to
   * `docker ps`, and bound to nothing. Docker's restart policy would never
   * fire because nothing crashed.
   *
   * Exiting instead means the container restarts, the healthcheck reports it,
   * and the log says which port. A port clash is a realistic first-run
   * problem on a NAS already running a dozen containers.
   */
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.error(
        `Port ${env.port} is already in use on ${env.host}. ` +
          'Another container or service has it — change PORT, or stop the other one.',
      );
    } else if (err.code === 'EACCES') {
      log.error(`Not permitted to bind ${env.host}:${env.port}.`);
    } else {
      log.error('HTTP server error:', err);
    }
    process.exit(1);
  });

  server.on('clientError', (err, socket) => {
    // A malformed request must never take the process down.
    log.debug('Client error:', err.message);
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy();
  });

  server.listen(env.port, env.host, () => {
    log.info(`Listening on http://${env.host}:${env.port} (version ${VERSION})`);
    log.info(`Panel authentication: ${auth.enabled ? 'enabled' : 'DISABLED'}`);
    log.info(`Home Assistant: ${env.ha.enabled ? env.ha.url : 'not configured'}`);
    log.info(`Immich: ${env.immich.enabled ? env.immich.url : 'not configured'}`);
    log.info(`Music Assistant: ${env.mass.enabled ? env.mass.url : 'not configured'}`);
  });

  /* ── Shutdown ────────────────────────────────────────────────────────────
     Docker sends SIGTERM and waits ten seconds before SIGKILL. Closing panel
     sockets cleanly means each Navigator sees a close frame and reconnects
     immediately on the new container, instead of sitting on a dead socket
     until its heartbeat times out. That is the difference between a deploy
     users notice and one they do not. */

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received — shutting down`);

    haClient.stop();
    massClient.stop();
    massStore.dispose();
    hub.close();
    config.close();
    server.close(() => process.exit(0));

    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  /*
   * Last-resort handlers. A backend that exits takes every panel in the house
   * down with it, so an unexpected error is logged and survived rather than
   * being allowed to kill the process. Anything that genuinely cannot be
   * recovered from will fail again on the next request, visibly.
   */
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception:', err);
  });

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection:', reason);
  });
}

/**
 * Locate the built panel.
 *
 * The layout differs between the container and a local checkout, and getting
 * this wrong produces a 404 that looks like a broken build rather than a
 * misconfigured path — so all three cases are handled explicitly:
 *
 *   Docker      /app/dist/server.js          →  /app/panel
 *   Local build server/dist/server.js        →  panel/dist
 *   Override    PANEL_DIR=/somewhere/else
 *
 * In `npm run dev` the panel is served by Vite instead and none of these
 * exist; StaticFiles then returns a message saying what to run.
 */
function resolvePanelRoot(): string {
  const override = process.env['PANEL_DIR'];
  if (override) return resolve(override);

  const candidates = [
    fileURLToPath(new URL('../panel', import.meta.url)), // container
    fileURLToPath(new URL('../../panel/dist', import.meta.url)), // local build
  ];

  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return candidates[0] as string;
}

main().catch((err: unknown) => {
  log.error('Fatal startup error:', err);
  process.exit(1);
});
