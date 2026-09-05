import { callService, musicCommand } from '~/net/socket.ts';
import { optimistic, peekEntity } from '~/state/entities.ts';
import { players } from '~/state/players.ts';
import { markActivity, showToast } from '~/state/ui.ts';
import { domainOf } from '~/lib/format.ts';
import type { Enqueue, Player, MusicCommand } from '@shared/protocol.ts';

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

/* ── Device tiles ─────────────────────────────────────────────────────────
   These three take their domain from the ENTITY rather than hardcoding one,
   which is not a stylistic preference: `selectOption` and `setNumber` above
   are both pinned to their `input_*` domain, and reusing one of them for a
   `number.` or `select.` entity is precisely the bug that made choosing a TV
   input answer "Not permitted". Deriving cannot make that mistake. */

/** Press a `button` (or `input_button`). */
export function pressButton(entityId: string): void {
  send(domainOf(entityId), 'press', entityId);
}

/** Set a `number` (or `input_number`), throttled while dragging. */
export function setEntityNumber(entityId: string, value: number, final: boolean): void {
  optimistic(entityId, String(value));

  const fire = () => send(domainOf(entityId), 'set_value', entityId, { value });
  if (final) {
    cancelThrottle(entityId + ':num');
    fire();
  } else {
    throttle(entityId + ':num', DRAG_INTERVAL_MS, fire);
  }
}

/** Choose an option on a `select` (or `input_select`). */
export function setEntityOption(entityId: string, option: string): void {
  optimistic(entityId, option);
  send(domainOf(entityId), 'select_option', entityId, { option });
}

/* ── Music ────────────────────────────────────────────────────────────────
   None of this goes through Home Assistant. It also does not name a music
   system: the panel sends a player id and an INTENTION, and the backend
   the backend turns into whatever the speaker actually needs.

   That is not indirection for its own sake: it makes the backend guard
   stronger. With a verb on the wire, an action this app never wrote simply
   does not exist, where an upstream command name only ever gets an
   allow-list that somebody has to keep complete. Sonos's local API has no
   authentication and the same port that pauses a track can rename rooms.

   Volume here is 0-100. Both systems use that scale; converting anywhere is
   exactly how a slider ends up setting a speaker to 1% of what was asked. */

function music(cmd: MusicCommand): void {
  markActivity();
  if (!musicCommand(cmd)) {
    showToast('Not connected', 'error');
  }
}

function player(playerId: string): Player | undefined {
  return players.peek().find((p) => p.id === playerId);
}

/** Optimistically patch one player, so a tap moves the UI in the same frame. */
function patchPlayer(playerId: string, changes: Partial<Player>): void {
  players.value = players.value.map((p) => (p.id === playerId ? { ...p, ...changes } : p));
}

export function mediaPlayPause(playerId: string): void {
  const current = player(playerId);
  if (!current) return;
  patchPlayer(playerId, { state: current.state === 'playing' ? 'paused' : 'playing' });
  music({ verb: 'playPause', player: playerId });
}

export function mediaNext(playerId: string): void {
  music({ verb: 'next', player: playerId });
}

export function mediaPrevious(playerId: string): void {
  music({ verb: 'previous', player: playerId });
}

/** Volume, 0-100. */
export function setVolume(playerId: string, level: number, final: boolean): void {
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  patchPlayer(playerId, { volume: clamped });

  const fire = () => music({ verb: 'volume', player: playerId, level: clamped });
  if (final) {
    cancelThrottle(playerId + ':vol');
    fire();
  } else {
    throttle(playerId + ':vol', DRAG_INTERVAL_MS, fire);
  }
}

export function nudgeVolume(playerId: string, delta: number): void {
  setVolume(playerId, (player(playerId)?.volume ?? 0) + delta, true);
}

export function setMuted(playerId: string, muted: boolean): void {
  patchPlayer(playerId, { muted });
  music({ verb: 'mute', player: playerId, muted });
}

export function setMediaPower(playerId: string, on: boolean): void {
  patchPlayer(playerId, { powered: on });
  music({ verb: 'power', player: playerId, on });
}

export function seekTo(playerId: string, seconds: number): void {
  music({ verb: 'seek', player: playerId, seconds: Math.max(0, Math.round(seconds)) });
}

export function setShuffle(playerId: string, on: boolean): void {
  music({ verb: 'shuffle', player: playerId, on });
}

export function setRepeat(playerId: string, mode: 'off' | 'one' | 'all'): void {
  music({ verb: 'repeat', player: playerId, mode });
}

/* ── Speaker grouping ─────────────────────────────────────────────────────
   Absolute rather than incremental: the group is set to exactly the speakers
   named, which is what makes removing one the same operation as adding one,
   and what stops two panels racing into a group neither asked for. */

/**
 * Set the group led by `leader` to exactly these members.
 *
 * Written optimistically, like every other control here. Grouping is the one
 * that most needs it: the backend has to tell each speaker separately and then
 * wait for the household to announce the result, so without this the sheet
 * sits unchanged for a moment while somebody stands there wondering whether
 * the tap registered. The real topology arrives a beat later and overwrites
 * this — normally with the identical answer.
 */
export function setGroupMembers(leader: string, members: string[]): void {
  const wanted = members.includes(leader) ? members : [leader, ...members];
  regroup(leader, wanted);
  music({ verb: 'group', player: leader, members: wanted });
}

/** Take one speaker out of whatever group it is in. */
export function unjoinPlayer(playerId: string): void {
  const current = player(playerId);
  if (current) {
    // Everyone else keeps playing together; this one stands alone.
    const rest = current.members.filter((id) => id !== playerId);
    const leader = current.syncedTo ?? rest[0];
    if (leader) regroup(leader, rest);
    regroup(playerId, []);
  }
  music({ verb: 'ungroup', player: playerId });
}

/**
 * Apply a grouping locally: `members` becomes exactly this set.
 *
 * A group of one is drawn as no group at all, which is why an empty result
 * clears `members` rather than leaving the speaker listed as its own member.
 */
function regroup(leader: string, members: string[]): void {
  const group = members.length > 1 ? members : [];

  players.value = players.value.map((p) => {
    if (!members.includes(p.id)) return p;
    return {
      ...p,
      members: group,
      syncedTo: p.id === leader ? null : leader,
      queueId: leader,
    };
  });
}

/* ── The queue ────────────────────────────────────────────────────────────
   Addressed by SPEAKER, not by queue. A Sonos queue belongs to a GROUP
   rather than to a speaker, and resolving that is the backend's job. */

/** Jump to a track already in the queue. */
export function playQueueIndex(playerId: string, index: number): void {
  music({ verb: 'queueJump', player: playerId, index });
}

/** Move a track up or down. `by` is a position shift, not an index. */
export function moveQueueItem(playerId: string, itemId: string, by: number): void {
  music({ verb: 'queueMove', player: playerId, item: itemId, by });
}

/** Move a track to play immediately after the current one. */
export function moveQueueItemNext(playerId: string, itemId: string): void {
  music({ verb: 'queueMove', player: playerId, item: itemId, by: 0 });
}

export function removeQueueItem(playerId: string, itemId: string): void {
  music({ verb: 'queueRemove', player: playerId, item: itemId });
}

export function clearQueue(playerId: string): void {
  music({ verb: 'queueClear', player: playerId });
}

/* ── Playing something ────────────────────────────────────────────────────*/

export type { Enqueue };

/**
 * Play a library item on a speaker.
 *
 * `radio` asks the music system to keep going with similar music once the item
 * finishes, which is what makes tapping a single artist a reasonable thing to
 * do rather than a way to hear one song and then silence.
 */
export function playItem(
  playerId: string,
  uri: string,
  opts: { enqueue?: Enqueue; radio?: boolean } = {},
): void {
  music({
    verb: 'playItem',
    player: playerId,
    item: uri,
    enqueue: opts.enqueue ?? 'replace',
    ...(opts.radio ? { radio: true } : {}),
  });
}

/** Mark something a favourite, or unmark it. */
export function setFavorite(playerId: string, uri: string, favorite: boolean): void {
  music({ verb: 'favorite', player: playerId, item: uri, on: favorite });
}
