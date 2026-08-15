import { signal, computed } from '@preact/signals';
import type { DashboardConfig } from '@shared/config.ts';

/**
 * The dashboard configuration, as delivered by the backend.
 *
 * The panel never parses YAML and never validates — the backend has already
 * done both, and a config that failed validation never reaches here (the
 * backend keeps serving the last good one instead, so a typo in
 * dashboard.yaml can never take the panel down).
 *
 * Hot reload is free: the backend watches the file and pushes a `config`
 * message, this signal changes, and the affected parts of the UI update. No
 * page reload — which matters, because a reload on a kiosk device is a
 * one-way trip through a blank screen.
 */

/** Sensible defaults so the shell can render before `hello` arrives. */
const DEFAULTS: DashboardConfig = {
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
  media: { players: [], default: 'active', volumeStep: 0.05, discoverMusicAssistant: true,
    sections: ['Speakers', 'TVs'] },
};

export const config = signal<DashboardConfig>(DEFAULTS);

/** Convenience views. Reading `ui.value` subscribes only to the ui section. */
export const ui = computed(() => config.value.ui);
export const idleConfig = computed(() => config.value.idle);
export const immichConfig = computed(() => config.value.immich);
export const rooms = computed(() => config.value.rooms);
export const homeConfig = computed(() => config.value.home);
export const mediaConfig = computed(() => config.value.media);

/** Options bundle for lib/format.ts, derived once instead of at each call site. */
export const timeOpts = computed(() => ({
  locale: config.value.ui.locale,
  timezone: config.value.ui.timezone,
  hour12: config.value.ui.clock === '12h',
}));

/** Room lookup by id, rebuilt only when the rooms list actually changes. */
export const roomsById = computed(() => {
  const map = new Map<string, (typeof DEFAULTS)['rooms'][number]>();
  for (const room of config.value.rooms) map.set(room.id, room);
  return map;
});

export function setConfig(next: DashboardConfig): void {
  config.value = next;
  applyTheme(next);
}

/**
 * Push the config's theme choices into CSS custom properties.
 *
 * Done imperatively on :root rather than through a styled wrapper so that a
 * config change repaints without re-rendering a single component, and so the
 * tokens are available to the inline critical CSS and to elements outside the
 * Preact tree.
 */
function applyTheme(cfg: DashboardConfig): void {
  const root = document.documentElement;
  const accent = sanitizeHex(cfg.ui.accent) ?? '#5B9DFF';
  const rgb = hexToRgb(accent);

  root.style.setProperty('--accent', accent);
  if (rgb) {
    // Chromium 102 has no color-mix(), so the soft/dim variants are derived
    // here in JS instead of in CSS. See docs/ROOMOS.md §1.
    root.style.setProperty('--accent-soft', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.16)`);
    root.style.setProperty('--accent-dim', `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.32)`);
    // Pick black or white text for on-accent surfaces by perceived luminance,
    // so a pale accent doesn't produce unreadable white-on-yellow.
    const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    root.style.setProperty('--accent-text', luminance > 0.6 ? '#08090C' : '#FFFFFF');
  }

  root.style.setProperty('--motion', String(clamp(cfg.ui.motion, 0, 1) || 0.001));
  root.dataset.blur = cfg.ui.blur ? 'on' : 'off';
  document.title = cfg.ui.title;
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : hi;
}

/** Only #rgb / #rrggbb are accepted — anything else falls back to the default. */
function sanitizeHex(value: string): string | null {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : null;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.slice(1);
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  const n = Number.parseInt(h, 16);
  if (Number.isNaN(n)) return null;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
