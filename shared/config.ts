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
  /**
   * How long the Controls screen holds BOTH of the above off. 0 disables the
   * hold, so Controls idles like any other screen.
   *
   * The Controls screen is the one place on the panel that is useful while
   * nobody is touching it: you are in a call, the hang-up and mute keys are
   * on screen, and the panel wandering off to a photo of a beach is the panel
   * being wrong. Everywhere else, going quiet is correct.
   *
   * It is a HOLD rather than an exemption because the panel cannot know when
   * you are finished. RoomOS gives a web page no call state (docs/ROOMOS.md
   * §8), so "stay awake until the call ends" is not available — and a panel
   * left showing a static grid of keys forever is a burn-in risk on a device
   * that runs for months, and never shows photos again. So it holds
   * generously, then resumes normal behaviour.
   */
  controlsHoldSeconds: number;
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
  /**
   * How a Cast display reaches this dashboard — scheme, host and port, with
   * no path: `http://192.168.1.71:8099`.
   *
   * It cannot be inferred. The backend knows the port it bound and nothing
   * else; `localhost` is the container, and a `.local` name is resolved by a
   * Nest Hub through Google rather than over your LAN. So the one address
   * that works is the LAN address of the machine running this, written down.
   *
   * Empty means the backend never casts anything. Cast mode still works — you
   * can always point something at `/?cast=1` yourself.
   */
  baseUrl: string;
  /**
   * Displays to keep the dashboard on. Empty means the backend casts nothing.
   */
  displays: CastDisplay[];
  /**
   * Seconds between checks. 0 turns the keeper off without deleting the
   * display list.
   *
   * A display already showing the dashboard is left strictly alone, so this
   * costs one short connection per display per interval and never causes a
   * visible reload.
   */
  checkSeconds: number;
  /**
   * Let a `pane: dashboard` display fall into the photo screensaver when it
   * has been idle for `idle.timeoutSeconds`, exactly as the Navigator does.
   *
   * Only affects displays showing the full dashboard. The rotating panes have
   * their own idea of what to show, and `photos` is already a slideshow.
   *
   * The reason this is a switch rather than simply always on: the screensaver
   * is dismissed by touch. A Hub delivers touch today, but Google has never
   * promised to, and on one that stopped, a display that has gone to photos
   * would stay there. That is a slideshow rather than a disaster — but if a
   * Hub is your wall control panel, you may want it to always be one.
   */
  screensaver: boolean;
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
   * device's audio focus, which on a Nest Hub that is ALSO a
   * speaker may interrupt or block playback on that speaker. Only reach for
   * it if `disableIdleTimeout` alone is not holding the session.
   */
  audioKeepAlive: boolean;
}

export type CastPane = 'clock' | 'status' | 'media' | 'photos';

export const CAST_PANES: readonly CastPane[] = ['clock', 'status', 'media', 'photos'];

/**
 * What a single display shows: one pinned pane, or the whole dashboard.
 *
 * `dashboard` is the real, interactive UI rather than the cast panes — a Nest
 * Hub's touchscreen works on a cast page, so a Hub can be a small Navigator
 * instead of a slideshow. The panes remain the better choice for a display
 * that is glanced at from across a room.
 */
export type CastTarget = CastPane | 'dashboard';

export const CAST_TARGETS: readonly CastTarget[] = [...CAST_PANES, 'dashboard'];

/**
 * One Google Nest Hub (or any Cast display) that the backend keeps the
 * dashboard on.
 *
 * A Hub cannot be told to remember anything: every reboot, voice answer and
 * timer takes the screen back, and the cast session that was showing the
 * dashboard is simply gone. Listing a display here means the backend notices
 * and casts it again.
 */
export interface CastDisplay {
  /**
   * The device's address on your LAN, optionally with a port —
   * `192.168.1.42`, or `192.168.1.42:8009`.
   *
   * Prefer an IP. Cast devices are normally found by name over mDNS, and mDNS
   * does not cross a Docker bridge network; an IP needs no discovery at all,
   * which is what lets this run in the ordinary container rather than a
   * host-networked one. The port is only ever worth writing for a test
   * double — real devices all listen on 8009.
   */
  host: string;
  /** A label for the log. Cosmetic; the host is what is connected to. */
  name?: string;
  /**
   * What this display shows. Omit for the rotation configured in `panes`.
   */
  pane?: CastTarget;
}

/* ── Controls ──────────────────────────────────────────────────────────────

   The old Room Navigator macro's UI Extension panels, rebuilt as config.

   A Room Bar previously ran a JavaScript macro that mapped Navigator widget
   taps onto HTTP calls: Bitfocus Companion button presses, Home Assistant
   webhooks, and Elgato Key Lights. A factory reset destroyed all of it —
   macro, panel XML and HttpClient config all live on the device and none of
   it has a single artefact to reapply.

   So the buttons live here instead. The device holds one URL; this file holds
   the button map; and a reset costs a re-provision rather than an evening.

   The important structural rule: a button is identified to the backend by
   ITS ID, never by the request it makes. The panel cannot ask the backend to
   press Companion page 3 button 7 — it can only ask it to run
   `deskpro.hangup`, which the backend then looks up here. Same reasoning as
   the Home Assistant entity allow-list in allReferencedEntities() below: a
   panel on a wall is trusted to drive the dashboard, not to compose
   arbitrary requests to things on the LAN. */

/**
 * What a button does when tapped.
 *
 * Deliberately small. Each variant is one HTTP call whose shape is fixed by
 * the far end, so there is nothing to configure beyond which one.
 */
export type ControlAction =
  /**
   * Press a Bitfocus Companion button by its grid location.
   *
   * `POST /api/location/<page>/<row>/<column>/press` — Companion 4.x. The
   * coordinates are Companion's own and are re-derived from a config export;
   * they are not stable across a Companion page rearrangement.
   */
  | { kind: 'companion'; page: number; row: number; column: number }
  /**
   * Fire a Home Assistant webhook: `POST /api/webhook/<id>`.
   *
   * Webhooks are unauthenticated by design — the id IS the secret — so this
   * needs no token beyond the HA base URL the backend already holds. It is
   * also the only way to reach an automation that has no entity to call.
   */
  | { kind: 'webhook'; id: string }
  /** Drive an Elgato Key Light listed in `controls.keylights`. */
  | { kind: 'keylight'; light: string; op: KeyLightOp; value?: number }
  /**
   * Drive a television listed in `controls.tvs`, over its own protocol.
   *
   * `power` decides its direction from whether the set answers; `input`
   * switches to a named socket, and `next` cycles the configured inputs,
   * which is what a two-input room actually wants from one key.
   */
  | { kind: 'tv'; tv: string; op: 'on' | 'off' | 'toggle' | 'input' | 'next'; input?: string }
  /**
   * Call a Home Assistant service, exactly as a dashboard tile does.
   *
   * Goes through the same ServiceGuard as everything else, and the entity is
   * added to the allow-list by allReferencedEntities(), so putting a scene on
   * a macro page grants no more than putting it on Home does.
   */
  | { kind: 'entity'; entity: string; service: string; data?: Record<string, unknown> };

export type KeyLightOp = 'toggle' | 'on' | 'off' | 'brightness' | 'temperature';

export const KEY_LIGHT_OPS: readonly KeyLightOp[] = [
  'toggle',
  'on',
  'off',
  'brightness',
  'temperature',
];

/** Colour weight of a button. `danger` is for hang-up and all-off. */
export type ControlTone = 'default' | 'accent' | 'danger';

export const CONTROL_TONES: readonly ControlTone[] = ['default', 'accent', 'danger'];

export interface ControlButton {
  type: 'button';
  /**
   * Stable within the whole config. Generated from the page id and position
   * when not written by hand — but write one for any button you might later
   * reorder, because the generated form moves with the button.
   */
  id: string;
  name: string;
  icon: string;
  tone: ControlTone;
  /** Twice the width in the grid, for a primary action like Join. */
  wide: boolean;
  /**
   * What the press does. More than one runs in order, stopping at the first
   * failure.
   *
   * A list because one key is often one INTENTION carried out in several
   * places: "power the office on" is a Companion macro and a television that
   * Companion cannot reach. Splitting that across two keys makes the person
   * pressing them responsible for remembering the pair.
   */
  actions: ControlAction[];
}

/**
 * A full Elgato Key Light control: power, brightness, colour temperature.
 *
 * Not expressible as buttons, because it shows state. The old macro's slider
 * sent a 0–255 widget value that the macro rescaled; here brightness is 0–100
 * end to end, which is what the light actually speaks.
 */
export interface ControlLight {
  type: 'light';
  id: string;
  /** A key light id from `controls.keylights`, or `all` for every one. */
  light: string;
  name: string;
}

/**
 * A key that opens a picker of a media player's inputs.
 *
 * The list is NOT configured. It comes from the entity's own `source_list`,
 * so it is whatever Home Assistant currently believes the device offers —
 * rename an input on the TV and the panel follows without an edit here. A
 * hand-written list would be a second copy of something the device already
 * knows, and second copies go stale.
 */
export interface ControlSources {
  type: 'sources';
  id: string;
  name: string;
  icon: string;
  /** A `media_player` entity that publishes `source_list`. */
  entity: string;
  /**
   * The inputs to offer, in order, optionally renamed. Empty = offer
   * whatever the device currently reports.
   *
   * Two things a raw `source_list` cannot do. It lists everything the TV
   * knows about — Live TV, every streaming app — when the question being
   * asked is "which box am I looking at". And it names them the way the
   * HDMI spec does rather than the way the room does: "HDMI 3" is only
   * meaningful if you remember what is plugged into it.
   *
   * Curating also makes the picker work while the TV is OFF, which is
   * exactly when you want it: source_list is usually empty then, but a list
   * written here is an assertion that does not depend on the device
   * answering.
   */
  inputs: SourceRef[];
}

/**
 * One input, optionally renamed for the room rather than the cable.
 *
 * In YAML, either form, mixed freely — the same shape as `EntityRef`:
 *
 *   inputs:
 *     - HDMI 1                              # shown as-is
 *     - { source: HDMI 3, name: Mac Studio }
 */
export interface SourceRef {
  /** Must match the device's own source name exactly. */
  source: string;
  /** What the key says. Defaults to `source`. */
  name?: string;
}

/**
 * A whole RoomOS device, as one full-width tile.
 *
 * The Room Bar and the Desk Pro are the one thing on this panel that a grid
 * of keys genuinely cannot express: they have a meeting list, live occupancy
 * and noise, four independent mute states, a volume, and a share source —
 * and unlike a Companion key, every one of those reports back. So this is a
 * tile with real state rather than a page of fire-and-forget buttons, and it
 * replaces the Companion call keys rather than sitting beside them.
 *
 * Every slot is optional and independent. A device missing an entity simply
 * does not render that control, which is what lets the same tile describe a
 * Desk Pro with a calendar and a Room Kit Mini without one.
 *
 * Entity ids come from Spencer8742/HomeAssistantCiscoRoomOS. Writing 25 of
 * them by hand is nobody's idea of a good time, so `prefix:` derives the lot
 * from the device's slug and any slot may still be written out to override
 * the guess — see deviceEntities() in the loader.
 */
export interface ControlDevice {
  type: 'device';
  id: string;
  /** Shown as the tile's heading. */
  name: string;
  entities: DeviceEntities;
  /**
   * Extra keys drawn in the tile's toggle row.
   *
   * For the things the RoomOS integration does not expose but the device can
   * still be made to do another way — camera on/off, notably, which has no
   * entity and has to go through Companion. They belong in the row because
   * that is where someone looks for them, not at the bottom of the page with
   * the room macros.
   *
   * They are ordinary buttons and they look it: no state, a confirmation tick
   * on press. A Companion press has no feedback, and a key that borrowed the
   * lit-up look of the real toggles beside it would be claiming to know
   * something it cannot.
   */
  keys: ControlButton[];
}

/**
 * The entities a device tile reads and drives. All optional.
 *
 * Grouped the way the tile is: what it shows, what it toggles, what it
 * presses.
 */
export interface DeviceEntities {
  /* ── Read ──────────────────────────────────────────────────────────────*/
  /** `sensor.*_standby_state` — Awake / Standby / Halfwake. */
  standby?: string;
  /** `sensor.*_ambient_noise`, in dBA. */
  noise?: string;
  /** `sensor.*_people_count`. */
  people?: string;
  /**
   * `sensor.*_next_meeting`. Its `meetings` attribute carries the whole list:
   * title, start_time, end_time, organizer, joinable.
   */
  meetings?: string;
  /** `sensor.*_uptime`, in seconds. */
  uptime?: string;
  /** `sensor.*_ip_address`. */
  ip?: string;
  /** `sensor.*_software_version`. */
  version?: string;
  /** `sensor.*_active_alerts`. */
  alerts?: string;
  /** `binary_sensor.*_in_call` — decides which share button is offered. */
  inCall?: string;
  /** `binary_sensor.*_sharing_content`. */
  sharing?: string;

  /* ── Toggle ────────────────────────────────────────────────────────────*/
  /** `switch.*_microphone_mute`. ON means MUTED, as the integration reports it. */
  mic?: string;
  /** `switch.*_speaker_mute`. ON means MUTED. */
  speaker?: string;
  /** `switch.*_do_not_disturb`. */
  dnd?: string;
  /**
   * `switch.*_camera_mute` — the OUTGOING camera.
   *
   * Not `selfview`, which is the local preview: turning that off leaves the
   * camera running and the room on screen at the far end. Requires the
   * integration's camera mute switch (0.6.0+); before that there was no
   * entity for this and the only way to drive a camera was a Companion key.
   */
  camera?: string;
  /** `switch.*_selfview` — the local preview picture, not the camera. */
  selfview?: string;

  /* ── Set ───────────────────────────────────────────────────────────────*/
  /** `number.*_volume`. */
  volume?: string;
  /** `select.*_share_source`. */
  shareSource?: string;

  /* ── Press ─────────────────────────────────────────────────────────────*/
  /** `button.*_wake_up`. */
  wake?: string;
  /** `button.*_standby`. */
  sleep?: string;
  /** `button.*_answer_call`. */
  answer?: string;
  /** `button.*_hang_up`. */
  hangUp?: string;
  /**
   * `button.*_join_next_meeting`.
   *
   * The integration offers no per-booking join, so this joins whichever
   * meeting is next — which is why the tile puts Join on the next meeting's
   * row alone rather than on every row.
   */
  join?: string;
  /** `button.*_refresh_meetings`. */
  refreshMeetings?: string;
  /** `button.*_share_locally`. */
  shareLocal?: string;
  /** `button.*_share_to_call`. */
  shareToCall?: string;
  /** `button.*_stop_sharing`. */
  stopSharing?: string;
}

export type ControlItem = ControlButton | ControlLight | ControlSources | ControlDevice;

export interface ControlPage {
  id: string;
  name: string;
  icon: string;
  /**
   * Keys across. 0 lets the grid fit as many as the panel holds.
   *
   * Worth setting whenever a page's keys come in pairs. Auto-fitting packs
   * as many 8rem keys per row as fit and wraps wherever it runs out, which
   * on an eight-key page left seven on one row and one stranded on the next
   * — and put Shut Down next to Vol +, which are not related to each other.
   * Naming the count puts the wrap where the meaning is.
   */
  columns: number;
  /**
   * Key height. `lg` roughly doubles it.
   *
   * A page of eight keys on a 10.1" panel has room to spare, and a bigger
   * target is a better target on a screen someone stabs at mid-call without
   * looking straight at it.
   */
  size: ControlSize;
  items: ControlItem[];
}

export type ControlSize = 'md' | 'lg';

export const CONTROL_SIZES: readonly ControlSize[] = ['md', 'lg'];

/**
 * One Elgato Key Light on the LAN.
 *
 * Addressed rather than discovered, for the same reason cast displays are:
 * these are found by mDNS, mDNS does not cross a Docker bridge network, and
 * an IP needs no discovery at all.
 */
export interface KeyLightConfig {
  id: string;
  name: string;
  /** `192.168.1.201` or `192.168.1.201:9123`. Port defaults to 9123. */
  host: string;
}

/**
 * An LG webOS television, spoken to directly rather than through Home
 * Assistant.
 *
 * Same reasoning as the key lights above: this is a transport control on a
 * panel sitting in front of the thing it controls, and every hop is somewhere
 * the press can die. The TV speaks a documented protocol on its own IP, so
 * there is nothing to gain by asking something else to ask it.
 */
export interface TvConfig {
  id: string;
  name: string;
  /**
   * The TV's address. webOS listens on 3000, so `192.168.1.67` is enough;
   * `192.168.1.67:3000` is accepted too, like the key lights and cast
   * displays.
   */
  host: string;
  /**
   * The TV's MAC, needed ONLY to turn it on.
   *
   * A webOS set that is off has its network stack down, so there is nothing
   * to send a command to — the only way back on is a Wake-on-LAN packet.
   * Without this, power off works and power on cannot. The TV also has to be
   * set to listen for it: "Quick Start+", or Network > "TV On with Mobile"
   * on older sets.
   */
  mac?: string;
  /**
   * Broadcast address for that packet. Defaults to 255.255.255.255, which is
   * right unless the panel's host is on a different subnet from the TV — in
   * which case a directed broadcast like 192.168.1.255 is what reaches it.
   */
  broadcast?: string;
  /**
   * The inputs to offer, in order, optionally renamed.
   *
   * webOS names inputs by socket id — HDMI_2, not "HDMI 2" — and reports
   * every one whether anything is plugged in or not. Curating here answers
   * "which box am I looking at" instead, and keeps the picker useful while
   * the TV is off, when it cannot be asked.
   */
  inputs: SourceRef[];
}

export interface ControlsConfig {
  pages: ControlPage[];
  keylights: KeyLightConfig[];
  tvs: TvConfig[];
  /**
   * Seconds between key light state polls. 0 stops polling.
   *
   * Elgato lights push nothing, so the only way to know a light was turned
   * off at the light is to ask. Polling only runs while a panel is connected,
   * and every command refreshes immediately regardless of this — so this is
   * about noticing changes made elsewhere, not about the panel's own
   * controls feeling responsive.
   */
  pollSeconds: number;
}

export interface DashboardConfig {
  version: 1;
  ui: UiConfig;
  idle: IdleConfig;
  immich: ImmichConfig;
  rooms: RoomConfig[];
  home: HomeConfig;
  media: MediaConfig;
  cast: CastConfig;
  controls: ControlsConfig;
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

  // A macro button that calls a service is subject to the same allow-list as
  // a tile — putting a scene on a Scenes page is what grants the panel
  // permission to fire it, and nothing else does.
  for (const page of cfg.controls.pages) {
    for (const item of page.items) {
      if (item.type === 'button') {
        for (const action of item.actions) {
          if (action.kind === 'entity') add(action.entity);
        }
      }
      // A source picker both READS the entity (for source_list) and calls
      // select_source on it, so it needs the same allow-listing as a tile.
      if (item.type === 'sources') add(item.entity);
      // A device tile reads a dozen entities and drives another dozen. All of
      // them go on the allow-list — the ones it only reads as well, because
      // the store filters the panel's snapshot by this same set and the tile
      // would otherwise have nothing to display.
      if (item.type === 'device') {
        Object.values(item.entities).forEach(add);
        // A tile's own keys are keys: one calling a service needs the same
        // allow-listing as one sitting in the grid below.
        for (const key of item.keys) {
          for (const action of key.actions) {
            if (action.kind === 'entity') add(action.entity);
          }
        }
      }
    }
  }

  return out;
}
