import { render } from 'preact';
import { App } from '~/app.tsx';
import { initAuth } from '~/net/auth.ts';
import { connect } from '~/net/socket.ts';
import { resyncClock, startClock } from '~/state/clock.ts';
import { startIdleMonitor } from '~/state/idle.ts';

import '~/styles/tokens.css';
import '~/styles/base.css';
import '~/styles/components.css';
import '~/styles/screens.css';

/**
 * Entry point.
 *
 * Boot order is deliberate: auth before the socket (the socket needs the
 * token), render before connect (so the first frame paints while the
 * WebSocket handshake is still in flight rather than after it).
 */

initAuth();

const root = document.getElementById('app');
if (root) {
  // Replaces the inline boot spinner from index.html.
  render(<App />, root);
}

startClock();
startIdleMonitor();
connect();

/**
 * Wake handling.
 *
 * RoomOS puts the device into standby and brings it back. On resume, timers
 * armed before the sleep may be stale and the socket may be half-open without
 * TCP having noticed. Re-syncing the clock here means the time is correct in
 * the first frame after wake rather than up to a minute later.
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resyncClock();
});

/**
 * Global safety nets.
 *
 * These do not recover anything by themselves — that is the ErrorBoundary's
 * job — but on a kiosk device the remote DevTools console is the only place
 * anyone will ever see an error, so nothing may be swallowed silently.
 */
window.addEventListener('error', (e) => {
  console.error('[panel] uncaught', e.error ?? e.message);
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('[panel] unhandled rejection', e.reason);
});

/**
 * Suppress pinch-zoom and double-tap zoom.
 *
 * Cisco warns specifically against a blanket preventDefault on `document`
 * because it breaks form elements (docs/ROOMOS.md §6). So this is narrow: it
 * cancels only MULTI-TOUCH gesture starts, and only outside form controls.
 * Single-finger interaction, scrolling and text fields are untouched.
 */
document.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length < 2) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
  },
  { passive: false },
);
