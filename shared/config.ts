/**
 * The shape of `config/dashboard.yaml`, after the server has validated it.
 *
 * Shared verbatim between backend and panel so the two can never drift.
 * The backend is the only thing that parses YAML; the panel receives this
 * already-validated object over the wire.
 */

export type NavPosition = 'left' | 'bottom';
export type ClockFormat = '24h' | '12h';

export interface UiConfig {
  title: string;
  navPosition: NavPosition;
  clock: ClockFormat;
  timezone: string;
  locale: string;
  /** backdrop-filter. Off by default — see docs/ROOMOS.md §2. */
  blur: boolean;
  /** Global animation scale, 0..1. 0 disables all motion. */
  motion: number;
  /** Plain hex. Chromium 102 has no color-mix()/oklch(). */
  accent: string;
}

export interface IdleOverlays {
  clock: boolean;
  date: boolean;
  weather: boolean;
  nowPlaying: boolean;
  photoInfo: boolean;
}

export interface IdleConfig {
  /** Seconds of inactivity before the screensaver. 0 disables. */
  timeoutSeconds: number;
  /** Seconds of inactivity before returning to Home. 0 disables. */
  returnHomeSeconds: number;
  overlays: IdleOverlays;
  burnInProtection: boolean;
}

export type ImmichSource =
  | { type: 'random' }
  | { type: 'favorites' }
  | { type: 'album'; id: string; name?: string }
  | { type: 'recent'; days: number };

export interface ImmichConfig {
  enabled: boolean;
  intervalSeconds: number;
  transitionMs: number;
  sources: ImmichSource[];
  imagesOnly: boolean;
  maxAgeYears?: number;
}

export interface RoomConfig {
  id: string;
  name: string;
  icon: string;
  entities: string[];
}

export interface StatusItem {
  entity: string;
  label?: string;
}

export interface AlertRule {
  entity: string;
  /** Alert when the entity's state equals this string. */
  when: string;
  label: string;
}

export interface HomeConfig {
  favorites: string[];
  scenes: string[];
  status: StatusItem[];
  weather?: string;
  alerts: AlertRule[];
}

export interface MediaPlayerConfig {
  entity: string;
  name?: string;
}

export interface MediaConfig {
  players: MediaPlayerConfig[];
  /** 'active' picks whatever is playing, else the first entry. */
  default: string;
  volumeStep: number;
}

export interface DashboardConfig {
  version: 1;
  ui: UiConfig;
  idle: IdleConfig;
  immich: ImmichConfig;
  rooms: RoomConfig[];
  home: HomeConfig;
  media: MediaConfig;
}

/**
 * Every entity ID the config references, from every section.
 *
 * This is the backend's service allow-list: a `call_service` naming an entity
 * outside this set is refused. It means a tampered or compromised panel can
 * only reach things you deliberately put on the dashboard — it cannot, for
 * example, discover and unlock a door that was never configured.
 */
export function allReferencedEntities(cfg: DashboardConfig): Set<string> {
  const out = new Set<string>();
  const add = (id?: string | null) => {
    if (typeof id === 'string' && id.includes('.')) out.add(id);
  };

  for (const room of cfg.rooms) room.entities.forEach(add);
  cfg.home.favorites.forEach(add);
  cfg.home.scenes.forEach(add);
  cfg.home.status.forEach((s) => add(s.entity));
  cfg.home.alerts.forEach((a) => add(a.entity));
  add(cfg.home.weather);
  cfg.media.players.forEach((p) => add(p.entity));

  return out;
}
