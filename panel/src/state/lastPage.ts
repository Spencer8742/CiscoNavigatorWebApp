import { effect } from '@preact/signals';
import { setPref } from '~/net/socket.ts';
import { isRouteVisible, prefs, route, socketState } from '~/state/ui.ts';
import type { PanelPage } from '@shared/protocol.ts';

/**
 * Come back to the page the panel was left on.
 *
 * Everywhere else, this panel already behaves as though the screen someone
 * chose is the screen that should be there when they return: idling to the
 * screensaver and waking puts you back where you were, and `state/idle.ts`
 * deliberately stopped navigating Home on a timer to make that true. A
 * reload was the one thing that broke it — redeploy the container, or let
 * RoomOS reboot overnight, and a panel left on Lights came back on Home.
 *
 * ## Why the backend holds it
 *
 * The obvious place is `localStorage`, and it is the wrong one: RoomOS wipes
 * web storage daily (docs/ROOMOS.md §3), so the memory would evaporate every
 * night — and specifically overnight, which is when the reboots that need it
 * happen. It goes in the per-panel preferences with everything else, keyed by
 * the panel's own id, so two panels in different rooms remember separately.
 *
 * ## Two rules that matter more than they look
 *
 * **Restore exactly once per page load.** `hello` arrives again on every
 * reconnect — a Wi-Fi roam, an AP reboot, the backend restarting — and
 * re-applying the stored page then would yank someone off the screen they
 * are standing in front of, back to wherever they were before the drop. The
 * flag below is the whole guard.
 *
 * **Re-sync after a reconnect.** Writes are fire-and-forget over the socket,
 * so navigating while the connection is down is simply lost. When the socket
 * comes back, the stored page is stale — pointing at where the panel was
 * before the drop, not where it is now. The restore path therefore pushes
 * the current page up instead of pulling the old one down.
 */

/** Whether the stored page has already been applied for this page load. */
let restored = false;

/** Test seam: forget that this page load ever restored. */
export function resetPageMemory(): void {
  restored = false;
}

/**
 * `settings` is a `Route` but not a `PanelPage`, which is exactly the
 * distinction wanted here: a panel that reboots into its own configuration
 * screen looks broken, and on a finished panel (`showSettings: false`) it is
 * not reachable to restore to anyway.
 */
function pageOf(value: string): PanelPage | null {
  return value === 'settings' ? null : (value as PanelPage);
}

export function startPageMemory(): void {
  /*
   * Restore on the first snapshot, and re-sync on every one after it.
   *
   * `socketState` rather than `ready`, which is the more obvious choice and
   * the wrong one. `ready` is set true by the same `hello` handler, but it
   * is never set back to false — a dropped connection is deliberately a
   * status-dot matter, not something that unmounts a working dashboard. A
   * signal written the value it already holds notifies nobody, so an effect
   * watching `ready` runs once in the life of the page and the re-sync below
   * would never happen at all.
   *
   * `socketState` genuinely cycles: 'connected' on `hello`, 'connecting' on
   * close. It is also set a line earlier than `ready` in that handler, by
   * which point the config and this panel's preferences are both already in
   * hand — which is what `isRouteVisible` needs.
   */
  effect(() => {
    if (socketState.value !== 'connected') return;

    const stored = prefs.peek();
    const current = route.peek();

    if (restored) {
      // A later `hello`: a reconnect, not a fresh load. Anything the panel
      // navigated to while the socket was down never reached the backend.
      const here = pageOf(current);
      if (stored.rememberPage && here && stored.lastPage !== here) setPref('lastPage', here);
      return;
    }
    restored = true;

    if (!stored.rememberPage) return;
    const target = stored.lastPage;
    if (!target || target === current) return;
    // The page may have been hidden from the nav since it was written.
    // `visibleRoutes` already falls back for an unreachable route, but
    // landing on Home is a better answer than landing somewhere and being
    // bounced off it a tick later.
    if (!isRouteVisible(target)) return;

    route.value = target;
  });

  /*
   * Record every navigation after that.
   *
   * Reads `route` reactively and everything else with `peek`: this must run
   * when the page changes and at no other time. Subscribing to `prefs` would
   * re-run it on every preference broadcast from another panel, and
   * `setPref` writes `prefs` itself, which would be a loop.
   */
  effect(() => {
    const current = route.value;
    if (!restored) return;

    const stored = prefs.peek();
    if (!stored.rememberPage) return;

    const here = pageOf(current);
    if (!here || stored.lastPage === here) return;

    setPref('lastPage', here);
  });
}
