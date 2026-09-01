import { effect } from '@preact/signals';
import { idleConfig } from '~/config/index.ts';
import type { IdleConfig } from '@shared/config.ts';
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
 * …except on the Controls screen, which holds both off for
 * `controlsHoldSeconds`. See `holdingOnControls` below.
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
 * The hold covers BOTH timeouts, and that is not belt-and-braces: with the
 * default config `returnHomeSeconds` (90) is well short of `timeoutSeconds`
 * (180), so holding only the screensaver would do nothing observable. The
 * panel would leave Controls at 90 seconds and screensave from Home at 180,
 * which is the behaviour being complained about with an extra step in it.
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

  /*
   * Return to Home BEFORE considering the screensaver, so that whatever wakes
   * the panel finds it in a known state.
   *
   * On the normal path this is the order it already happened in, one tick at
   * a time, because returnHomeSeconds is the shorter of the two. It matters
   * when a Controls hold EXPIRES: both timeouts are long past by then and
   * become due on the same tick, and without this the panel would screensave
   * still sitting on Controls and wake back onto it.
   */
  if (
    !holding &&
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

  if (!holding && cfg.timeoutSeconds > 0 && idleMs >= cfg.timeoutSeconds * 1000) {
    screensaverActive.value = true;
  }
}
