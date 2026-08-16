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
   * Music Assistant, spoken to directly rather than through Home Assistant.
   *
   * The token is required by Music Assistant from API schema 28 onward and
   * ignored by older servers, so it is always sent when present and its
   * absence is only an error if the server asks for it.
   */
  mass: {
    url: string;
    token: string;
    insecureTls: boolean;
    enabled: boolean;
  };

  immich: {
    url: string;
    apiKey: string;
    insecureTls: boolean;
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
  const massUrl = normalizeUrl(str('MASS_URL'));

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

    mass: {
      url: massUrl,
      token: str('MASS_TOKEN'),
      insecureTls: bool('MASS_INSECURE_TLS'),
      // A URL is enough to try. Whether a token is REQUIRED depends on the
      // server's schema version, which we only learn once connected — so
      // refusing to start without one here would lock out older servers that
      // do not use tokens at all.
      enabled: Boolean(massUrl),
    },

    immich: {
      url: immichUrl,
      apiKey: immichKey,
      insecureTls: bool('IMMICH_INSECURE_TLS'),
      enabled: Boolean(immichUrl && immichKey),
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

  if (!env.mass.enabled) {
    log.info(
      'MASS_URL not set — media falls back to Home Assistant media_player entities. ' +
        'Set it to browse your library, edit the queue and control speakers directly.',
    );
  }

  if (env.ha.insecureTls || env.immich.insecureTls || env.mass.insecureTls) {
    log.warn(
      'TLS certificate verification is disabled for one or more upstreams. ' +
        'Prefer mounting your CA bundle into the container instead.',
    );
  }

  return env;
}
