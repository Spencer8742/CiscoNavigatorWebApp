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
import { Hub } from '~/hub/index.ts';
import { HaClient } from '~/ha/client.ts';
import { HaStore, isEmptyPatch } from '~/ha/store.ts';
import { ServiceGuard } from '~/ha/services.ts';
import type { BackendHealth } from '@shared/protocol.ts';

const log = logger('server');

const VERSION = process.env['APP_VERSION'] ?? 'dev';
const STARTED_AT = Date.now();

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

  const panelRoot = resolvePanelRoot();
  log.info(`Serving panel from ${panelRoot}`);
  const files = new StaticFiles(panelRoot);

  /* ── Home Assistant bridge ───────────────────────────────────────────────
     The store is constructed before the client so it is ready to absorb the
     first snapshot, which arrives within milliseconds of authenticating. */

  const store = new HaStore(config.current);

  /** Pending "we have genuinely lost touch" timer. See onStateChange below. */
  let unavailableTimer: ReturnType<typeof setTimeout> | undefined;

  const getHealth = (): BackendHealth => ({
    ha: env.ha.enabled ? haClient.state : 'disconnected',
    immich: env.immich.enabled ? 'connecting' : 'disconnected',
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

  const services = new ServiceGuard(haClient, store);

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
  });

  // A config edit changes which entities are visible. The store already holds
  // every entity Home Assistant knows about, so newly referenced ones can be
  // pushed immediately rather than waiting for them to change state.
  config.onChange((cfg) => {
    const patch = store.setConfig(cfg);
    if (!isEmptyPatch(patch)) hub.broadcastPatch(patch);
  });

  haClient.start();

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applySecurityHeaders(res);

    const rawUrl = req.url ?? '/';
    const path = rawUrl.split('?')[0] ?? '/';

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

    if (path === '/api/config') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(config.current));
      return;
    }

    // Immich image proxy lands here in phase 6.
    if (path.startsWith('/img/')) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('Photo support is not enabled yet');
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
