import { effect } from '@preact/signals';
import { idleConfig } from '~/config/index.ts';
import type { IdleConfig } from '@shared/config.ts';
import {
  lastActivity,
  markActivity,
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
 *          └─ after `timeoutSeconds` ──▶ photo screensaver
 *                                          │
 *                           any touch ─────┘ (instant, no animation delay)
 *
 * …except on the Controls screen, which holds it off for
 * `controlsHoldSeconds`. See `holdingOnControls` below.
 *
 * **The panel does not navigate on its own.** It used to return to Home after
 * `returnHomeSeconds`, which meant walking up to a panel you had left on
 * Apple TV and finding Home. A screen someone chose is the screen that should
 * be there when they come back, so the only thing idling now does is start
 * the screensaver -- and dismissing that puts you back exactly where you
 * were, not somewhere the panel decided on.
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

/**
 * Whether the Controls screen is currently holding idle off.
 *
 * The Controls screen is the one screen that is doing its job while nobody
 * touches it. You are in a call; hang up and mute are on screen; the panel
 * deciding that three minutes of quiet means you want photographs is the
 * panel being wrong about what it is for.
 *
 * It expires, because the panel has no way to know when you are finished —
 * RoomOS gives a web page no call state (docs/ROOMOS.md §8) — and a panel
 * parked on a static grid of keys indefinitely is a burn-in risk on a device
 * that runs for months, and one that never shows a photo again.
 */
function holdingOnControls(cfg: IdleConfig, idleMs: number): boolean {
  if (route.value !== 'controls') return false;
  if (cfg.controlsHoldSeconds <= 0) return false;
  return idleMs < cfg.controlsHoldSeconds * 1000;
}

function tick(): void {
  const cfg = idleConfig.value;
  const idleMs = Date.now() - lastActivity.value;

  // Once the screensaver is showing there is nothing left to decide; waking
  // is markActivity()'s job, on the first touch.
  if (screensaverActive.value) return;

  const holding = holdingOnControls(cfg, idleMs);

  // Starting the screensaver is the only thing left to decide. The route is
  // deliberately untouched: the panel screensaves from wherever it is and
  // wakes back onto it.
  if (!holding && cfg.timeoutSeconds > 0 && idleMs >= cfg.timeoutSeconds * 1000) {
    screensaverActive.value = true;
  }
}
