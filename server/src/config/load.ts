import { readFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { logger } from '~/lib/log.ts';
import {
  CAST_PANES,
  CAST_TARGETS,
  CONTROL_SIZES,
  CONTROL_TONES,
  KEY_LIGHT_OPS,
} from '@shared/config.ts';
import type {
  AlertRule,
  CastDisplay,
  CastPane,
  CastTarget,
  ControlAction,
  ControlButton,
  ControlItem,
  AppleTvConfig,
  AppleTvShortcutConfig,
  TvConfig,
  ControlPage,
  DashboardConfig,
  DeviceEntities,
  EntityRef,
  ImmichSource,
  KeyLightConfig,
  KeyLightOp,
  MediaPlayerConfig,
  RoomConfig,
  SourceRef,
  StatusItem,
} from '@shared/config.ts';

const log = logger('config');

/**
 * Dashboard config: load, validate, normalise, watch.
 *
 * Two properties this file exists to guarantee:
 *
 * 1. **A bad config never takes the panel down.** If the YAML fails to parse,
 *    or a required section has the wrong shape, we log loudly and keep
 *    serving the LAST GOOD config. On a wall-mounted device, a typo at 11pm
 *    must not produce a black screen that needs a ladder to diagnose.
 *
 * 2. **What reaches the panel is fully populated.** Every optional field is
 *    defaulted here, so the frontend never writes `cfg.ui?.clock ?? '24h'`.
 *    Validation happens once, at the boundary, and the type is honest
 *    everywhere after it.
 *
 * There is no schema library. The config is ~8 sections of well-known shape;
 * a dependency would be more code than this, and validation errors written by
 * hand can say "rooms[2].entities[0] is not a string" instead of a JSON
 * Pointer.
 */

/** Used before any file has been read, and if the very first read fails. */
export const FALLBACK_CONFIG: DashboardConfig = {
  version: 1,
  ui: {
    title: 'Home',
    navPosition: 'left',
    clock: '24h',
    timezone: 'UTC',
    locale: 'en-GB',
    blur: false,
    motion: 1,
    accent: '#5B9DFF',
  },
  idle: {
    timeoutSeconds: 180,
    returnHomeSeconds: 90,
    controlsHoldSeconds: 1800,
    overlays: { nowPlaying: true, photoInfo: true },
    burnInProtection: true,
  },
  immich: {
    enabled: false,
    intervalSeconds: 45,
    transitionMs: 1200,
    sources: [],
    imagesOnly: true,
    pairPortraits: true,
    homeCardSeconds: 15,
  },
  rooms: [],
  home: { favorites: [], scenes: [], status: [], alerts: [] },
  media: { players: [], default: 'active', volumeStep: 0.05, sections: ['Speakers', 'TVs'] },
  cast: {
    baseUrl: '',
    displays: [],
    checkSeconds: 300,
    screensaver: true,
    panes: ['clock', 'media', 'photos'],
    rotateSeconds: 30,
    followMusic: true,
    audioKeepAlive: false,
  },
  controls: { pages: [], keylights: [], tvs: [], appleTvs: [], pollSeconds: 15 },
};

/* ── Coercion helpers ──────────────────────────────────────────────────────
   Each takes the raw value and a default. They never throw; a wrong type
   becomes a warning and the default, because one bad field should not
   invalidate an otherwise usable dashboard. */

type Raw = Record<string, unknown>;

function obj(v: unknown): Raw {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {};
}

function str(v: unknown, fallback: string, path: string): string {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (v !== undefined && v !== null) warn(path, 'string', v);
  return fallback;
}

function num(v: unknown, fallback: number, path: string, min = -Infinity, max = Infinity): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.min(max, Math.max(min, v));
  if (v !== undefined && v !== null) warn(path, 'number', v);
  return fallback;
}

function bool(v: unknown, fallback: boolean, path: string): boolean {
  if (typeof v === 'boolean') return v;
  if (v !== undefined && v !== null) warn(path, 'boolean', v);
  return fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T, path: string): T {
  /*
   * YAML 1.1 reads bare `on` and `off` as BOOLEANS, which is the single most
   * common surprise in a config file like this one — and it is silent: an
   * `action: on` arrives as `true`, matches nothing, and quietly takes the
   * fallback. A TV power key written to turn the set ON became a toggle,
   * which is worse than an error because it half works.
   *
   * Coerced back wherever the option list actually contains on/off, so
   * `action: on` means what anybody writing it meant. Quoting still works.
   */
  let value = v;
  if (typeof value === 'boolean') {
    const word = value ? 'on' : 'off';
    if ((allowed as readonly string[]).includes(word)) value = word;
  }

  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  if (value !== undefined && value !== null) warn(path, allowed.join(' | '), value);
  return fallback;
}

/**
 * A list of entities, each written either as a bare id or as an object with a
 * display-name override:
 *
 *   - light.kitchen_ceiling
 *   - entity: light.kitchen_under_cabinet
 *     name: Under Cabinet
 *
 * Both normalise to `EntityRef`, so nothing downstream has to branch. The
 * bare-string form is not legacy — it stays the right way to write it when
 * Home Assistant's own name is already good.
 */
function entityRefList(v: unknown, path: string): EntityRef[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    warn(path, 'list of entity ids', v);
    return [];
  }

  const out: EntityRef[] = [];
  const seen = new Set<string>();

  v.forEach((item, i) => {
    const where = `${path}[${i}]`;

    let id: string | undefined;
    let name: string | undefined;

    if (typeof item === 'string') {
      id = item.trim();
    } else if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const o = item as Raw;
      const rawId = o['entity'];
      if (typeof rawId === 'string') id = rawId.trim();
      // `name` is the documented key; `label` is accepted because the status
      // and alert sections already use it and mixing them up is inevitable.
      const rawName = o['name'] ?? o['label'];
      if (typeof rawName === 'string' && rawName.trim()) name = rawName.trim();
    }

    if (!id || !id.includes('.')) {
      warn(where, 'entity id like "light.kitchen", or { entity: …, name: … }', item);
      return;
    }

    // A duplicate is almost always a copy-paste slip. Keeping the first is
    // less surprising than rendering the same tile twice.
    if (seen.has(id)) {
      log.warn(`${where}: "${id}" is listed more than once — keeping the first`);
      return;
    }
    seen.add(id);

    out.push(name ? { entity: id, name } : { entity: id });
  });

  return out;
}

/**
 * Section headings for the player list. Duplicates and blanks are dropped;
 * an empty list falls back to the defaults so the picker always has somewhere
 * to put a speaker.
 */
function sectionList(v: unknown): string[] {
  const fallback = ['Speakers', 'TVs'];
  if (v === undefined || v === null) return fallback;
  if (!Array.isArray(v)) {
    warn('media.sections', 'list of names', v);
    return fallback;
  }

  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const name = item.trim();
    // Reserved: the panel uses it for speakers you have chosen not to see.
    if (name.toLowerCase() === 'hidden') continue;
    if (!out.includes(name)) out.push(name);
  }
  // Cap: these are headings on a wall panel, not a taxonomy.
  return out.length ? out.slice(0, 12) : fallback;
}

function warn(path: string, expected: string, got: unknown): void {
  log.warn(`${path}: expected ${expected}, got ${JSON.stringify(got)} — using default`);
}

/**
 * The clock, date and weather overlays moved to the panel.
 *
 * They are now per-panel switches on the Settings screen, so the key here no
 * longer does anything. Left silent, somebody would set `clock: false`, watch
 * the clock stay, and have nothing anywhere to tell them why — which is the
 * exact failure the move was meant to end.
 */
function noteMovedOverlays(overlays: Raw): void {
  const moved = ['clock', 'date', 'weather'].filter((key) => overlays[key] !== undefined);
  if (moved.length === 0) return;
  log.warn(
    `idle.overlays.${moved.join(', idle.overlays.')} no longer ${moved.length > 1 ? 'do' : 'does'} anything — ` +
      'the clock, date and weather are now switched per panel on the Settings screen. ' +
      'You can delete these lines.',
  );
}

/* ── Section validators ───────────────────────────────────────────────────*/

function validate(raw: unknown): DashboardConfig {
  const root = obj(raw);
  const d = FALLBACK_CONFIG;

  const uiRaw = obj(root['ui']);
  const idleRaw = obj(root['idle']);
  const overlaysRaw = obj(idleRaw['overlays']);
  noteMovedOverlays(overlaysRaw);
  const immichRaw = obj(root['immich']);
  const homeRaw = obj(root['home']);
  const mediaRaw = obj(root['media']);
  const castRaw = obj(root['cast']);
  const controlsRaw = obj(root['controls']);

  // Parsed once: the pages need it to resolve their pickers' inputs, and
  // parsing twice would double every warning the list emits.
  const tvsParsed = tvList(controlsRaw['tvs']);

  const version = num(root['version'], 1, 'version', 1, 1);
  if (version !== 1) log.warn(`Unknown config version ${version}; treating as 1`);

  return {
    version: 1,

    ui: {
      title: str(uiRaw['title'], d.ui.title, 'ui.title'),
      navPosition: oneOf(uiRaw['navPosition'], ['left', 'bottom'] as const, 'left', 'ui.navPosition'),
      clock: oneOf(uiRaw['clock'], ['24h', '12h'] as const, '24h', 'ui.clock'),
      timezone: validTimezone(str(uiRaw['timezone'], d.ui.timezone, 'ui.timezone')),
      locale: str(uiRaw['locale'], d.ui.locale, 'ui.locale'),
      blur: bool(uiRaw['blur'], d.ui.blur, 'ui.blur'),
      motion: num(uiRaw['motion'], d.ui.motion, 'ui.motion', 0, 1),
      accent: validHex(str(uiRaw['accent'], d.ui.accent, 'ui.accent')),
    },

    idle: {
      timeoutSeconds: num(idleRaw['timeoutSeconds'], d.idle.timeoutSeconds, 'idle.timeoutSeconds', 0),
      returnHomeSeconds: num(
        idleRaw['returnHomeSeconds'],
        d.idle.returnHomeSeconds,
        'idle.returnHomeSeconds',
        0,
      ),
      // Thirty minutes: longer than a meeting's quiet stretch, short enough
      // that a panel left on Controls is back to photos within the hour.
      controlsHoldSeconds: num(
        idleRaw['controlsHoldSeconds'],
        d.idle.controlsHoldSeconds,
        'idle.controlsHoldSeconds',
        0,
        86_400,
      ),
      overlays: {
        nowPlaying: bool(overlaysRaw['nowPlaying'], true, 'idle.overlays.nowPlaying'),
        photoInfo: bool(overlaysRaw['photoInfo'], true, 'idle.overlays.photoInfo'),
      },
      burnInProtection: bool(idleRaw['burnInProtection'], true, 'idle.burnInProtection'),
    },

    immich: {
      enabled: bool(immichRaw['enabled'], false, 'immich.enabled'),
      // Floor of 5s: anything faster is a strobe and would defeat preloading.
      intervalSeconds: num(immichRaw['intervalSeconds'], 45, 'immich.intervalSeconds', 5, 3600),
      transitionMs: num(immichRaw['transitionMs'], 1200, 'immich.transitionMs', 0, 10_000),
      sources: immichSources(immichRaw['sources']),
      imagesOnly: bool(immichRaw['imagesOnly'], true, 'immich.imagesOnly'),
      pairPortraits: bool(immichRaw['pairPortraits'], true, 'immich.pairPortraits'),
      // 0 is meaningful — "hold one photo" — so the floor is 0, not the 5s
      // minimum the panel applies to any non-zero value.
      homeCardSeconds: num(immichRaw['homeCardSeconds'], 15, 'immich.homeCardSeconds', 0, 3600),
      ...(typeof immichRaw['maxAgeYears'] === 'number'
        ? { maxAgeYears: num(immichRaw['maxAgeYears'], 0, 'immich.maxAgeYears', 0, 200) }
        : {}),
    },

    rooms: roomList(root['rooms']),

    home: {
      favorites: entityRefList(homeRaw['favorites'], 'home.favorites'),
      scenes: entityRefList(homeRaw['scenes'], 'home.scenes'),
      status: statusList(homeRaw['status']),
      ...(typeof homeRaw['weather'] === 'string' && homeRaw['weather'].includes('.')
        ? { weather: homeRaw['weather'] }
        : {}),
      alerts: alertList(homeRaw['alerts']),
    },

    media: {
      players: playerList(mediaRaw['players']),
      default: str(mediaRaw['default'], 'active', 'media.default'),
      volumeStep: num(mediaRaw['volumeStep'], 0.05, 'media.volumeStep', 0.01, 0.5),
      sections: sectionList(mediaRaw['sections']),
    },

    cast: {
      baseUrl: str(castRaw['baseUrl'], '', 'cast.baseUrl'),
      displays: displayList(castRaw['displays']),
      // Five minutes: a display that drops is back well before anyone has
      // finished wondering why it is showing a photo of a beach.
      checkSeconds: num(castRaw['checkSeconds'], 300, 'cast.checkSeconds', 0, 86_400),
      screensaver: bool(castRaw['screensaver'], true, 'cast.screensaver'),
      panes: paneList(castRaw['panes']),
      // Below ~8s a rotating display is a distraction rather than something
      // you glance at; 0 pins the first pane and never rotates.
      rotateSeconds: num(castRaw['rotateSeconds'], 30, 'cast.rotateSeconds', 0, 3600),
      followMusic: bool(castRaw['followMusic'], true, 'cast.followMusic'),
      audioKeepAlive: bool(castRaw['audioKeepAlive'], false, 'cast.audioKeepAlive'),
    },

    controls: {
      keylights: keyLightList(controlsRaw['keylights']),
      tvs: tvsParsed,
      appleTvs: appleTvList(controlsRaw['appleTvs']),
      pages: controlPages(controlsRaw['pages']),
      // 15s is a compromise: fast enough that turning a light off at the
      // light is reflected before anyone reaches the panel, slow enough that
      // two lights cost four requests a minute.
      pollSeconds: num(controlsRaw['pollSeconds'], 15, 'controls.pollSeconds', 0, 3600),
    },
  };
}

/**
 * Which panes a cast display rotates through.
 *
 * Unknown names are dropped with a warning rather than failing the config: a
 * typo here should cost you one pane, not the whole dashboard.
 */
function paneList(v: unknown): CastPane[] {
  if (v === undefined || v === null) return [...FALLBACK_CONFIG.cast.panes];
  if (!Array.isArray(v)) {
    warn('cast.panes', 'list', v);
    return [...FALLBACK_CONFIG.cast.panes];
  }

  const out: CastPane[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const name = item.trim().toLowerCase();
    if (!(CAST_PANES as readonly string[]).includes(name)) {
      warn('cast.panes[]', CAST_PANES.join(' | '), item);
      continue;
    }
    // Deduped: the same pane twice would stall the rotation on it.
    if (!out.includes(name as CastPane)) out.push(name as CastPane);
  }
  return out;
}

/**
 * The Cast displays the backend keeps the dashboard on.
 *
 * Written either way, because most people want the same thing on every
 * display and should not have to say so twice:
 *
 *   displays:
 *     - 192.168.1.42                     # the configured rotation
 *     - host: 192.168.1.43
 *       name: Kitchen
 *       pane: dashboard
 *
 * A bad entry is dropped with a warning. Nothing here can fail the config —
 * a typo in a display's address must not cost you the dashboard on the wall.
 */
function displayList(v: unknown): CastDisplay[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    warn('cast.displays', 'list', v);
    return [];
  }

  const out: CastDisplay[] = [];
  v.forEach((item, i) => {
    const path = `cast.displays[${i}]`;
    const raw = typeof item === 'string' ? { host: item } : obj(item);

    // `ip:` accepted as an alias — it is what most people will reach for,
    // and being right about the word is not worth a silent misconfiguration.
    const host = str(raw['host'] ?? raw['ip'], '', `${path}.host`);
    if (!host) {
      warn(path, 'an address like 192.168.1.42', item);
      return;
    }
    /*
     * A URL here is a natural mistake and produces a baffling failure — a TLS
     * connection to a host called "http" — so it is caught by name.
     */
    if (host.includes('/') || /\s/.test(host)) {
      warn(`${path}.host`, 'a bare address, not a URL', host);
      return;
    }

    const display: CastDisplay = { host };

    const name = str(raw['name'], '', `${path}.name`);
    if (name) display.name = name;

    const pane = raw['pane'];
    if (pane !== undefined && pane !== null) {
      const wanted = typeof pane === 'string' ? pane.trim().toLowerCase() : '';
      if ((CAST_TARGETS as readonly string[]).includes(wanted)) {
        display.pane = wanted as CastTarget;
      } else {
        warn(`${path}.pane`, CAST_TARGETS.join(' | '), pane);
      }
    }

    out.push(display);
  });
  return out;
}

/* ── Controls ──────────────────────────────────────────────────────────────
   The macro-button pages. Parsed strictly: an item whose action cannot be
   understood is DROPPED with a warning rather than defaulted, because there
   is no sensible default for "what should this button do" and a button that
   silently does the wrong thing is worse than one that is missing. */

function tvList(v: unknown): TvConfig[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    warn('controls.tvs', 'list', v);
    return [];
  }

  const seen = new Set<string>();
  const out: TvConfig[] = [];

  v.forEach((item, i) => {
    const path = `controls.tvs[${i}]`;
    const raw = typeof item === 'string' ? { host: item } : obj(item);

    const host = str(raw['host'] ?? raw['ip'], '', `${path}.host`);
    if (!host) {
      warn(path, 'an address like 192.168.1.67', item);
      return;
    }
    // Same trap as the key lights: a URL here reads as a host called "http"
    // and fails looking exactly like the TV being off.
    if (host.includes('/') || /\s/.test(host)) {
      warn(`${path}.host`, 'a bare address, not a URL', host);
      return;
    }

    const id = str(raw['id'], `tv${i + 1}`, `${path}.id`);
    if (seen.has(id)) {
      log.warn(`${path}: duplicate id "${id}" — skipping`);
      return;
    }
    seen.add(id);

    const cfg: TvConfig = {
      id,
      name: str(raw['name'], id, `${path}.name`),
      host,
      inputs: sourceRefList(raw['inputs'], `${path}.inputs`),
    };

    // A malformed MAC is dropped rather than passed on, so the failure shows
    // up here — at load, naming the file and the line — instead of as a wake
    // packet that silently goes nowhere.
    const mac = str(raw['mac'], '', `${path}.mac`);
    if (mac) {
      if (/^[0-9a-f]{12}$/i.test(mac.replace(/[^0-9a-f]/gi, ''))) cfg.mac = mac;
      else warn(`${path}.mac`, 'a MAC like a8:23:fe:00:11:22', mac);
    }

    const broadcast = str(raw['broadcast'], '', `${path}.broadcast`);
    if (broadcast) cfg.broadcast = broadcast;

    out.push(cfg);
  });

  return out;
}

function appleTvList(v: unknown): AppleTvConfig[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    warn('controls.appleTvs', 'list', v);
    return [];
  }
  const seen = new Set<string>();
  const out: AppleTvConfig[] = [];
  v.forEach((item, i) => {
    const path = `controls.appleTvs[${i}]`;
    const raw = typeof item === 'string' ? { host: item } : obj(item);
    const host = str(raw['host'] ?? raw['ip'], '', `${path}.host`);
    if (!host || host.includes('/') || /\s/.test(host)) {
      warn(`${path}.host`, 'a bare address like 192.168.1.80', host || item);
      return;
    }
    const id = str(raw['id'], `apple_tv${i + 1}`, `${path}.id`);
    if (seen.has(id)) {
      log.warn(`${path}: duplicate id "${id}" — skipping`);
      return;
    }
    seen.add(id);
    const cfg: AppleTvConfig = {
      id,
      name: str(raw['name'], id, `${path}.name`),
      host,
      shortcuts: appleTvShortcutList(raw['shortcuts'], `${path}.shortcuts`),
    };
    const identifier = str(raw['identifier'], '', `${path}.identifier`);
    if (identifier) cfg.identifier = identifier;
    out.push(cfg);
  });
  return out;
}

function appleTvShortcutList(v: unknown, path: string): AppleTvShortcutConfig[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    warn(path, 'list', v);
    return [];
  }
  const seen = new Set<string>();
  const out: AppleTvShortcutConfig[] = [];
  v.forEach((item, i) => {
    const itemPath = `${path}[${i}]`;
    const raw = obj(item);
    const bundleId = str(raw['bundleId'] ?? raw['app'], '', `${itemPath}.bundleId`);
    if (!bundleId || bundleId.length > 200 || !/^[A-Za-z0-9._-]+$/.test(bundleId)) {
      warn(`${itemPath}.bundleId`, 'an app bundle id like com.plexapp.plex', bundleId || item);
      return;
    }
    if (seen.has(bundleId)) {
      log.warn(`${itemPath}: duplicate app "${bundleId}" — skipping`);
      return;
    }
    seen.add(bundleId);
    out.push({
      name: str(raw['name'], bundleId.split('.').pop() ?? bundleId, `${itemPath}.name`),
      bundleId,
    });
  });
  return out;
}

function keyLightList(v: unknown): KeyLightConfig[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    warn('controls.keylights', 'list', v);
    return [];
  }

  const seen = new Set<string>();
  const out: KeyLightConfig[] = [];

  v.forEach((item, i) => {
    const path = `controls.keylights[${i}]`;
    const raw = typeof item === 'string' ? { host: item } : obj(item);

    const host = str(raw['host'] ?? raw['ip'], '', `${path}.host`);
    if (!host) {
      warn(path, 'an address like 192.168.1.201', item);
      return;
    }
    // Same trap as cast displays: a URL here connects to a host called
    // "http" and fails in a way that reads like the light being offline.
    if (host.includes('/') || /\s/.test(host)) {
      warn(`${path}.host`, 'a bare address, not a URL', host);
      return;
    }

    // `all` is reserved as the address of every light at once.
    const id = str(raw['id'], `key${i + 1}`, `${path}.id`);
    if (id === 'all') {
      log.warn(`${path}.id: "all" is reserved for every light — skipping`);
      return;
    }
    if (seen.has(id)) {
      log.warn(`${path}: duplicate id "${id}" — skipping`);
      return;
    }
    seen.add(id);

    out.push({ id, name: str(raw['name'], id, `${path}.name`), host });
  });

  return out;
}

function controlPages(v: unknown): ControlPage[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    warn('controls.pages', 'list', v);
    return [];
  }

  const seenPages = new Set<string>();
  /* Button ids are addressed by the panel and looked up by the backend, so
     they have to be unique across the WHOLE config, not just within a page. */
  const seenItems = new Set<string>();
  const out: ControlPage[] = [];

  v.forEach((item, i) => {
    const raw = obj(item);
    const path = `controls.pages[${i}]`;
    const id = str(raw['id'], '', `${path}.id`);
    if (!id) {
      log.warn(`${path}: missing "id" — skipping this page`);
      return;
    }
    if (seenPages.has(id)) {
      log.warn(`${path}: duplicate id "${id}" — skipping`);
      return;
    }
    seenPages.add(id);

    out.push({
      id,
      name: str(raw['name'], id, `${path}.name`),
      icon: str(raw['icon'], 'grid', `${path}.icon`),
      // 12 is past the point where a key is too small to hit; 0 means auto.
      columns: num(raw['columns'], 0, `${path}.columns`, 0, 12),
      size: oneOf(raw['size'], CONTROL_SIZES, 'md', `${path}.size`),
      items: controlItems(raw['items'], id, `${path}.items`, seenItems),
    });
  });

  return out;
}

function controlItems(
  v: unknown,
  pageId: string,
  path: string,
  seen: Set<string>,
): ControlItem[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    warn(path, 'list', v);
    return [];
  }

  const out: ControlItem[] = [];

  v.forEach((entry, i) => {
    const raw = obj(entry);
    const itemPath = `${path}[${i}]`;

    /* The generated id encodes the position, so reordering a page renames
       its buttons. That is only ever a cosmetic problem — nothing persists a
       button id — but it is why `id:` is worth writing by hand on a page you
       expect to rearrange. */
    const id = str(raw['id'], `${pageId}.${i}`, `${itemPath}.id`);
    if (seen.has(id)) {
      log.warn(`${itemPath}: duplicate control id "${id}" — skipping`);
      return;
    }

    /*
     * `device:` is a whole RoomOS device as one tile, not a key. Checked
     * first because it is a block rather than an action and nothing below
     * would recognise it.
     */
    const device = raw['device'];
    if (device !== undefined && device !== null) {
      const spec = obj(device);
      const entities = deviceEntities(spec, `${itemPath}.device`);
      if (Object.keys(entities).length === 0) {
        log.warn(`${itemPath}.device: no entities (set "prefix" or name them) — skipping`);
        return;
      }
      seen.add(id);
      /*
       * Keys drawn inside the tile, parsed by the very same code as any other
       * key — recursion rather than a second parser. A camera key is a
       * Companion press like every other Companion press, and it would be
       * surprising for it to accept a different spelling because of where it
       * happens to be drawn. Anything that is not a plain button (a nested
       * device, a source picker) is dropped: the row has space for keys.
       */
      const keys = controlItems(
        spec['keys'],
        `${id}.k`,
        `${itemPath}.device.keys`,
        seen,
      ).filter((k): k is ControlButton => k.type === 'button');

      out.push({
        type: 'device',
        id,
        name: str(spec['name'], 'Device', `${itemPath}.device.name`),
        entities,
        keys,
      });
      return;
    }

    /*
     * `sources:` names a media player and makes this key a picker rather
     * than a button. Checked before the action forms because it is the same
     * shape as one and would otherwise be read as an `entity:` key.
     */
    const sources = raw['sources'];
    if (typeof sources === 'string' && sources.includes('.')) {
      const target = sources.trim();
      if (!target.startsWith('media_player.')) {
        warn(`${itemPath}.sources`, 'a media_player entity', sources);
        return;
      }
      seen.add(id);
      out.push({
        type: 'sources',
        id,
        entity: target,
        name: str(raw['name'], 'Input', `${itemPath}.name`),
        icon: str(raw['icon'], 'input', `${itemPath}.icon`),
        inputs: sourceRefList(raw['inputs'], `${itemPath}.inputs`),
      });
      return;
    }

    // `light:` (with no op) means the full light control rather than a button.
    const light = raw['light'];
    if (typeof light === 'string' && light.trim() && raw['keylight'] === undefined) {
      seen.add(id);
      out.push({
        type: 'light',
        id,
        light: light.trim(),
        name: str(raw['name'], 'Key Light', `${itemPath}.name`),
      });
      return;
    }

    /*
     * One key, one or more actions.
     *
     * `actions:` is a list of the same shapes a single key takes, so
     * everything below reads the same whether it appears once or in a list.
     * A key with neither is not a key.
     */
    const listed = raw['actions'];
    const actions: ControlAction[] = [];

    if (Array.isArray(listed)) {
      listed.forEach((entry, n) => {
        const one = controlAction(obj(entry), `${itemPath}.actions[${n}]`);
        if (one) actions.push(one);
      });
    } else {
      const single = controlAction(raw, itemPath);
      if (single) actions.push(single);
    }

    if (actions.length === 0) return;

    seen.add(id);
    out.push({
      type: 'button',
      id,
      name: str(raw['name'], id, `${itemPath}.name`),
      icon: str(raw['icon'], defaultIcon(actions[0]), `${itemPath}.icon`),
      tone: oneOf(raw['tone'], CONTROL_TONES, 'default', `${itemPath}.tone`),
      wide: bool(raw['wide'], false, `${itemPath}.wide`),
      actions,
    });
  });

  return out;
}

/** So a page of buttons is legible without an `icon:` on every line. */
function defaultIcon(action: ControlAction | undefined): string {
  switch (action?.kind) {
    case 'tv':
      return 'tv';
    case 'companion':
      return 'grid';
    case 'webhook':
      return 'bolt';
    case 'keylight':
      return 'bulb';
    case 'entity':
      return action.entity.startsWith('scene.') ? 'scene' : 'script';
    default:
      // No action, or one added without a glyph. `grid` is the fallback the
      // panel already draws for an unknown icon, so this matches it.
      return 'grid';
  }
}

function controlAction(raw: Raw, path: string): ControlAction | null {
  /* Companion: accepted as "1/0/2", [1, 0, 2] or {page, row, column}. The
     slash form is what a Companion config export shows and what anyone
     reading their button grid will type. */
  const companion = raw['companion'];
  if (companion !== undefined && companion !== null) {
    const coords = companionCoords(companion);
    if (!coords) {
      warn(`${path}.companion`, 'page/row/column, e.g. "1/0/2"', companion);
      return null;
    }
    return { kind: 'companion', ...coords };
  }

  const webhook = raw['webhook'];
  if (typeof webhook === 'string' && webhook.trim()) {
    const id = webhook.trim();
    // The id goes straight into a path segment, so anything that could
    // escape it is refused rather than encoded — a webhook id with a slash
    // in it is a typo, not a request to reach a different endpoint.
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      warn(`${path}.webhook`, 'a webhook id (letters, digits, _ and -)', webhook);
      return null;
    }
    return { kind: 'webhook', id };
  }

  /*
   * A television from `controls.tvs`.
   *
   *   { tv: office_lg, action: on }      power
   *   { tv: office_lg, action: next }    step through the configured inputs
   *   { tv: office_lg, input: HDMI_2 }   one named input
   */
  const tvRef = raw['tv'];
  if (typeof tvRef === 'string' && tvRef.trim()) {
    const tv = tvRef.trim();
    const input = str(raw['input'], '', `${path}.input`);
    if (input) return { kind: 'tv', tv, op: 'input', input };

    const op = oneOf(
      raw['action'],
      ['toggle', 'on', 'off', 'next'] as const,
      'toggle',
      `${path}.action`,
    );
    return { kind: 'tv', tv, op };
  }

  const keylight = raw['keylight'];
  if (keylight !== undefined && keylight !== null) {
    const spec = typeof keylight === 'string' ? { op: keylight } : obj(keylight);
    const op = typeof spec['op'] === 'string' ? spec['op'].trim() : '';
    if (!(KEY_LIGHT_OPS as readonly string[]).includes(op)) {
      warn(`${path}.keylight.op`, KEY_LIGHT_OPS.join(' | '), keylight);
      return null;
    }
    const action: ControlAction = {
      kind: 'keylight',
      light: str(spec['light'] ?? raw['light'], 'all', `${path}.keylight.light`),
      op: op as KeyLightOp,
    };
    if (op === 'brightness') action.value = num(spec['value'], 100, `${path}.keylight.value`, 0, 100);
    if (op === 'temperature') {
      action.value = num(spec['value'], 4500, `${path}.keylight.value`, 2900, 7000);
    }
    return action;
  }

  const entity = raw['entity'];
  if (typeof entity === 'string' && entity.includes('.')) {
    const id = entity.trim();
    // Scenes and scripts are what a macro page is mostly made of, and both
    // are activated by turn_on — so the common case needs no `service:`.
    // Anything else (`toggle`, `turn_off`) is written out, and is checked by
    // the same ServiceGuard a dashboard tile goes through.
    const service = str(raw['service'], 'turn_on', `${path}.service`);
    const action: ControlAction = { kind: 'entity', entity: id, service };
    const data = raw['data'];
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      action.data = data as Record<string, unknown>;
    }
    return action;
  }

  log.warn(`${path}: no action (companion, webhook, keylight, entity or light) — skipping`);
  return null;
}

/**
 * Which entity fills each slot of a device tile.
 *
 * `prefix: desk_pro` derives all 25 from Home Assistant's naming, and any
 * slot written out by hand overrides the guess. Deriving is worth the table
 * below because writing 25 entity ids by hand is how you get one of them
 * subtly wrong and spend an evening wondering why the volume does nothing.
 *
 * The suffixes are HA's slugified ENTITY NAMES, not the integration's
 * internal keys, and two of them differ: `share_local` is named "Share
 * locally" and `presentation_source` is named "Share source". Deriving from
 * the keys would produce two ids that do not exist.
 */
const DEVICE_SLOTS: Record<keyof DeviceEntities, string> = {
  standby: 'sensor.%_standby_state',
  noise: 'sensor.%_ambient_noise',
  people: 'sensor.%_people_count',
  meetings: 'sensor.%_next_meeting',
  uptime: 'sensor.%_uptime',
  ip: 'sensor.%_ip_address',
  version: 'sensor.%_software_version',
  alerts: 'sensor.%_active_alerts',
  inCall: 'binary_sensor.%_in_call',
  sharing: 'binary_sensor.%_sharing_content',
  mic: 'switch.%_microphone_mute',
  speaker: 'switch.%_speaker_mute',
  dnd: 'switch.%_do_not_disturb',
  camera: 'switch.%_camera_mute',
  selfview: 'switch.%_selfview',
  volume: 'number.%_volume',
  shareSource: 'select.%_share_source',
  wake: 'button.%_wake_up',
  sleep: 'button.%_standby',
  answer: 'button.%_answer_call',
  hangUp: 'button.%_hang_up',
  join: 'button.%_join_next_meeting',
  refreshMeetings: 'button.%_refresh_meetings',
  shareLocal: 'button.%_share_locally',
  shareToCall: 'button.%_share_to_call',
  stopSharing: 'button.%_stop_sharing',
};

function deviceEntities(spec: Raw, path: string): DeviceEntities {
  const out: DeviceEntities = {};
  const prefix = str(spec['prefix'], '', `${path}.prefix`);

  if (prefix && !/^[a-z0-9_]+$/.test(prefix)) {
    warn(`${path}.prefix`, "a device slug like 'desk_pro'", prefix);
    return out;
  }

  for (const [slot, pattern] of Object.entries(DEVICE_SLOTS) as [
    keyof DeviceEntities,
    string,
  ][]) {
    const written = spec[slot];
    if (written === null) continue; // an explicit null drops a derived slot
    if (typeof written === 'string' && written.includes('.')) {
      out[slot] = written.trim();
      continue;
    }
    if (written !== undefined) {
      warn(`${path}.${slot}`, 'an entity id', written);
      continue;
    }
    if (prefix) out[slot] = pattern.replace('%', prefix);
  }

  return out;
}

/**
 * The inputs a `sources:` key offers. Same two spellings as an entity list:
 * a bare string, or an object with a display-name override.
 */
function sourceRefList(v: unknown, path: string): SourceRef[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    warn(path, 'list of input names', v);
    return [];
  }

  const out: SourceRef[] = [];
  const seen = new Set<string>();

  v.forEach((item, i) => {
    const at = `${path}[${i}]`;
    const raw = typeof item === 'string' ? { source: item } : obj(item);
    const source = str(raw['source'], '', `${at}.source`);
    if (!source) {
      warn(at, 'an input name, e.g. "HDMI 2"', item);
      return;
    }
    if (seen.has(source)) {
      log.warn(`${at}: duplicate input "${source}" — skipping`);
      return;
    }
    seen.add(source);

    const name = str(raw['name'], '', `${at}.name`);
    out.push(name && name !== source ? { source, name } : { source });
  });

  return out;
}

function companionCoords(v: unknown): { page: number; row: number; column: number } | null {
  let parts: unknown[];

  if (typeof v === 'string') {
    parts = v.split('/').map((p) => Number.parseInt(p.trim(), 10));
  } else if (Array.isArray(v)) {
    parts = v;
  } else {
    const o = obj(v);
    parts = [o['page'], o['row'], o['column'] ?? o['col']];
  }

  if (parts.length !== 3) return null;
  const nums = parts.map((p) => (typeof p === 'number' && Number.isInteger(p) && p >= 0 ? p : -1));
  if (nums.some((n) => n < 0)) return null;

  return { page: nums[0]!, row: nums[1]!, column: nums[2]! };
}

function roomList(v: unknown): RoomConfig[] {
  if (!Array.isArray(v)) {
    if (v !== undefined && v !== null) warn('rooms', 'list', v);
    return [];
  }
  const seen = new Set<string>();
  const out: RoomConfig[] = [];

  v.forEach((item, i) => {
    const r = obj(item);
    const id = str(r['id'], '', `rooms[${i}].id`);
    if (!id) {
      log.warn(`rooms[${i}]: missing "id" — skipping this room`);
      return;
    }
    if (seen.has(id)) {
      log.warn(`rooms[${i}]: duplicate id "${id}" — skipping`);
      return;
    }
    seen.add(id);

    out.push({
      id,
      name: str(r['name'], id, `rooms[${i}].name`),
      icon: str(r['icon'], 'rooms', `rooms[${i}].icon`),
      entities: entityRefList(r['entities'], `rooms[${i}].entities`),
    });
  });

  return out;
}

function statusList(v: unknown): StatusItem[] {
  if (!Array.isArray(v)) return [];
  const out: StatusItem[] = [];
  v.forEach((item, i) => {
    // Allow the shorthand form: a bare entity id instead of {entity, label}.
    if (typeof item === 'string' && item.includes('.')) {
      out.push({ entity: item });
      return;
    }
    const s = obj(item);
    const entity = str(s['entity'], '', `home.status[${i}].entity`);
    if (!entity.includes('.')) return;
    // `label` is this section's documented key, but `name` is what every
    // other section uses, so accept both rather than making people remember.
    const rawLabel = s['label'] ?? s['name'];
    const label = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim() : undefined;
    out.push(label ? { entity, label } : { entity });
  });
  return out;
}

function alertList(v: unknown): AlertRule[] {
  if (!Array.isArray(v)) return [];
  const out: AlertRule[] = [];
  v.forEach((item, i) => {
    const a = obj(item);
    const entity = str(a['entity'], '', `home.alerts[${i}].entity`);
    if (!entity.includes('.')) return;
    // YAML turns bare `on`/`off` into booleans, which is the single most
    // common surprise in a Home Assistant config. Coerce back to strings so
    // `when: on` behaves the way anyone would expect.
    const rawWhen = a['when'];
    const when =
      typeof rawWhen === 'boolean' ? (rawWhen ? 'on' : 'off') : str(rawWhen, 'on', `home.alerts[${i}].when`);
    out.push({
      entity,
      when,
      label: str(a['label'], entity, `home.alerts[${i}].label`),
    });
  });
  return out;
}

function playerList(v: unknown): MediaPlayerConfig[] {
  if (!Array.isArray(v)) return [];
  const out: MediaPlayerConfig[] = [];
  v.forEach((item, i) => {
    if (typeof item === 'string' && item.includes('.')) {
      out.push({ entity: item });
      return;
    }
    const p = obj(item);
    const entity = str(p['entity'], '', `media.players[${i}].entity`);
    if (!entity.startsWith('media_player.')) {
      if (entity) log.warn(`media.players[${i}]: "${entity}" is not a media_player entity`);
      return;
    }
    const name = typeof p['name'] === 'string' ? p['name'] : undefined;
    out.push(name ? { entity, name } : { entity });
  });
  return out;
}

function immichSources(v: unknown): ImmichSource[] {
  if (!Array.isArray(v)) return [];
  const out: ImmichSource[] = [];
  v.forEach((item, i) => {
    const s = obj(item);
    const type = s['type'];
    switch (type) {
      case 'random':
        out.push({ type: 'random' });
        break;
      case 'favorites':
        out.push({ type: 'favorites' });
        break;
      case 'album': {
        const id = str(s['id'], '', `immich.sources[${i}].id`);
        if (!id) {
          log.warn(`immich.sources[${i}]: album source needs an "id"`);
          return;
        }
        const name = typeof s['name'] === 'string' ? s['name'] : undefined;
        out.push(name ? { type: 'album', id, name } : { type: 'album', id });
        break;
      }
      case 'recent':
        out.push({ type: 'recent', days: num(s['days'], 30, `immich.sources[${i}].days`, 1, 3650) });
        break;
      default:
        log.warn(`immich.sources[${i}]: unknown type ${JSON.stringify(type)} — skipping`);
    }
  });
  return out;
}

function validTimezone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    log.warn(`ui.timezone "${tz}" is not a known IANA zone — using UTC`);
    return 'UTC';
  }
}

function validHex(hex: string): string {
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return hex;
  log.warn(`ui.accent "${hex}" is not a #rgb/#rrggbb colour — using default`);
  return FALLBACK_CONFIG.ui.accent;
}

/* ── Loader + watcher ─────────────────────────────────────────────────────*/

export class ConfigStore {
  #path: string;
  #current: DashboardConfig = FALLBACK_CONFIG;
  #watcher: FSWatcher | undefined;
  #debounce: ReturnType<typeof setTimeout> | undefined;
  #listeners = new Set<(cfg: DashboardConfig) => void>();

  constructor(path: string) {
    this.#path = resolve(path);
  }

  get current(): DashboardConfig {
    return this.#current;
  }

  get path(): string {
    return this.#path;
  }

  onChange(fn: (cfg: DashboardConfig) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Read and validate once. Returns false if the file could not be read. */
  async load(): Promise<boolean> {
    try {
      const text = await readFile(this.#path, 'utf8');
      const parsed = parseYaml(text) as unknown;
      const next = validate(parsed);
      this.#current = next;
      log.info(
        `Loaded ${this.#path}: ${next.rooms.length} rooms, ` +
          `${next.home.favorites.length} favourites, ${next.media.players.length} media players`,
      );
      return true;
    } catch (err) {
      // Deliberately non-fatal — see the note at the top of this file.
      log.error(`Failed to load ${this.#path}:`, err);
      log.error('Keeping the previous configuration. The panel stays up.');
      return false;
    }
  }

  /**
   * Watch the config file for changes.
   *
   * Watches the DIRECTORY, not the file. Editors save by writing a temporary
   * file and renaming it over the original, which replaces the inode — a
   * watch on the file itself silently stops firing after the first save. This
   * is the difference between hot reload that works once and hot reload that
   * keeps working.
   */
  watch(): void {
    if (this.#watcher) return;
    const dir = dirname(this.#path);
    const file = this.#path.slice(dir.length + 1);

    try {
      this.#watcher = watch(dir, (_event, changed) => {
        if (changed !== file) return;
        // Coalesce the burst of events a single save produces.
        clearTimeout(this.#debounce);
        this.#debounce = setTimeout(() => void this.#reload(), 150);
      });
      log.info(`Watching ${this.#path} for changes`);
    } catch (err) {
      log.warn('Could not watch the config file; hot reload is disabled:', err);
    }
  }

  async #reload(): Promise<void> {
    const before = JSON.stringify(this.#current);
    const ok = await this.load();
    if (!ok) return;
    if (JSON.stringify(this.#current) === before) return; // touched, not changed
    log.info('Configuration changed — pushing to connected panels');
    for (const fn of this.#listeners) {
      try {
        fn(this.#current);
      } catch (err) {
        log.error('Config listener threw:', err);
      }
    }
  }

  close(): void {
    clearTimeout(this.#debounce);
    this.#watcher?.close();
    this.#watcher = undefined;
    this.#listeners.clear();
  }
}
