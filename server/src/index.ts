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
import type { BackendHealth, EntityState } from '@shared/protocol.ts';

const log = logger('server');

const VERSION = process.env['APP_VERSION'] ?? 'dev';
const STARTED_AT = Date.now();

/**
 * Backend entry point.
 *
 * Phase 1 wires: environment, config (with hot reload), static serving, the
 * panel WebSocket hub, and health reporting. The Home Assistant client
 * (phase 2) and the Immich client (phase 6) plug into the `HubDeps` hooks
 * below without changing anything here.
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

  /*
   * Live state. Phase 2 replaces these with the HA store's real
   * implementations; the Hub only ever sees the getters, so nothing in the
   * hub or the panel changes when it does.
   */
  let states: Record<string, EntityState> = {};
  const getStates = (): Record<string, EntityState> => states;
  void states;

  const getHealth = (): BackendHealth => ({
    ha: env.ha.enabled ? 'connecting' : 'disconnected',
    immich: env.immich.enabled ? 'connecting' : 'disconnected',
    haLastMessage: null,
    uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
    version: VERSION,
  });

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  const hub = new Hub(server, { auth, config, getStates, getHealth });

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
