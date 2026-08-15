import { signal } from '@preact/signals';

/**
 * A single shared clock signal, ticking once per MINUTE, aligned to the
 * minute boundary.
 *
 * Three deliberate choices, all about idle cost on a device that is on 24/7:
 *
 * 1. **One timer for the whole app.** Every clock display in the UI reads
 *    this signal. Ten components would otherwise mean ten timers.
 *
 * 2. **Minutes, not seconds.** Nothing in this UI displays seconds — a
 *    ticking seconds digit on a wall panel is visual noise, and it would wake
 *    the CPU 60x more often. Idle CPU with this design is effectively zero
 *    between minutes, which is the difference between a panel that runs cool
 *    and one that doesn't.
 *
 * 3. **`setTimeout` re-armed to the next boundary, not `setInterval`.**
 *    setInterval drifts, and worse, if the device suspends and resumes (which
 *    RoomOS does around standby) setInterval can fire a backlog of missed
 *    ticks at once. Re-arming from the current time is self-correcting: after
 *    a resume the very next tick lands on the correct boundary.
 */

export const now = signal(new Date());

let timer: ReturnType<typeof setTimeout> | undefined;

function scheduleNextTick(): void {
  const d = new Date();
  // +50ms guard so we land just after the boundary, never just before it
  // (which would show the previous minute for a frame).
  const msToNextMinute = 60_000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 50;
  timer = setTimeout(() => {
    now.value = new Date();
    scheduleNextTick();
  }, msToNextMinute);
}

export function startClock(): void {
  if (timer !== undefined) return;
  now.value = new Date();
  scheduleNextTick();
}

export function stopClock(): void {
  clearTimeout(timer);
  timer = undefined;
}

/**
 * Resync after the device wakes.
 *
 * `visibilitychange` fires when the RoomOS web view is backgrounded and
 * restored. Without this, a panel that was asleep for six hours would show a
 * six-hour-old time until its next scheduled tick — which, because the
 * timeout was armed before the sleep, could be a long way off.
 */
export function resyncClock(): void {
  if (timer === undefined) return;
  clearTimeout(timer);
  now.value = new Date();
  scheduleNextTick();
}
