import { signal, computed } from '@preact/signals';
import type { KeyLightState, TvState } from '@shared/protocol.ts';

/**
 * Macro-page state: the Elgato Key Lights, and which button is mid-press.
 *
 * Key lights are the only thing on the Controls screen that HAS state. A
 * Companion press and a Home Assistant webhook are both one-way — Companion's
 * feedbacks live on its own surfaces and a webhook answers 200 whether or not
 * an automation was listening — so there is nothing to reflect back, and
 * pretending otherwise would be a lie the panel tells confidently.
 *
 * What the panel can honestly show for those is that the tap was received and
 * the request was made, which is what `pressing` is for.
 */

/** Every configured key light, newest state from the backend. */
export const keyLights = signal<KeyLightState[]>([]);

export const keyLightsById = computed(() => {
  const map = new Map<string, KeyLightState>();
  for (const light of keyLights.value) map.set(light.id, light);
  return map;
});

/**
 * The state of `all`, as one light.
 *
 * On if ANY light is on, which is what makes the toggle converge a pair that
 * has drifted apart rather than swapping them. Brightness and temperature are
 * the mean, so a slider starting from a pair that disagrees lands somewhere
 * sensible instead of jumping to whichever light happened to be first.
 */
export const allKeyLights = computed<KeyLightState | null>(() => {
  const lights = keyLights.value;
  if (lights.length === 0) return null;

  const live = lights.filter((l) => l.reachable);
  const from = live.length > 0 ? live : lights;
  const mean = (pick: (l: KeyLightState) => number): number =>
    Math.round(from.reduce((sum, l) => sum + pick(l), 0) / from.length);

  return {
    id: 'all',
    name: 'All Key Lights',
    reachable: live.length > 0,
    on: from.some((l) => l.on),
    brightness: mean((l) => l.brightness),
    temperature: mean((l) => l.temperature),
  };
});

/**
 * What each television is showing, by config id.
 *
 * Pushed by the backend, which subscribes to the set rather than polling it —
 * so this follows the TV's own remote as well as the panel's keys. A missing
 * entry, or a null input, means the panel genuinely does not know: the set is
 * off, or on something that is not an input.
 */
export const tvs = signal<TvState[]>([]);

export const tvsById = computed(() => new Map(tvs.value.map((t) => [t.id, t])));

/** What a `tv:` key's television is showing, or null when nothing is known. */
export function tvStateOf(id: string): TvState | null {
  return tvsById.value.get(id) ?? null;
}

/** Resolve what a `light:` item addresses — one light, or all of them. */
export function keyLightFor(id: string): KeyLightState | null {
  return id === 'all' ? allKeyLights.value : (keyLightsById.value.get(id) ?? null);
}

/* ── Press feedback ────────────────────────────────────────────────────────
   A macro button has no state to flip, so without this a tap on "Hang Up"
   produces a 90 ms press animation and then nothing — indistinguishable, on a
   touchscreen you are not sure registered the touch, from a tap that missed.
   A brief confirmation tick is the smallest honest acknowledgement: it says
   the request went, not that the far end did anything. */

/** Button ids currently showing their confirmation, with their timers. */
export const pressed = signal<ReadonlySet<string>>(new Set());

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Long enough to read as deliberate, short enough not to feel like a lock. */
const CONFIRM_MS = 900;

export function markPressed(id: string): void {
  clearTimeout(timers.get(id));

  const next = new Set(pressed.value);
  next.add(id);
  pressed.value = next;

  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      const after = new Set(pressed.value);
      after.delete(id);
      pressed.value = after;
    }, CONFIRM_MS),
  );
}

/**
 * Drop a confirmation early, when the backend reports the press failed.
 *
 * A tick that stays up for its full 900 ms next to a "Companion unreachable"
 * toast is the panel contradicting itself.
 */
export function clearPressed(id: string): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  if (!pressed.value.has(id)) return;
  const next = new Set(pressed.value);
  next.delete(id);
  pressed.value = next;
}
