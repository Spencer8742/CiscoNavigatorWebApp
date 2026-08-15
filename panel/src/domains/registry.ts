import type { EntityState } from '@shared/protocol.ts';
import { domainOf, formatDecimal, humanizeEntityId } from '~/lib/format.ts';
import { ui } from '~/config/index.ts';

/** The configured locale. Read lazily so a config change re-derives values. */
function locale(): string {
  return ui.value.locale;
}

/**
 * The domain registry.
 *
 * **This is the extension point.** Nothing else in the UI knows what a
 * `light` is. Screens ask the registry to describe an entity and render what
 * comes back, so supporting a new Home Assistant domain — `vacuum`,
 * `humidifier`, `water_heater` — means adding one entry here, not touching
 * any screen.
 *
 * This file handles *description*: the icon, the name, the one-line value,
 * and whether the thing is "on". Interactive controls hang off the same
 * table and are added in the next phase; keeping description separate means
 * a domain can appear on a dashboard (correctly labelled, correctly coloured)
 * before anyone writes a control for it.
 */

export type Tone = 'neutral' | 'light' | 'heat' | 'cool' | 'danger' | 'ok';

export interface EntityDescriptor {
  /** Icon name from components/Icon. */
  icon: string;
  /** Display name — friendly_name if HA provides one. */
  name: string;
  /** Short value for a tile: "72%", "21.5 °C", "Open", "Unlocked". */
  value: string;
  /** Drives the "this is on" styling. */
  active: boolean;
  /** HA cannot reach the device, or we cannot reach HA. */
  unavailable: boolean;
  tone: Tone;
}

interface DomainSpec {
  icon: string | ((s: EntityState) => string);
  /** States that count as "on". Defaults to exactly "on". */
  activeStates?: ReadonlySet<string>;
  /** The one-line value. Defaults to a capitalised state string. */
  value?: (s: EntityState) => string;
  tone?: (s: EntityState, active: boolean) => Tone;
}

/* ── Attribute helpers ───────────────────────────────────────────────────
   Home Assistant attributes are `unknown` by contract: an integration can
   put anything in them, and a panel that assumes otherwise crashes on the
   one device that does something odd. Everything is read through a guard. */

function attrString(s: EntityState, key: string): string | undefined {
  const v = s.a[key];
  return typeof v === 'string' ? v : undefined;
}

function attrNumber(s: EntityState, key: string): number | undefined {
  const v = s.a[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function attrBool(s: EntityState, key: string): boolean | undefined {
  const v = s.a[key];
  return typeof v === 'boolean' ? v : undefined;
}

export function friendlyName(s: EntityState | null, entityId: string): string {
  const name = s ? attrString(s, 'friendly_name') : undefined;
  return name ?? humanizeEntityId(entityId);
}

function titleCase(state: string): string {
  if (!state) return '';
  return state.charAt(0).toUpperCase() + state.slice(1).replace(/_/g, ' ');
}

/* ── Domain table ────────────────────────────────────────────────────────*/

const DOMAINS: Record<string, DomainSpec> = {
  light: {
    icon: 'bulb',
    value: (s) => {
      if (s.s !== 'on') return 'Off';
      const brightness = attrNumber(s, 'brightness');
      // HA reports brightness 0-255; a panel should show percent.
      if (brightness === undefined) return 'On';
      return `${Math.max(1, Math.round((brightness / 255) * 100))}%`;
    },
    tone: (_s, active) => (active ? 'light' : 'neutral'),
  },

  switch: {
    icon: 'power',
    value: (s) => (s.s === 'on' ? 'On' : 'Off'),
  },

  input_boolean: {
    icon: 'power',
    value: (s) => (s.s === 'on' ? 'On' : 'Off'),
  },

  fan: {
    icon: 'fan',
    value: (s) => {
      if (s.s !== 'on') return 'Off';
      const pct = attrNumber(s, 'percentage');
      if (pct !== undefined) return `${Math.round(pct)}%`;
      return attrString(s, 'preset_mode') ?? 'On';
    },
  },

  cover: {
    icon: 'blinds',
    activeStates: new Set(['open', 'opening']),
    value: (s) => {
      const pos = attrNumber(s, 'current_position');
      if (s.s === 'opening') return 'Opening';
      if (s.s === 'closing') return 'Closing';
      // 0 and 100 read better as words; everything between wants the number.
      if (pos !== undefined && pos > 0 && pos < 100) return `${Math.round(pos)}%`;
      return s.s === 'open' ? 'Open' : 'Closed';
    },
  },

  climate: {
    icon: 'thermometer',
    // "off" is the only genuinely inactive HVAC state; heat/cool/auto/dry/
    // fan_only all mean the system is doing something.
    activeStates: new Set(['heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only']),
    value: (s) => {
      const current = attrNumber(s, 'current_temperature');
      const target = attrNumber(s, 'temperature');
      const l = locale();
      // Both sides at the same precision — showing "20.4° → 22°" when the
      // target is 21.5 is not a rounding nicety, it is wrong.
      if (current !== undefined && target !== undefined) {
        return `${formatDecimal(current, l)}° → ${formatDecimal(target, l)}°`;
      }
      if (current !== undefined) return `${formatDecimal(current, l)}°`;
      return titleCase(s.s);
    },
    tone: (s) => {
      const action = attrString(s, 'hvac_action') ?? s.s;
      if (action === 'heating' || action === 'heat') return 'heat';
      if (action === 'cooling' || action === 'cool') return 'cool';
      return 'neutral';
    },
  },

  lock: {
    icon: (s) => (s.s === 'locked' ? 'lock' : 'unlock'),
    activeStates: new Set(['unlocked', 'open', 'opening']),
    value: (s) => titleCase(s.s),
    // An unlocked door is not "on", it is something you want to notice.
    tone: (s) => (s.s === 'locked' ? 'ok' : 'danger'),
  },

  scene: {
    icon: 'scene',
    // A scene's state is the timestamp it was last activated, which is never
    // meaningful to show on a tile.
    value: () => 'Scene',
  },

  script: {
    icon: 'script',
    value: (s) => (s.s === 'on' ? 'Running' : 'Run'),
  },

  automation: {
    icon: 'script',
    value: (s) => (s.s === 'on' ? 'Enabled' : 'Disabled'),
  },

  button: { icon: 'script', value: () => 'Press' },
  input_button: { icon: 'script', value: () => 'Press' },

  sensor: {
    icon: (s) => {
      const cls = attrString(s, 'device_class');
      if (cls === 'temperature') return 'thermometer';
      if (cls === 'humidity') return 'droplet';
      if (cls === 'illuminance') return 'sun';
      if (cls === 'power' || cls === 'energy') return 'power';
      return 'dots';
    },
    // A sensor is never "on" — highlighting a temperature reading as active
    // would be meaningless.
    activeStates: new Set(),
    value: (s) => {
      const unit = attrString(s, 'unit_of_measurement');
      const numeric = Number.parseFloat(s.s);
      if (Number.isFinite(numeric)) {
        // Temperature always keeps its decimal — "20°C" when the room is
        // 20.4°C is the kind of small lie that makes a panel feel cheap.
        // Everything else keeps one only when the magnitude is small, so
        // "842 W" does not become "842.3 W".
        const maxDecimals =
          attrString(s, 'device_class') === 'temperature' || Math.abs(numeric) < 10 ? 1 : 0;
        const rounded = formatDecimal(numeric, locale(), maxDecimals);
        // "20.4°C" has no space; "842 W" does.
        return unit ? `${rounded}${unit.startsWith('°') ? '' : ' '}${unit}` : rounded;
      }
      return titleCase(s.s);
    },
  },

  binary_sensor: {
    icon: (s) => {
      const cls = attrString(s, 'device_class');
      if (cls === 'motion' || cls === 'occupancy' || cls === 'presence') return 'motion';
      if (cls === 'door' || cls === 'garage_door' || cls === 'opening') return 'door';
      if (cls === 'window') return 'blinds';
      if (cls === 'moisture') return 'droplet';
      return 'dots';
    },
    value: (s) => {
      if (s.s !== 'on' && s.s !== 'off') return titleCase(s.s);
      const on = s.s === 'on';
      // HA's device_class defines what on/off MEAN, and "On" for a door
      // sensor is actively confusing.
      switch (attrString(s, 'device_class')) {
        case 'motion':
        case 'occupancy':
        case 'presence':
          return on ? 'Detected' : 'Clear';
        case 'door':
        case 'garage_door':
        case 'window':
        case 'opening':
          return on ? 'Open' : 'Closed';
        case 'moisture':
          return on ? 'Wet' : 'Dry';
        case 'problem':
          return on ? 'Problem' : 'OK';
        case 'connectivity':
          return on ? 'Connected' : 'Disconnected';
        case 'battery':
          return on ? 'Low' : 'OK';
        default:
          return on ? 'On' : 'Off';
      }
    },
    tone: (s) => {
      if (s.s !== 'on') return 'neutral';
      const cls = attrString(s, 'device_class');
      return cls === 'problem' || cls === 'safety' || cls === 'gas' || cls === 'smoke'
        ? 'danger'
        : 'neutral';
    },
  },

  media_player: {
    icon: 'speaker',
    activeStates: new Set(['playing', 'paused', 'on', 'buffering']),
    value: (s) => {
      if (s.s === 'off' || s.s === 'standby') return 'Off';
      if (s.s === 'idle') return 'Idle';
      const title = attrString(s, 'media_title');
      if (title) return title;
      return titleCase(s.s);
    },
  },

  input_number: {
    icon: 'dots',
    activeStates: new Set(),
    value: (s) => {
      const n = Number.parseFloat(s.s);
      const unit = attrString(s, 'unit_of_measurement');
      if (!Number.isFinite(n)) return s.s;
      const text = formatDecimal(n, locale(), 2);
      return unit ? `${text} ${unit}` : text;
    },
  },

  input_select: {
    icon: 'dots',
    activeStates: new Set(),
    value: (s) => titleCase(s.s),
  },

  weather: {
    icon: (s) => {
      if (s.s.includes('sunny') || s.s.includes('clear')) return 'sun';
      if (s.s.includes('rain') || s.s.includes('pouring')) return 'droplet';
      return 'cloud';
    },
    activeStates: new Set(),
    value: (s) => {
      const temp = attrNumber(s, 'temperature');
      return temp !== undefined ? `${formatDecimal(temp, locale(), 0)}°` : titleCase(s.s);
    },
  },
};

/** Used for any domain not in the table above. */
const FALLBACK: DomainSpec = {
  icon: 'dots',
  value: (s) => titleCase(s.s),
};

const DEFAULT_ACTIVE = new Set(['on']);

/**
 * Describe an entity for display.
 *
 * Accepts null so a screen can render a tile for an entity that Home
 * Assistant has not sent yet — during startup, or because of a typo in
 * `dashboard.yaml`. It shows as unavailable rather than crashing or
 * disappearing, which is what makes a missing entity diagnosable while
 * standing in front of the panel.
 */
export function describe(
  state: EntityState | null,
  entityId: string,
  /**
   * Display name from `dashboard.yaml`, if one was given. It wins over Home
   * Assistant's `friendly_name`, which is written for a list rather than a
   * tile — "Living Room Ceiling Light Bulb 3" is accurate and unreadable at
   * 13rem wide.
   */
  nameOverride?: string,
): EntityDescriptor {
  const domain = domainOf(entityId);
  const spec = DOMAINS[domain] ?? FALLBACK;
  const name = nameOverride ?? friendlyName(state, entityId);

  if (!state || state.s === 'unavailable' || state.s === 'unknown') {
    return {
      icon: typeof spec.icon === 'string' ? spec.icon : 'dots',
      name,
      value: state?.s === 'unknown' ? 'Unknown' : 'Unavailable',
      active: false,
      unavailable: true,
      tone: 'neutral',
    };
  }

  const activeStates = spec.activeStates ?? DEFAULT_ACTIVE;
  const active = activeStates.has(state.s);

  return {
    icon: typeof spec.icon === 'function' ? spec.icon(state) : spec.icon,
    name,
    value: spec.value ? spec.value(state) : titleCase(state.s),
    active,
    unavailable: false,
    tone: spec.tone ? spec.tone(state, active) : active ? 'ok' : 'neutral',
  };
}

/** True when this domain has any interactive control at all. */
export function isControllable(entityId: string): boolean {
  const domain = domainOf(entityId);
  return domain in DOMAINS && !NON_INTERACTIVE.has(domain);
}

const NON_INTERACTIVE = new Set(['sensor', 'binary_sensor', 'weather']);

/**
 * Domains that count toward a room's "N on" badge.
 *
 * Narrower than `active`, deliberately. `active` is a styling concept — an
 * unlocked lock and an open blind are both highlighted, because both are
 * things you might want to notice. But "Outside · 1 on" for an unlocked front
 * door is simply wrong: nothing in that room is switched on.
 *
 * The badge answers one question — "is anything still running out there?" —
 * so it counts only things that consume power or make noise. Door and blind
 * state has its own, better channel: the alerts on the Home screen.
 */
const COUNTS_AS_ON = new Set(['light', 'switch', 'fan', 'media_player', 'climate', 'input_boolean']);

export function countsAsOn(entityId: string): boolean {
  return COUNTS_AS_ON.has(domainOf(entityId));
}

export { attrString, attrNumber, attrBool };
