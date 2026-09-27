import { effect } from '@preact/signals';
import { controlPages, roomsById } from '~/config/index.ts';
import { setPref } from '~/net/socket.ts';
import {
  activeRoom,
  controlPage,
  isRouteVisible,
  prefs,
  route,
  socketState,
} from '~/state/ui.ts';
import type { PanelPage } from '@shared/protocol.ts';

/**
 * Come back to where the panel was left — the page, and the place within it.
 *
 * Everywhere else this panel already behaves as though the screen someone
 * chose is the screen that should be there when they return: idling to the
 * screensaver and waking puts you back where you were, and `state/idle.ts`
 * deliberately stopped navigating Home on a timer to make that true. A
 * reload was the one thing that broke it — redeploy the container, or let
 * RoomOS reboot overnight, and a panel left on the Lights keys came back on
 * Home.
 *
 * Three things are remembered, all under the one `rememberPage` switch:
 *
 * | | signal | restored to |
 * |---|---|---|
 * | the page | `route` | the nav destination |
 * | the room | `activeRoom` | the Rooms drill-down |
 * | the macro page | `controlPage` | which page of Controls |
 *
 * Sheets are not on that list and should not join it. `openEntity`,
 * `openSources`, the timer and Assist sheets are modal: a panel that boots
 * with a dialog over the screen has not restored anything, it has come up
 * broken, and on a wall there is nobody to dismiss it.
 *
 * ## Why the backend holds it
 *
 * The obvious place is `localStorage`, and it is the wrong one: RoomOS wipes
 * web storage daily (docs/ROOMOS.md §3), so the memory would evaporate every
 * night — and specifically overnight, which is when the reboots that need it
 * happen. It goes in the per-panel preferences, keyed by the panel's own id,
 * so two panels in different rooms remember separately.
 *
 * ## A reload is not a decision
 *
 * `navigate()` clears `activeRoom` on the way out of Rooms, on purpose, so
 * that leaving and coming back lands on the room list "rather than a room
 * the user has forgotten they were in". Restoring a room across a reload
 * does not contradict that rule; it relies on it. Leaving is something
 * somebody chose, and the clear records that choice. A reboot is not a
 * choice — nobody decided anything — so the panel puts back what was
 * interrupted. The two events are different, and only one of them means
 * "I am done with this room".
 *
 * `controlPage` needs no such argument: it already survives leaving the
 * Controls screen within a session, for the reason given where it is
 * declared, and this carries that across a reload.
 *
 * ## Two rules that matter more than they look
 *
 * **Restore exactly once per page load.** `hello` arrives again on every
 * reconnect — a Wi-Fi roam, an AP reboot, the backend restarting — and
 * re-applying then would yank someone off the screen they are standing in
 * front of, back to wherever they were before the drop.
 *
 * **Re-sync after a reconnect.** Writes are fire-and-forget over the socket,
 * so moving around while the connection is down is simply lost. When it
 * comes back the stored place is stale, so the restore path pushes what is
 * on screen up instead of pulling the old value down.
 */

/** Whether the stored place has already been applied for this page load. */
let restored = false;

/** Test seam: forget that this page load ever restored. */
export function resetPlaceMemory(): void {
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

/**
 * Put back what was interrupted, as far as the config still allows.
 *
 * Each piece is checked against the config it names, because dashboard.yaml
 * may have been edited since — a room deleted, a macro page renamed. The
 * stored value is left alone when it no longer resolves: it costs nothing,
 * and the id may come back when somebody fixes a typo in the YAML. What
 * matters is not navigating to it.
 *
 * Order matters. The sub-page is set before the route so the screen mounts
 * already knowing where it is, rather than painting the room list for a
 * frame and then replacing it.
 */
function applyStored(): void {
  const stored = prefs.peek();

  if (stored.lastControlPage && controlPages.peek().some((p) => p.id === stored.lastControlPage)) {
    controlPage.value = stored.lastControlPage;
  }

  const target = stored.lastPage;
  if (!target || !isRouteVisible(target)) return;

  if (target === 'rooms' && stored.lastRoom && roomsById.peek().has(stored.lastRoom)) {
    activeRoom.value = stored.lastRoom;
  }

  if (target !== route.peek()) route.value = target;
}

/** Push what is on screen up, for writes lost while the socket was down. */
function resync(): void {
  const stored = prefs.peek();
  const here = pageOf(route.peek());

  if (here && stored.lastPage !== here) setPref('lastPage', here);

  const room = activeRoom.peek();
  if (stored.lastRoom !== room) setPref('lastRoom', room);

  const page = controlPage.peek();
  if (page && stored.lastControlPage !== page) setPref('lastControlPage', page);
}

export function startPlaceMemory(): void {
  /*
   * Restore on the first snapshot, and re-sync on every one after it.
   *
   * `socketState` rather than `ready`, which is the more obvious choice and
   * the wrong one. `ready` is set true by the same `hello` handler, but it
   * is never set back to false — a dropped connection is deliberately a
   * status-dot matter, not something that unmounts a working dashboard. A
   * signal written the value it already holds notifies nobody, so an effect
   * watching `ready` runs once in the life of the page and the re-sync would
   * never happen at all.
   *
   * `socketState` genuinely cycles: 'connected' on `hello`, 'connecting' on
   * close. It is also set a line earlier than `ready` in that handler, by
   * which point the config and this panel's preferences are both already in
   * hand — which is what the config checks above need.
   */
  effect(() => {
    if (socketState.value !== 'connected') return;

    if (restored) {
      if (prefs.peek().rememberPage) resync();
      return;
    }
    restored = true;

    if (prefs.peek().rememberPage) applyStored();
  });

  /*
   * Record movement after that.
   *
   * One effect per signal, so a room change does not rewrite the page and a
   * page change does not rewrite the room. Each reads its own signal
   * reactively and everything else with `peek`: subscribing to `prefs` would
   * re-run these on any preference broadcast, and `setPref` writes `prefs`
   * itself, which would be a loop.
   */
  effect(() => {
    const here = pageOf(route.value);
    if (!restored || !here) return;
    const stored = prefs.peek();
    if (!stored.rememberPage || stored.lastPage === here) return;
    setPref('lastPage', here);
  });

  /*
   * Rooms, including the clear. `navigate()` sets this to null on the way
   * out of Rooms, and that null has to be written: a room left behind in the
   * preferences would be restored the next time `lastPage` brought the panel
   * back to Rooms, which is the drill-down somebody had already dismissed.
   */
  effect(() => {
    const room = activeRoom.value;
    if (!restored) return;
    const stored = prefs.peek();
    if (!stored.rememberPage || stored.lastRoom === room) return;
    setPref('lastRoom', room);
  });

  effect(() => {
    const page = controlPage.value;
    if (!restored || !page) return;
    const stored = prefs.peek();
    if (!stored.rememberPage || stored.lastControlPage === page) return;
    setPref('lastControlPage', page);
  });
}
