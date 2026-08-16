import { callService } from '~/net/socket.ts';
import { optimistic, peekEntity } from '~/state/entities.ts';
import { markActivity, showToast } from '~/state/ui.ts';
import { domainOf } from '~/lib/format.ts';

/**
 * Every command the panel can send.
 *
 * Two rules govern this file, and both exist because a control that waits for
 * the network feels broken on a touch panel:
 *
 * **1. Write optimistically, always.** The signal is updated before the
 * command leaves, so the tile flips and the slider thumb moves in the same
 * frame as the finger. Home Assistant's authoritative state arrives ~20 ms
 * later and overwrites it — normally with the identical value, so nothing
 * visibly changes. If the command failed, HA's state wins and the control
 * snaps back, which is correct: the UI must never keep claiming a light is on
 * when it isn't.
 *
 * **2. Rate-limit drags, but never lose the final value.** A three-second
 * slider drag fires ~180 pointermove events. Sending 180 `call_service`
 * messages would flood Home Assistant and, worse, arrive out of order — the
 * light would settle on whichever packet lost the race rather than where the
 * finger stopped. So intermediate values are throttled and the release always
 * sends, unthrottled.
 */

/* ── Throttle ─────────────────────────────────────────────────────────────
   Leading + trailing edge, keyed so two sliders never share a timer. The
   trailing call is what guarantees the last value is delivered even if the
   user stops moving mid-window. */

interface Throttled {
  last: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  pending: (() => void) | undefined;
}

const throttles = new Map<string, Throttled>();

function throttle(key: string, intervalMs: number, fn: () => void): void {
  let t = throttles.get(key);
  if (!t) {
    t = { last: 0, timer: undefined, pending: undefined };
    throttles.set(key, t);
  }

  const now = Date.now();
  const elapsed = now - t.last;

  if (elapsed >= intervalMs) {
    t.last = now;
    fn();
    return;
  }

  // Inside the window: remember the newest value and fire it when the window
  // closes. Replacing `pending` means only the newest survives, which is
  // exactly what a slider wants.
  t.pending = fn;
  if (t.timer) return;
  t.timer = setTimeout(() => {
    const p = t.pending;
    t.timer = undefined;
    t.pending = undefined;
    if (p) {
      t.last = Date.now();
      p();
    }
  }, intervalMs - elapsed);
}

/** Drop any queued trailing call — used when a drag ends and sends directly. */
function cancelThrottle(key: string): void {
  const t = throttles.get(key);
  if (!t) return;
  clearTimeout(t.timer);
  t.timer = undefined;
  t.pending = undefined;
  t.last = Date.now();
}

/** ~8 commands/second while dragging. Smooth to watch, sane for HA. */
const DRAG_INTERVAL_MS = 120;

/* ── Core ─────────────────────────────────────────────────────────────────*/

function send(
  domain: string,
  service: string,
  entityId: string,
  data?: Record<string, unknown>,
): void {
  markActivity();
  if (!callService(domain, service, entityId, data)) {
    showToast('Not connected', 'error');
  }
}

/* ── Generic on/off ───────────────────────────────────────────────────────*/

const TOGGLEABLE = new Set(['light', 'switch', 'fan', 'input_boolean', 'automation']);

export function canToggle(entityId: string): boolean {
  return TOGGLEABLE.has(domainOf(entityId));
}

export function toggle(entityId: string): void {
  const domain = domainOf(entityId);
  const state = peekEntity(entityId);
  if (!state || state.s === 'unavailable') return;

  const turningOn = state.s !== 'on';
  optimistic(entityId, turningOn ? 'on' : 'off');
  send(domain, turningOn ? 'turn_on' : 'turn_off', entityId);
}

/* ── Light ────────────────────────────────────────────────────────────────*/

/**
 * Brightness as a percentage.
 *
 * Home Assistant stores `brightness` as 0-255 but accepts `brightness_pct`,
 * so we send percent and optimistically write back the 0-255 equivalent —
 * otherwise the tile would briefly show the old percentage while the slider
 * showed the new one.
 */
export function setBrightness(entityId: string, pct: number, final: boolean): void {
  const clamped = Math.max(1, Math.min(100, Math.round(pct)));
  optimistic(entityId, 'on', { brightness: Math.round((clamped / 100) * 255) });

  const fire = () => send('light', 'turn_on', entityId, { brightness_pct: clamped });
  if (final) {
    cancelThrottle(entityId + ':brightness');
    fire();
  } else {
    throttle(entityId + ':brightness', DRAG_INTERVAL_MS, fire);
  }
}

export function setColorTemp(entityId: string, kelvin: number, final: boolean): void {
  const k = Math.round(kelvin);
  optimistic(entityId, 'on', { color_temp_kelvin: k });

  const fire = () => send('light', 'turn_on', entityId, { color_temp_kelvin: k });
  if (final) {
    cancelThrottle(entityId + ':ct');
    fire();
  } else {
    throttle(entityId + ':ct', DRAG_INTERVAL_MS, fire);
  }
}

export function setLightColor(entityId: string, rgb: [number, number, number]): void {
  optimistic(entityId, 'on', { rgb_color: rgb });
  send('light', 'turn_on', entityId, { rgb_color: rgb });
}

/* ── Fan ──────────────────────────────────────────────────────────────────*/

export function setFanSpeed(entityId: string, pct: number, final: boolean): void {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  optimistic(entityId, clamped > 0 ? 'on' : 'off', { percentage: clamped });

  const fire = () => send('fan', 'set_percentage', entityId, { percentage: clamped });
  if (final) {
    cancelThrottle(entityId + ':fan');
    fire();
  } else {
    throttle(entityId + ':fan', DRAG_INTERVAL_MS, fire);
  }
}

export function setFanPreset(entityId: string, preset: string): void {
  optimistic(entityId, 'on', { preset_mode: preset });
  send('fan', 'set_preset_mode', entityId, { preset_mode: preset });
}

/* ── Cover ────────────────────────────────────────────────────────────────*/

export function openCover(entityId: string): void {
  optimistic(entityId, 'opening');
  send('cover', 'open_cover', entityId);
}

export function closeCover(entityId: string): void {
  optimistic(entityId, 'closing');
  send('cover', 'close_cover', entityId);
}

export function stopCover(entityId: string): void {
  // No optimistic state: we genuinely do not know where it stopped, and
  // guessing would show a position that is wrong until HA corrects it.
  send('cover', 'stop_cover', entityId);
}

export function setCoverPosition(entityId: string, pct: number, final: boolean): void {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  optimistic(entityId, clamped > 0 ? 'open' : 'closed', { current_position: clamped });

  const fire = () => send('cover', 'set_cover_position', entityId, { position: clamped });
  if (final) {
    cancelThrottle(entityId + ':cover');
    fire();
  } else {
    throttle(entityId + ':cover', DRAG_INTERVAL_MS, fire);
  }
}

/* ── Climate ──────────────────────────────────────────────────────────────*/

export function setTargetTemperature(entityId: string, temp: number, final: boolean): void {
  const rounded = Math.round(temp * 2) / 2; // thermostats work in half degrees
  optimistic(entityId, peekEntity(entityId)?.s ?? 'heat', { temperature: rounded });

  const fire = () => send('climate', 'set_temperature', entityId, { temperature: rounded });
  if (final) {
    cancelThrottle(entityId + ':temp');
    fire();
  } else {
    throttle(entityId + ':temp', DRAG_INTERVAL_MS, fire);
  }
}

export function setHvacMode(entityId: string, mode: string): void {
  optimistic(entityId, mode);
  send('climate', 'set_hvac_mode', entityId, { hvac_mode: mode });
}

export function setClimateFanMode(entityId: string, mode: string): void {
  optimistic(entityId, peekEntity(entityId)?.s ?? 'auto', { fan_mode: mode });
  send('climate', 'set_fan_mode', entityId, { fan_mode: mode });
}

/* ── Lock ─────────────────────────────────────────────────────────────────*/

export function setLock(entityId: string, locked: boolean): void {
  // 'locking'/'unlocking' are real HA states, so the optimistic value is
  // honest: the command is in flight, the bolt has not moved yet.
  optimistic(entityId, locked ? 'locking' : 'unlocking');
  send('lock', locked ? 'lock' : 'unlock', entityId);
}

/* ── Scenes, scripts, buttons ─────────────────────────────────────────────*/

export function activate(entityId: string): void {
  const domain = domainOf(entityId);
  switch (domain) {
    case 'scene':
      send('scene', 'turn_on', entityId);
      break;
    case 'script':
      send('script', 'turn_on', entityId);
      break;
    case 'button':
    case 'input_button':
      send(domain, 'press', entityId);
      break;
    case 'automation':
      send('automation', 'trigger', entityId);
      break;
  }
}

/* ── Input helpers ────────────────────────────────────────────────────────*/

export function selectOption(entityId: string, option: string): void {
  optimistic(entityId, option);
  send('input_select', 'select_option', entityId, { option });
}

export function setNumber(entityId: string, value: number, final: boolean): void {
  optimistic(entityId, String(value));

  const fire = () => send('input_number', 'set_value', entityId, { value });
  if (final) {
    cancelThrottle(entityId + ':num');
    fire();
  } else {
    throttle(entityId + ':num', DRAG_INTERVAL_MS, fire);
  }
}

/* ── Media player ─────────────────────────────────────────────────────────*/

export function mediaPlayPause(entityId: string): void {
  const state = peekEntity(entityId);
  if (!state) return;
  // Optimistic so the play/pause glyph swaps instantly; some receivers take
  // a second to report back and the delay reads as a missed tap.
  optimistic(entityId, state.s === 'playing' ? 'paused' : 'playing');
  send('media_player', 'media_play_pause', entityId);
}

export function mediaNext(entityId: string): void {
  send('media_player', 'media_next_track', entityId);
}

export function mediaPrevious(entityId: string): void {
  send('media_player', 'media_previous_track', entityId);
}

export function setVolume(entityId: string, level: number, final: boolean): void {
  const clamped = Math.max(0, Math.min(1, level));
  optimistic(entityId, peekEntity(entityId)?.s ?? 'playing', { volume_level: clamped });

  const fire = () =>
    send('media_player', 'volume_set', entityId, { volume_level: Number(clamped.toFixed(3)) });
  if (final) {
    cancelThrottle(entityId + ':vol');
    fire();
  } else {
    throttle(entityId + ':vol', DRAG_INTERVAL_MS, fire);
  }
}

export function nudgeVolume(entityId: string, delta: number): void {
  const state = peekEntity(entityId);
  const current = typeof state?.a['volume_level'] === 'number' ? state.a['volume_level'] : 0;
  setVolume(entityId, current + delta, true);
}

export function setMuted(entityId: string, muted: boolean): void {
  optimistic(entityId, peekEntity(entityId)?.s ?? 'playing', { is_volume_muted: muted });
  send('media_player', 'volume_mute', entityId, { is_volume_muted: muted });
}

export function selectSource(entityId: string, source: string): void {
  optimistic(entityId, peekEntity(entityId)?.s ?? 'on', { source });
  send('media_player', 'select_source', entityId, { source });
}

export function setMediaPower(entityId: string, on: boolean): void {
  optimistic(entityId, on ? 'on' : 'off');
  send('media_player', on ? 'turn_on' : 'turn_off', entityId);
}

/* ── Speaker grouping ─────────────────────────────────────────────────────
   Both of these are standard Home Assistant services. Music Assistant
   implements them, so the app never talks to Music Assistant directly and
   holds no grouping state of its own — the truth stays in one place. */

/**
 * Add speakers to the group led by `leader`.
 *
 * `media_player.join` is absolute, not incremental: it sets the membership to
 * exactly what you pass. So adding one speaker means sending the whole list
 * again, which is also what makes removing one a `join` with the shorter list
 * rather than an `unjoin` of that member.
 */
export function joinPlayers(leader: string, members: string[]): void {
  send('media_player', 'join', leader, {
    // The leader is implied by the target, and Music Assistant rejects a list
    // that names it as its own child.
    group_members: members.filter((id) => id !== leader),
  });
}

/** Take one speaker out of whatever group it is in. */
export function unjoinPlayer(entityId: string): void {
  send('media_player', 'unjoin', entityId);
}

/* ── Playing something ────────────────────────────────────────────────────*/

/** What to do with the queue when playing something new. */
export type Enqueue = 'play' | 'replace' | 'next' | 'add';

/**
 * Play a Music Assistant library item on a speaker.
 *
 * Fire-and-forget like every other command: the result shows up as ordinary
 * state on the player's entity a moment later, which is what the Now Playing
 * screen is already watching. Nothing here waits for a reply.
 *
 * `radio_mode` asks Music Assistant to keep going with similar music once the
 * item finishes, which is what makes tapping a single artist a reasonable
 * thing to do rather than a way to hear one song and then silence.
 */
export function playItem(
  entityId: string,
  uri: string,
  opts: { enqueue?: Enqueue; radio?: boolean } = {},
): void {
  send('music_assistant', 'play_media', entityId, {
    media_id: uri,
    enqueue: opts.enqueue ?? 'replace',
    ...(opts.radio ? { radio_mode: true } : {}),
  });
}
