import { logger } from '~/lib/log.ts';
import { KEY_LIGHT_MAX_KELVIN, KEY_LIGHT_MIN_KELVIN } from '@shared/protocol.ts';
import type { KeyLightConfig } from '@shared/config.ts';
import type { KeyLightState } from '@shared/protocol.ts';

const log = logger('keylight');

/**
 * One Elgato Key Light.
 *
 * The whole API is two calls against an unauthenticated HTTP server on port
 * 9123:
 *
 *   GET /elgato/lights  -> { numberOfLights, lights: [{ on, brightness, temperature }] }
 *   PUT /elgato/lights  <- the same shape; fields may be sent individually
 *
 * Two translations happen here and nowhere else:
 *
 * 1. **`on` is 0/1 on the wire**, a boolean everywhere above.
 * 2. **`temperature` is MIREDS on the wire** — 143 to 344, which is 7000 K
 *    down to 2900 K — and Kelvin everywhere above. A number that gets
 *    *smaller* as the light gets warmer is a bug waiting to happen in a UI,
 *    so the panel never sees it.
 *
 * A light that does not answer is not an error state to recover from: it is a
 * light that is switched off at the wall, which is normal. Its last known
 * values are kept and `reachable` goes false, so the control greys out
 * instead of snapping to zero.
 */

/** Elgato's own limits. Sending outside them is rejected by the light. */
const MIRED_MIN = 143; // 7000 K
const MIRED_MAX = 344; // 2900 K

/** LAN devices. A light that has not answered in 4s is off, not slow. */
const TIMEOUT_MS = 4000;

export function kelvinToMired(kelvin: number): number {
  const k = clamp(kelvin, KEY_LIGHT_MIN_KELVIN, KEY_LIGHT_MAX_KELVIN);
  return clamp(Math.round(1_000_000 / k), MIRED_MIN, MIRED_MAX);
}

export function miredToKelvin(mired: number): number {
  const m = clamp(mired, MIRED_MIN, MIRED_MAX);
  // Rounded to 50 K. The mired scale is coarse at the warm end — one step is
  // ~20 K — and a readout that reads 4717 K implies a precision the light
  // does not have.
  const kelvin = Math.round(1_000_000 / m / 50) * 50;
  return clamp(kelvin, KEY_LIGHT_MIN_KELVIN, KEY_LIGHT_MAX_KELVIN);
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}

/** What the light itself sends and accepts. */
interface WireLight {
  on?: number;
  brightness?: number;
  temperature?: number;
}

interface WireBody {
  numberOfLights?: number;
  lights?: WireLight[];
}

/** A change to apply. Omitted fields are left alone by the light. */
export interface KeyLightPatch {
  on?: boolean;
  /** 0–100. */
  brightness?: number;
  /** Kelvin. */
  temperature?: number;
}

export class KeyLight {
  readonly id: string;
  /** Mutable so a rename in dashboard.yaml lands without discarding state. */
  name: string;
  readonly #host: string;
  readonly #url: string;

  /* Last known values, kept across unreachability so the control keeps its
     position rather than collapsing to zero when a light is switched off. */
  #on = false;
  #brightness = 50;
  #temperature = 4500;
  #reachable = false;

  constructor(cfg: KeyLightConfig) {
    this.id = cfg.id;
    this.name = cfg.name;
    // The port is part of the address so a test double can be given one; real
    // lights are always 9123 and nobody should have to write it.
    const host = cfg.host.includes(':') ? cfg.host : `${cfg.host}:9123`;
    this.#host = cfg.host;
    this.#url = `http://${host}/elgato/lights`;
  }

  /**
   * Whether this instance still describes the same light.
   *
   * Used to carry a light's known state across a config reload: an edit to an
   * unrelated part of dashboard.yaml should not flicker every light through
   * "unreachable" on its way back to the state it was already in. The name is
   * deliberately not compared — renaming a light is a label change, which the
   * caller applies to the surviving instance, not a different light.
   */
  matches(cfg: KeyLightConfig): boolean {
    return cfg.id === this.id && cfg.host === this.#host;
  }

  get state(): KeyLightState {
    return {
      id: this.id,
      name: this.name,
      reachable: this.#reachable,
      on: this.#on,
      brightness: this.#brightness,
      temperature: this.#temperature,
    };
  }

  /** Ask the light what it is doing. Returns true if anything changed. */
  async read(): Promise<boolean> {
    const body = await this.#request('GET');
    return this.#absorb(body);
  }

  /**
   * Apply a change, and adopt whatever the light reports back.
   *
   * The PUT response carries the light's resulting state, so this is also the
   * refresh — there is no need to follow a command with a read, and doing so
   * would double the traffic for every button press.
   */
  async apply(patch: KeyLightPatch): Promise<boolean> {
    const light: WireLight = {};
    if (patch.on !== undefined) light.on = patch.on ? 1 : 0;
    if (patch.brightness !== undefined) {
      light.brightness = Math.round(clamp(patch.brightness, 0, 100));
    }
    if (patch.temperature !== undefined) light.temperature = kelvinToMired(patch.temperature);

    const body = await this.#request('PUT', { numberOfLights: 1, lights: [light] });
    return this.#absorb(body);
  }

  /** Its current `on`, for a toggle that has never successfully read. */
  get isOn(): boolean {
    return this.#on;
  }

  #absorb(body: WireBody | null): boolean {
    if (!body) {
      if (!this.#reachable) return false;
      this.#reachable = false;
      return true;
    }

    const light = body.lights?.[0];
    if (!light) {
      // Answered, but with nothing in it. Reachable, state unknown — keep
      // what we had rather than inventing zeros.
      const changed = !this.#reachable;
      this.#reachable = true;
      return changed;
    }

    const on = light.on === 1;
    const brightness = Math.round(clamp(light.brightness ?? this.#brightness, 0, 100));
    const temperature =
      light.temperature === undefined ? this.#temperature : miredToKelvin(light.temperature);

    const changed =
      !this.#reachable ||
      on !== this.#on ||
      brightness !== this.#brightness ||
      temperature !== this.#temperature;

    this.#reachable = true;
    this.#on = on;
    this.#brightness = brightness;
    this.#temperature = temperature;
    return changed;
  }

  async #request(method: 'GET' | 'PUT', body?: WireBody): Promise<WireBody | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(this.#url, {
        method,
        signal: controller.signal,
        headers: body ? { 'content-type': 'application/json' } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      if (!res.ok) {
        log.warn(`${this.name}: ${method} returned ${res.status}`);
        return null;
      }
      return (await res.json()) as WireBody;
    } catch (err) {
      // Debug, not warn: an unplugged key light would otherwise write a line
      // every poll interval, forever.
      log.debug(`${this.name}: ${method} failed — ${err instanceof Error ? err.message : err}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
