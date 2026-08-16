import { readFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { logger } from '~/lib/log.ts';
import { CAST_PANES, CAST_TARGETS } from '@shared/config.ts';
import type {
  AlertRule,
  CastDisplay,
  CastPane,
  CastTarget,
  DashboardConfig,
  EntityRef,
  ImmichSource,
  MediaPlayerConfig,
  RoomConfig,
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
    overlays: { clock: true, date: true, weather: true, nowPlaying: true, photoInfo: true },
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
    panes: ['clock', 'media', 'photos'],
    rotateSeconds: 30,
    followMusic: true,
    audioKeepAlive: false,
  },
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
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  if (v !== undefined && v !== null) warn(path, allowed.join(' | '), v);
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

/* ── Section validators ───────────────────────────────────────────────────*/

function validate(raw: unknown): DashboardConfig {
  const root = obj(raw);
  const d = FALLBACK_CONFIG;

  const uiRaw = obj(root['ui']);
  const idleRaw = obj(root['idle']);
  const overlaysRaw = obj(idleRaw['overlays']);
  const immichRaw = obj(root['immich']);
  const homeRaw = obj(root['home']);
  const mediaRaw = obj(root['media']);
  const castRaw = obj(root['cast']);

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
      overlays: {
        clock: bool(overlaysRaw['clock'], true, 'idle.overlays.clock'),
        date: bool(overlaysRaw['date'], true, 'idle.overlays.date'),
        weather: bool(overlaysRaw['weather'], true, 'idle.overlays.weather'),
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
      panes: paneList(castRaw['panes']),
      // Below ~8s a rotating display is a distraction rather than something
      // you glance at; 0 pins the first pane and never rotates.
      rotateSeconds: num(castRaw['rotateSeconds'], 30, 'cast.rotateSeconds', 0, 3600),
      followMusic: bool(castRaw['followMusic'], true, 'cast.followMusic'),
      audioKeepAlive: bool(castRaw['audioKeepAlive'], false, 'cast.audioKeepAlive'),
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
