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
  /**
   * Show two portrait photos side by side instead of one centred with empty
   * bars beside it.
   *
   * A portrait photo on a 16:9 panel uses about a third of the screen; the
   * rest is filler. Pairing fills it with a second photo instead. Landscape
   * photos are never paired — they already fill the screen.
   */
  pairPortraits: boolean;
  /**
   * How often the Home screen's photo card changes, in seconds. 0 holds one
   * photo until you leave the screen.
   *
   * Separate from `intervalSeconds` because they are different jobs: the
   * slideshow is the thing you are looking at, while this is a card you
   * glance past. A 45-second slideshow cadence is restless on a card, and a
   * 15-second card cadence is frantic full-screen.
   */
  homeCardSeconds: number;
}

/**
 * A reference to one Home Assistant entity, with an optional display name.
 *
 * In YAML this may be written either way:
 *
 *   entities:
 *     - light.kitchen_ceiling                    # use HA's friendly_name
 *     - entity: light.kitchen_under_cabinet      # override it
 *       name: Under Cabinet
 *
 * The override exists because Home Assistant's friendly names are generated
 * for a list, not for a tile: "Living Room Ceiling Light Bulb 3" is accurate
 * and useless on a 13rem card. The backend normalises both forms to this
 * shape, so the panel never has to care which was written.
 */
export interface EntityRef {
  entity: string;
  /** Overrides HA's friendly_name when present. */
  name?: string;
}

export interface RoomConfig {
  id: string;
  name: string;
  icon: string;
  entities: EntityRef[];
}

export interface StatusItem {
  entity: string;
  /** Overrides HA's friendly_name. `name:` is accepted as an alias. */
  label?: string;
}

export interface AlertRule {
  entity: string;
  /** Alert when the entity's state equals this string. */
  when: string;
  label: string;
}

export interface HomeConfig {
  favorites: EntityRef[];
  scenes: EntityRef[];
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
  /**
   * Section headings for the player list, in the order they appear.
   *
   * Names live here rather than being typed at the panel because naming is a
   * typing job and the RoomOS soft keyboard has no numeric, date or colour
   * modes and, in Cisco's own words, "does not encourage a lot of text input"
   * (docs/ROOMOS.md §6). Which speaker goes in which section IS a tapping job,
   * so that is done on the panel and stored in panel-prefs.json.
   */
  sections: string[];
}

/**
 * Cast mode: what a Google Nest Hub shows.
 *
 * A Nest Hub cannot run this dashboard — Fuchsia has no browser — so the only
 * way onto that screen is to cast a page to it, and a cast page is a display
 * rather than a control surface. Cast mode is therefore a separate, simpler
 * view: a few panes that rotate on their own, sized to be read from across the
 * room rather than tapped.
 */
export interface CastConfig {
  /** Panes to rotate through, in order. An empty list disables cast mode. */
  panes: CastPane[];
  /** Seconds each pane holds before the next one. */
  rotateSeconds: number;
  /**
   * Skip straight to whatever is playing when music starts, and stay there.
   *
   * A display in the kitchen showing the weather while someone is choosing
   * music is showing the wrong thing.
   */
  followMusic: boolean;
  /**
   * Play a silent audio loop to hold the cast session open.
   *
   * OFF by default, and worth understanding before turning on: it takes the
   * device's audio focus, which on a Nest Hub that is ALSO a Music Assistant
   * speaker may interrupt or block playback on that speaker. Only reach for
   * it if `disableIdleTimeout` alone is not holding the session.
   */
  audioKeepAlive: boolean;
}

export type CastPane = 'clock' | 'status' | 'media' | 'photos';

export const CAST_PANES: readonly CastPane[] = ['clock', 'status', 'media', 'photos'];

export interface DashboardConfig {
  version: 1;
  ui: UiConfig;
  idle: IdleConfig;
  immich: ImmichConfig;
  rooms: RoomConfig[];
  home: HomeConfig;
  media: MediaConfig;
  cast: CastConfig;
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

  for (const room of cfg.rooms) room.entities.forEach((e) => add(e.entity));
  cfg.home.favorites.forEach((e) => add(e.entity));
  cfg.home.scenes.forEach((e) => add(e.entity));
  cfg.home.status.forEach((s) => add(s.entity));
  cfg.home.alerts.forEach((a) => add(a.entity));
  add(cfg.home.weather);
  cfg.media.players.forEach((p) => add(p.entity));

  return out;
}
