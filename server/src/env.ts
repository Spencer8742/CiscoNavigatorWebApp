import { logger, setLogLevel } from '~/lib/log.ts';

const log = logger('env');

/**
 * Environment parsing, validated once at boot.
 *
 * Fail-fast, with one important exception. A misconfigured HA or Immich URL
 * is a *runtime degradation* — the panel still boots, still shows the clock,
 * and the Settings screen tells you which link is down. A missing PORT or an
 * unreadable config path is a *startup error* and the process exits.
 *
 * That split matters for a wall-mounted device: if the container refuses to
 * start because Immich happens to be down, the panel shows nothing at all.
 * If it starts degraded, the panel is still a clock and a light switch.
 */

export interface Env {
  port: number;
  host: string;
  logLevel: string;
  configPath: string;

  /** Empty string disables panel authentication. */
  panelToken: string;

  ha: {
    url: string;
    token: string;
    insecureTls: boolean;
    /** False when URL or token is missing — the HA client stays parked. */
    enabled: boolean;
    /**
     * How long the link may be down before entities are shown as unavailable.
     * Long enough to ride out a Home Assistant restart without the dashboard
     * visibly flickering; short enough that a real outage stops the panel
     * claiming states it can no longer verify.
     */
    unavailableGraceMs: number;
  };

  /**
   * Sonos, spoken to directly on the LAN.
   *
   * No token and no URL: control is unauthenticated SOAP on port 1400 of every
   * speaker, so all this needs is one address to start from. From any single
   * player the backend learns the whole household — see sonos/topology.ts.
   */
  sonos: {
    /** One speaker's IP. The documented path; see docs/SONOS.md §5. */
    host: string;
    /** Fall back to SSDP when no host is set. Off unless asked for. */
    discovery: boolean;
    /**
     * Address the speakers should POST events back to.
     *
     * Normally derived from the socket that reached the first speaker, which
     * is right on a multi-homed host and across VLANs. It cannot see through
     * Docker's bridge NAT, which is the one case this exists for.
     */
    callbackHost: string;
    enabled: boolean;
  };

  /**
   * Spotify, for SEARCH ONLY.
   *
   * Playback runs through the household's own linked Spotify account — these
   * credentials never touch it. They are a free developer app used with the
   * client-credentials flow: server to server, no user login, no redirect,
   * and no access to anybody's account. See docs/SONOS.md §8.
   */
  spotify: {
    clientId: string;
    clientSecret: string;
    enabled: boolean;
  };

  immich: {
    url: string;
    apiKey: string;
    insecureTls: boolean;
    enabled: boolean;
  };

  /**
   * Bitfocus Companion, for the macro pages on the Controls screen.
   *
   * Base URL only — there is no token, because Companion's HTTP API has no
   * authentication. That is exactly why it belongs behind this backend rather
   * than being called from the page: the browser would need to reach
   * Companion directly, over HTTP, from an HTTPS origin, which RoomOS blocks
   * as mixed content even before CORS gets a say.
   */
  companion: {
    url: string;
    enabled: boolean;
  };
}

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    log.warn(`${name}="${raw}" is not a number; using ${fallback}`);
    return fallback;
  }
  return n;
}

function bool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

/** Strips a trailing slash so URL joining is unambiguous everywhere else. */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    // Validate now rather than at first request, so the error appears once at
    // boot instead of on every reconnect attempt.
    new URL(trimmed);
    return trimmed;
  } catch {
    log.error(`Invalid URL "${raw}" — ignoring`);
    return '';
  }
}

export function loadEnv(): Env {
  // Applied first so every warning below is emitted at the requested level.
  setLogLevel(str('LOG_LEVEL', 'info'));

  const haUrl = normalizeUrl(str('HA_URL'));
  const haToken = str('HA_TOKEN');
  const immichUrl = normalizeUrl(str('IMMICH_URL'));
  const immichKey = str('IMMICH_API_KEY');
  const companionUrl = normalizeUrl(str('COMPANION_URL'));
  // A bare address, not a URL: the port and paths are fixed by Sonos.
  const sonosHost = str('SONOS_HOST').trim();
  const sonosDiscovery = bool('SONOS_DISCOVERY');
  const spotifyId = str('SPOTIFY_CLIENT_ID').trim();
  const spotifySecret = str('SPOTIFY_CLIENT_SECRET').trim();

  const env: Env = {
    port: int('PORT', 8099),
    host: str('HOST', '0.0.0.0'),
    logLevel: str('LOG_LEVEL', 'info'),
    configPath: str('CONFIG_PATH', './config/dashboard.yaml'),
    panelToken: str('PANEL_TOKEN'),

    ha: {
      url: haUrl,
      token: haToken,
      insecureTls: bool('HA_INSECURE_TLS'),
      enabled: Boolean(haUrl && haToken),
      unavailableGraceMs: int('HA_UNAVAILABLE_GRACE_MS', 30_000),
    },

    sonos: {
      host: sonosHost,
      discovery: sonosDiscovery,
      callbackHost: str('SONOS_CALLBACK_HOST').trim(),
      // Opt-in on both counts. Turning SSDP on by default would have every
      // existing deployment start multicasting the moment it updates, to find
      // speakers nobody asked it to look for.
      enabled: Boolean(sonosHost) || sonosDiscovery,
    },

    spotify: {
      clientId: spotifyId,
      clientSecret: spotifySecret,
      enabled: Boolean(spotifyId && spotifySecret),
    },

    immich: {
      url: immichUrl,
      apiKey: immichKey,
      insecureTls: bool('IMMICH_INSECURE_TLS'),
      enabled: Boolean(immichUrl && immichKey),
    },

    companion: {
      url: companionUrl,
      enabled: Boolean(companionUrl),
    },
  };

  if (!env.panelToken) {
    log.warn(
      'PANEL_TOKEN is empty — the panel API is UNAUTHENTICATED. Acceptable for ' +
        'bench testing on a trusted LAN; set a token before mounting this on a wall.',
    );
  }

  if (!env.ha.enabled) {
    log.warn('HA_URL / HA_TOKEN not set — Home Assistant features are disabled.');
  }

  if (!env.immich.enabled) {
    log.warn('IMMICH_URL / IMMICH_API_KEY not set — photo features are disabled.');
  }

  if (!env.companion.enabled) {
    log.info(
      'COMPANION_URL not set — Controls pages can still drive Home Assistant, ' +
        'webhooks and key lights; Companion buttons will report it is not configured.',
    );
  }

  if (!env.sonos.enabled) {
    log.info(
      'SONOS_HOST not set — Sonos speakers will not appear. Set it to the IP address ' +
        'of one Sonos speaker, or set SONOS_DISCOVERY=1 to search the network.',
    );
  }

  if (env.ha.insecureTls || env.immich.insecureTls) {
    log.warn(
      'TLS certificate verification is disabled for one or more upstreams. ' +
        'Prefer mounting your CA bundle into the container instead.',
    );
  }

  return env;
}
