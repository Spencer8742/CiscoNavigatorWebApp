import { effect } from '@preact/signals';
import { idleConfig } from '~/config/index.ts';
import {
  activeRoom,
  lastActivity,
  markActivity,
  openEntity,
  route,
  screensaverActive,
} from '~/state/ui.ts';

/**
 * Idle behaviour.
 *
 * This is what makes a permanently mounted panel feel like an appliance
 * rather than a browser someone left open:
 *
 *     interaction ──▶ dashboard
 *          │
 *          ├─ after `returnHomeSeconds` ──▶ back to Home
 *          └─ after `timeoutSeconds`    ──▶ photo screensaver
 *                                             │
 *                              any touch ─────┘ (instant, no animation delay)
 *
 * Implementation notes that matter on this device:
 *
 * - **One timer, not per-event work.** Activity handlers do nothing but write
 *   a timestamp; a single 1 Hz timer decides what to do about it. Cisco's
 *   guidance is explicit — "avoid doing much work in event handlers"
 *   (docs/ROOMOS.md §2) — and a wall panel receives a lot of stray touches.
 *
 * - **Capture-phase, passive listeners on `window`.** Capture means we see
 *   the interaction even when a component calls `stopPropagation`. Passive
 *   means we can never delay a scroll.
 *
 * - **Waking is synchronous.** `markActivity()` clears the screensaver flag
 *   immediately on `pointerdown`, so the dashboard is already coming back
 *   before the finger lifts. Waiting for `pointerup` here would feel slow in
 *   exactly the moment the user is judging the device.
 */

let ticker: ReturnType<typeof setInterval> | undefined;
let disposeEffect: (() => void) | undefined;

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'wheel', 'keydown'] as const;

function onActivity(): void {
  markActivity();
}

export function startIdleMonitor(): void {
  if (ticker !== undefined) return;

  for (const type of ACTIVITY_EVENTS) {
    window.addEventListener(type, onActivity, { passive: true, capture: true });
  }

  // Coming back from RoomOS standby counts as activity: the user just woke
  // the device, so dropping them straight into the screensaver would be
  // perverse.
  document.addEventListener('visibilitychange', onVisibility);

  ticker = setInterval(tick, 1000);

  // Re-evaluate immediately when the config changes, so editing
  // dashboard.yaml takes effect without waiting for the next tick.
  disposeEffect = effect(() => {
    void idleConfig.value;
    tick();
  });
}

export function stopIdleMonitor(): void {
  clearInterval(ticker);
  ticker = undefined;
  for (const type of ACTIVITY_EVENTS) {
    window.removeEventListener(type, onActivity, { capture: true });
  }
  document.removeEventListener('visibilitychange', onVisibility);
  disposeEffect?.();
  disposeEffect = undefined;
}

function onVisibility(): void {
  if (document.visibilityState === 'visible') markActivity();
}

function tick(): void {
  const cfg = idleConfig.value;
  const idleMs = Date.now() - lastActivity.value;

  // Screensaver takes precedence: once it is showing, there is nothing else
  // to decide.
  if (cfg.timeoutSeconds > 0 && idleMs >= cfg.timeoutSeconds * 1000) {
    if (!screensaverActive.value) screensaverActive.value = true;
    return;
  }

  if (screensaverActive.value) return;

  // Return to Home so the panel is always found in a known state, rather than
  // on whichever screen the last person happened to leave open.
  if (
    cfg.returnHomeSeconds > 0 &&
    idleMs >= cfg.returnHomeSeconds * 1000 &&
    route.value !== 'home'
  ) {
    // Deliberately NOT navigate(): that marks activity, which would reset the
    // idle clock and mean the screensaver could never follow. Set the state
    // directly and let the clock keep running.
    activeRoom.value = null;
    openEntity.value = null;
    route.value = 'home';
  }
}
