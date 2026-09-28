import { signal, computed } from '@preact/signals';
import type { AppleTvState, KeyLightState, RoomosState, TvState } from '@shared/protocol.ts';
import type { ControlButton } from '@shared/config.ts';
import { controlsConfig } from '~/config/index.ts';

/**
 * Macro-page state: the Elgato Key Lights, and which button is mid-press.
 *
 * Key lights, televisions and RoomOS presentations are the things on the
 * Controls screen that HAVE state. An xCommand, an SSH command and a Home
 * Assistant webhook are one-way — a webhook answers 200 whether or not an
 * automation was listening — so there is nothing to reflect back, and
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
export const appleTvs = signal<AppleTvState[]>([]);
export const appleTvsById = computed(() => new Map(appleTvs.value.map((tv) => [tv.id, tv])));

export const tvsById = computed(() => new Map(tvs.value.map((t) => [t.id, t])));

/** What a `tv:` key's television is showing, or null when nothing is known. */
export function tvStateOf(id: string): TvState | null {
  return tvsById.value.get(id) ?? null;
}

/**
 * What each RoomOS device in `controls.roomos` is presenting, by config id.
 *
 * Pushed by the backend from the device's own xAPI feedback, so it follows a
 * laptop being plugged in or a source chosen on the device's screen.
 */
export const roomos = signal<RoomosState[]>([]);
export const roomosById = computed(() => new Map(roomos.value.map((d) => [d.id, d])));

export function roomosStateOf(id: string): RoomosState | null {
  return roomosById.value.get(id) ?? null;
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
 * A tick that stays up for its full 900 ms next to a "Desk Pro is not
 * reachable" toast is the panel contradicting itself.
 */
export function clearPressed(id: string): void {
  clearTimeout(timers.get(id));
  timers.delete(id);
  if (!pressed.value.has(id)) return;
  const next = new Set(pressed.value);
  next.delete(id);
  pressed.value = next;
}

/**
 * The live second line for a key, or null for a key with nothing to report.
 *
 * Shared by the page grid and a device tile's key row, so a Presentation key
 * says what is on screen wherever it is drawn.
 */
export function liveLabelOf(button: ControlButton): { text: string; assumed: boolean } | null {
  return tvLabel(button) ?? roomosLabel(button);
}

/**
 * The current input, for a key that cycles them. Null for every other key, so
 * nothing else grows a second line.
 *
 * An em dash when nothing at all is known — the set is off, or on something
 * that is not an input. `assumed` marks an input the panel selected but the
 * television has not confirmed, which is all there is to go on for a set that
 * never reports its foreground app.
 */
function tvLabel(button: ControlButton): { text: string; assumed: boolean } | null {
  const action = button.actions.find((a) => a.kind === 'tv' && a.op === 'next');
  if (!action || action.kind !== 'tv') return null;

  const state = tvStateOf(action.tv);
  if (!state?.input) return { text: '—', assumed: false };

  // Named the way the room names it, falling back to the socket id.
  const tv = controlsConfig.value.tvs.find((t) => t.id === action.tv);
  const named = tv?.inputs.find((i) => i.source === state.input);
  return { text: named?.name ?? state.input, assumed: !state.confirmed };
}

/**
 * What a RoomOS device is presenting, for a key that steps through its
 * inputs. Never `assumed`: the device reports every change itself, so there
 * is nothing weaker to fall back on. An em dash when nothing is presented
 * or the device cannot be reached.
 */
function roomosLabel(button: ControlButton): { text: string; assumed: boolean } | null {
  const action = button.actions.find((a) => a.kind === 'roomos' && a.op === 'next');
  if (!action || action.kind !== 'roomos') return null;

  const state = roomosStateOf(action.device);
  if (!state?.reachable || state.connector === null) return { text: '—', assumed: false };

  const dev = controlsConfig.value.roomos.find((d) => d.id === action.device);
  const named = dev?.inputs.find((i) => i.connector === state.connector)?.name;
  const type = state.connectors.find((c) => c.id === state.connector)?.type;
  return { text: named ?? type ?? `Input ${state.connector}`, assumed: false };
}
