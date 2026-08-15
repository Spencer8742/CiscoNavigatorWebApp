import { logger } from '~/lib/log.ts';
import type { HaClient } from '~/ha/client.ts';
import type { HaStore } from '~/ha/store.ts';

const log = logger('ha-services');

/**
 * The guard between a panel and Home Assistant.
 *
 * A panel is a device on a wall that anyone in the room can touch, and whose
 * bearer token travels over the LAN. It is trusted to *drive the dashboard*,
 * not to issue arbitrary commands to the house. So every call is checked
 * against two independent limits:
 *
 *  1. **The entity must be named in `dashboard.yaml`.** This is the important
 *     one. Home Assistant's own API would happily let a caller enumerate
 *     entities and unlock any door it found; this backend will not forward a
 *     call for an entity the config never mentioned.
 *
 *  2. **The domain/service pair must be on this allow-list.** No
 *     `homeassistant.stop`, no `shell_command.*`, no `hassio.*`, no
 *     `recorder.purge`. A dashboard needs about thirty verbs and this is
 *     them.
 *
 * Both checks are cheap and neither can be turned off by configuration. The
 * cost of being wrong here is somebody's front door.
 */

/**
 * Services this panel is permitted to call, by domain.
 *
 * Adding a Home Assistant domain to the UI means adding it here too — that is
 * deliberate friction. It is one line, and it forces the question "should the
 * panel be able to do this?" to be answered once, explicitly.
 */
const ALLOWED: Record<string, ReadonlySet<string>> = {
  light: new Set(['turn_on', 'turn_off', 'toggle']),
  switch: new Set(['turn_on', 'turn_off', 'toggle']),
  fan: new Set([
    'turn_on',
    'turn_off',
    'toggle',
    'set_percentage',
    'set_preset_mode',
    'oscillate',
    'set_direction',
  ]),
  cover: new Set([
    'open_cover',
    'close_cover',
    'stop_cover',
    'set_cover_position',
    'set_cover_tilt_position',
    'open_cover_tilt',
    'close_cover_tilt',
    'stop_cover_tilt',
  ]),
  climate: new Set([
    'set_temperature',
    'set_hvac_mode',
    'set_fan_mode',
    'set_preset_mode',
    'set_humidity',
    'set_swing_mode',
    'turn_on',
    'turn_off',
  ]),
  lock: new Set(['lock', 'unlock', 'open']),
  scene: new Set(['turn_on']),
  script: new Set(['turn_on', 'toggle']),
  automation: new Set(['trigger', 'turn_on', 'turn_off', 'toggle']),
  media_player: new Set([
    'media_play',
    'media_pause',
    'media_play_pause',
    'media_stop',
    'media_next_track',
    'media_previous_track',
    'volume_set',
    'volume_up',
    'volume_down',
    'volume_mute',
    'select_source',
    'select_sound_mode',
    'shuffle_set',
    'repeat_set',
    'turn_on',
    'turn_off',
    // Grouping. Music Assistant implements the standard Home Assistant
    // services, so this is all the app needs to join and separate speakers —
    // no second connection to Music Assistant, no grouping state of our own.
    'join',
    'unjoin',
  ]),
  input_boolean: new Set(['turn_on', 'turn_off', 'toggle']),
  input_number: new Set(['set_value', 'increment', 'decrement']),
  input_select: new Set(['select_option', 'select_next', 'select_previous']),
  input_button: new Set(['press']),
  button: new Set(['press']),
  vacuum: new Set(['start', 'pause', 'stop', 'return_to_base', 'locate']),
  humidifier: new Set(['turn_on', 'turn_off', 'toggle', 'set_humidity', 'set_mode']),
  water_heater: new Set(['set_temperature', 'set_operation_mode', 'turn_on', 'turn_off']),
};

/**
 * Service-data keys a panel may set, per domain.
 *
 * Without this, `light.turn_on` would accept arbitrary keys — including
 * `entity_id`, which would let a caller re-target the call past check (1) by
 * putting a different entity in the payload. That is the specific hole this
 * closes.
 */
const ALLOWED_DATA: Record<string, ReadonlySet<string>> = {
  light: new Set([
    'brightness',
    'brightness_pct',
    'color_temp_kelvin',
    'color_temp',
    'hs_color',
    'rgb_color',
    'rgbw_color',
    'xy_color',
    'effect',
    'transition',
    'flash',
  ]),
  fan: new Set(['percentage', 'preset_mode', 'oscillating', 'direction']),
  cover: new Set(['position', 'tilt_position']),
  climate: new Set([
    'temperature',
    'target_temp_high',
    'target_temp_low',
    'hvac_mode',
    'fan_mode',
    'preset_mode',
    'humidity',
    'swing_mode',
  ]),
  media_player: new Set([
    'volume_level',
    'is_volume_muted',
    'source',
    'sound_mode',
    'shuffle',
    'repeat',
    // `media_player.join` takes the speakers to add. Every id in it is
    // checked against the same allow-list as the target — see below.
    'group_members',
  ]),
  input_number: new Set(['value']),
  input_select: new Set(['option']),
  humidifier: new Set(['humidity', 'mode']),
  water_heater: new Set(['temperature', 'operation_mode']),
  script: new Set(['variables']),
  scene: new Set(['transition']),
};

export interface ServiceCall {
  domain: string;
  service: string;
  entity: string;
  data?: Record<string, unknown>;
}

export class ServiceGuard {
  readonly #client: HaClient;
  readonly #store: HaStore;

  constructor(client: HaClient, store: HaStore) {
    this.#client = client;
    this.#store = store;
  }

  /**
   * Validate and forward. Resolves to an error message for the panel to show,
   * or null on success.
   *
   * Errors returned to the panel are deliberately vague ("Not permitted")
   * while the log line is specific. A panel is not the right place to explain
   * the shape of the allow-list to whoever is standing in front of it.
   */
  async call(call: ServiceCall): Promise<string | null> {
    const { domain, service, entity } = call;

    // (1) The entity must be on the dashboard.
    if (!this.#store.isAllowed(entity)) {
      log.warn(`Refused ${domain}.${service} for "${entity}": not referenced by dashboard.yaml`);
      return 'Not permitted';
    }

    // The entity's own domain must match the service domain, so
    // `lock.unlock` cannot be aimed at a `light.` entity and vice versa.
    const entityDomain = entity.slice(0, entity.indexOf('.'));
    if (entityDomain !== domain) {
      log.warn(`Refused ${domain}.${service} for "${entity}": domain mismatch`);
      return 'Not permitted';
    }

    // (2) The service must be on the allow-list.
    const services = ALLOWED[domain];
    if (!services?.has(service)) {
      log.warn(`Refused ${domain}.${service}: not an allowed service`);
      return 'Not permitted';
    }

    const data = this.#filterData(domain, call.data);

    // (3) `group_members` is a list of ENTITY IDS, so it re-targets the call
    // at every speaker it names. Each one goes through the same check as the
    // target — otherwise allowing this key would hand a compromised panel any
    // media player in the house, which is precisely the hole ALLOWED_DATA
    // exists to close.
    const members = data?.['group_members'];
    if (members !== undefined) {
      if (!Array.isArray(members) || members.some((m) => typeof m !== 'string')) {
        log.warn(`Refused ${domain}.${service}: group_members must be a list of entity ids`);
        return 'Not permitted';
      }
      for (const member of members as string[]) {
        if (!member.startsWith('media_player.') || !this.#store.isAllowed(member)) {
          log.warn(`Refused ${domain}.${service}: "${member}" is not a permitted player`);
          return 'Not permitted';
        }
      }
    }

    try {
      await this.#client.callService(domain, service, entity, data);
      log.debug(`${domain}.${service} → ${entity}`, data ?? {});
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`${domain}.${service} for "${entity}" failed: ${message}`);
      // This one IS worth showing: it is about the device, not about policy.
      return this.#userMessage(message);
    }
  }

  /**
   * Strip anything not on the per-domain data allow-list.
   *
   * Dropping unknown keys rather than rejecting the whole call is deliberate:
   * a future panel version sending a key this backend does not know about
   * should still turn the light on.
   */
  #filterData(
    domain: string,
    data: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!data) return undefined;
    const allowed = ALLOWED_DATA[domain];
    if (!allowed) return undefined;

    const out: Record<string, unknown> = {};
    for (const key in data) {
      if (allowed.has(key)) out[key] = data[key];
      else log.debug(`Dropped disallowed service_data key "${key}" for ${domain}`);
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  #userMessage(raw: string): string {
    if (raw.includes('not connected')) return 'Home Assistant is offline';
    if (raw.includes('did not respond')) return 'Home Assistant did not respond';
    return 'Command failed';
  }
}
