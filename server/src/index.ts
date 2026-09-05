import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath, URL } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
import { SonosClient } from '~/sonos/client.ts';
import { SonosStore } from '~/sonos/store.ts';
import { SonosEvents } from '~/sonos/events.ts';
import { SonosCommands } from '~/sonos/commands.ts';
import { SonosBrowser } from '~/sonos/browse.ts';
import { SpotifySearch } from '~/sonos/spotify.ts';
import { UriRegistry } from '~/sonos/uris.ts';
import { MusicServices } from '~/sonos/music.ts';
import { canSearch } from '~/sonos/services.ts';
import { CastKeeper } from '~/cast/keeper.ts';
import { Controls } from '~/controls/index.ts';
import { PrefsStore } from '~/config/prefs.ts';
import { ImmichClient } from '~/immich/client.ts';
import { ImmichImages } from '~/immich/images.ts';
import { Playlist } from '~/immich/playlist.ts';
import { MUSIC_VERBS } from '@shared/protocol.ts';
import type {
  BackendHealth,
  MusicSource,
  Player,
  PlayerQueue,
  ServiceLink,
} from '@shared/protocol.ts';

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

  /** Set when Sonos subscriptions exist but no event has ever arrived. */
  let sonosSilence: string | null = null;

  /**
   * The household's music services, as the panel needs to see them.
   *
   * Three booleans rather than the service record: the panel decides whether
   * to draw a search chip and whether to offer to connect, and neither of
   * those is helped by knowing a SMAPI endpoint or an auth policy name.
   */
  const musicSourceList = (): MusicSource[] =>
    musicServices.list().map((service) => ({
      sid: service.sid,
      name: service.name,
      ready: service.auth === 'Anonymous' || musicServices.linked(service.sid),
      searchable: canSearch(service),
      // A service wanting a username and password is not offered: a shared
      // wall screen is the wrong place to type either.
      linkable: service.auth === 'DeviceLink' || service.auth === 'AppLink',
    }));

  /**
   * Connect or disconnect a music service.
   *
   * Every outcome ends with the panels being told, because linking Plex on the
   * kitchen panel should light Plex up on the hallway one without anybody
   * having to go and prod it.
   */
  const linkService = async (
    sid: number,
    op: 'begin' | 'poll' | 'forget',
  ): Promise<ServiceLink> => {
    if (op === 'forget') {
      await musicServices.unlink(sid);
      hub.broadcastSources(musicSourceList());
      return { sid, state: 'waiting' };
    }

    if (op === 'begin') {
      const prompt = await musicServices.beginLink(sid);
      return {
        sid,
        state: 'prompt',
        url: prompt.url,
        ...(prompt.code ? { code: prompt.code } : {}),
      };
    }

    const done = await musicServices.pollLink(sid);
    if (done) hub.broadcastSources(musicSourceList());
    return { sid, state: done ? 'linked' : 'waiting' };
  };

  const getHealth = (): BackendHealth => ({
    ha: env.ha.enabled ? haClient.state : 'disconnected',
    immich: env.immich.enabled ? (immichReachable ? 'connected' : 'disconnected') : 'disconnected',
    immichError: env.immich.enabled ? (immich.lastError?.message ?? null) : null,
    sonos: env.sonos.enabled ? sonosClient.state : 'disabled',
    // A household we can reach but whose events never arrive is a specific,
    // actionable problem, and it outranks a stale connection error.
    sonosError: env.sonos.enabled ? (sonosSilence ?? sonosClient.lastError) : null,
    sonosUpdates: env.sonos.enabled ? sonosStore.updates : 'off',
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

  /* ── Sonos ───────────────────────────────────────────────────────────────
     The music half of the panel, and the only upstream besides Home Assistant
     this app opens. Everything about music — which speakers exist, what they
     are playing, the queue, the library — comes off the speakers themselves
     on the LAN. See docs/SONOS.md. */

  const sonosClient = new SonosClient(env.sonos, {
    onStateChange() {
      // No grace period, unlike Home Assistant: a speaker whose state we
      // cannot verify should stop claiming to be playing, and there is no
      // equivalent of "the light is probably still on".
      hub.broadcastHealth(getHealth());
    },
  });

  /*
   * Event subscriptions. This is the only upstream in the app that connects
   * INWARD: a speaker POSTs NOTIFY to a callback URL we hand it, which is why
   * there is an unauthenticated route below and why the callback address has
   * to be one the speakers can actually reach.
   */
  const sonosEvents = new SonosEvents({
    onEvent: (event) => void sonosStore.applyEvent(event),

    onSilence(message) {
      // Subscribed, but nothing is arriving — almost always Docker bridge
      // networking. The store falls back to polling; this is what tells
      // somebody why the panel is a few seconds behind the house.
      log.warn(message);
      sonosSilence = message;
      hub.broadcastHealth(getHealth());
    },

    callbackHost: env.sonos.callbackHost,
    port: env.port,
  });

  const sonosStore = new SonosStore({
    client: sonosClient,
    events: sonosEvents,
    art: mediaArt,
    listeners: {
      onChange() {
        hub.broadcastPlayers(...musicSnapshot());
      },

      onUpdatesChange(mode) {
        // Recovering from polling back to live is otherwise invisible, and
        // somebody who has just set SONOS_CALLBACK_HOST wants to see it work.
        if (mode === 'live') sonosSilence = null;
        hub.broadcastHealth(getHealth());
      },
    },
    hasPanels: () => hub.panelCount > 0,
  });

  /*
   * The panel never holds a URI a speaker would fetch — only a key this
   * process minted from something a browse produced. Same rule, and the same
   * reasoning, as the artwork registry beside it. See sonos/uris.ts.
   */
  const sonosUris = new UriRegistry();
  const spotify = new SpotifySearch(env.spotify, sonosClient, sonosUris, mediaArt);
  const sonosCommands = new SonosCommands(sonosClient, sonosStore, sonosUris);

  /*
   * The household's music services, and the tokens that let us call them.
   *
   * Stored beside the config with the TV pairing keys — service credentials
   * that must survive a redeploy, or every service would have to be linked
   * again each time the container restarts.
   */
  const musicServices = new MusicServices(
    sonosClient,
    join(dirname(env.configPath), 'music-services.json'),
  );

  const sonosBrowser = new SonosBrowser({
    client: sonosClient,
    store: sonosStore,
    uris: sonosUris,
    art: mediaArt,
    spotify,
    music: musicServices,
  });

  /**
   * Every speaker.
   *
   * A tuple rather than an object so it spreads straight into
   * `broadcastPlayers`.
   */
  const musicSnapshot = (): [Player[], PlayerQueue[]] => {
    const { players, queues } = sonosStore.snapshot();
    return [players, queues];
  };

  const hub: Hub = new Hub(server, {
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

    getPlayers: () => {
      const [players, queues] = musicSnapshot();
      return { players, queues };
    },

    onMusic: async (cmd) => {
      // The union is exhaustive in our code; this is about what arrives on a
      // socket from a device anyone in the room can touch.
      if (!cmd || typeof cmd.player !== 'string' || !MUSIC_VERBS.includes(cmd.verb)) {
        log.warn(`Refused music command: "${String(cmd?.verb)}" is not a verb`);
        return 'Not permitted';
      }
      return sonosCommands.run(cmd);
    },

    onBrowse: (req) => sonosBrowser.browse(req),

    getSources: () => musicSourceList(),
    onLink: (sid, op) => linkService(sid, op),

    getKeyLights: () => controls.snapshot(),
    getTvs: () => controls.tvSnapshot(),
    onControl: (button) => controls.press(button),
    onKeyLight: (light, op, value) => controls.keyLight(light, op, value),
    onSource: (item, value) => controls.selectSource(item, value),

    onPhotos: async (count) => {
      const photos = await playlist.take(count);
      // The refill that just ran is the most authoritative signal we have
      // about Immich, and it is the one the user is actually waiting on.
      if (env.immich.enabled) noteImmichStatus(immich.lastError === null);
      return { t: 'photos', photos };
    },
  });

  /* ── Macro pages ─────────────────────────────────────────────────────────
     The Controls screen: Companion button presses, Home Assistant webhooks
     and Elgato Key Lights, driven from dashboard.yaml. This is what replaced
     the on-device RoomOS macro — see controls/index.ts.

     Declared AFTER the hub because its first reload can already broadcast a
     key light list, and because the two reference each other the annotations
     on both are load-bearing rather than decorative. */

  const controls: Controls = new Controls({
    getConfig: () => config.current,
    companionUrl: env.companion.url,
    haUrl: env.ha.url,
    // The same guard the dashboard tiles go through: a macro button that
    // calls a service gets no more reach than a tile that calls the same one.
    callService: (call) => services.call(call),
    getEntity: (entityId) => store.get(entityId),
    onLights: (lights) => hub.broadcastKeyLights(lights),
    onTvs: (tvs) => hub.broadcastTvs(tvs),
    // Nothing is polled while no panel is connected. A wall panel that has
    // gone to sleep, or a container running before the device is provisioned,
    // should not be talking to the lights every fifteen seconds.
    hasPanels: () => hub.panelCount > 0,
    // Beside the config, like panel-prefs.json — that directory is already
    // the one thing a deployment is expected to persist.
    tvKeyFile: join(dirname(env.configPath), 'tv-keys.json'),
  });

  /* ── Google Nest Hubs ────────────────────────────────────────────────────
     Optional, and inert unless `cast.displays` names something. A Hub loses
     whatever it was showing on every reboot, timer and voice answer, so this
     checks each one and casts the dashboard back. See cast/keeper.ts for why
     that job is in here rather than in a helper container beside it. */

  const castKeeper = new CastKeeper({
    getConfig: () => config.current,
    // The token comes from the environment and stops here: this is what
    // saves it from being copied into a script or a second container.
    token: env.panelToken,
  });

  // A config edit changes which entities are visible. The store already holds
  // every entity Home Assistant knows about, so newly referenced ones can be
  // pushed immediately rather than waiting for them to change state.
  config.onChange((cfg) => {
    const patch = store.setConfig(cfg);
    if (!isEmptyPatch(patch)) hub.broadcastPatch(patch);
    playlist.setConfig(cfg);
    castKeeper.reload();
    controls.reload();
  });

  haClient.start();
  sonosClient.start();
  sonosStore.start();
  // Reads stored service tokens. Discovery of the services themselves is
  // lazy — it needs a household, which arrives with the first topology.
  void musicServices.start();

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

    /*
     * Sonos events, and the ONE route in this app that is neither GET nor
     * authenticated — both by necessity. A speaker POSTs `NOTIFY` here when
     * something changes and has nowhere to put a bearer token, so the checks
     * that replace one live in sonos/events.ts: a per-boot secret in the path
     * (which is why this is matched before the method check rather than after
     * a 405), the source address having to be a household member, and the SID
     * having to name a subscription this process created.
     */
    if (req.method === 'NOTIFY' && path === sonosEvents.path) {
      sonosEvents.handle(req, res);
      return;
    }

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
     * an upstream gave us — the panel cannot name a URL. See
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
    log.info(
      `Sonos: ${env.sonos.host || (env.sonos.discovery ? 'discovering' : 'not configured')}`,
    );
    // Started here rather than above so the first cast cannot land on a
    // display before there is anything for it to load.
    castKeeper.start();
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
    sonosClient.stop();
    sonosStore.dispose();
    // Tear the subscriptions down rather than letting them lapse. A speaker
    // whose subscriber vanished keeps POSTing at a dead endpoint until the
    // subscription ages out, and a container that restarts a few times a day
    // accumulates those — Home Assistant has a filed bug for exactly this.
    void sonosEvents.stop();
    castKeeper.stop();
    controls.stop();
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
