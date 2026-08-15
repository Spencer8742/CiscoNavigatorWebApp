import { Nav } from '~/components/Nav.tsx';
import { Toast } from '~/components/Toast.tsx';
import { ErrorBoundary } from '~/components/ErrorBoundary.tsx';
import { Home } from '~/screens/Home.tsx';
import { Rooms } from '~/screens/Rooms.tsx';
import { Media } from '~/screens/Media.tsx';
import { Photos } from '~/screens/Photos.tsx';
import { Settings } from '~/screens/Settings.tsx';
import { ConnectionHelp } from '~/screens/ConnectionHelp.tsx';
import { EntitySheet } from '~/components/EntitySheet.tsx';
import { ui } from '~/config/index.ts';
import { connectionProblem, ready, route } from '~/state/ui.ts';

/**
 * The shell.
 *
 * Two structural rules, both consequences of running in a kiosk web view that
 * the user cannot dismiss or reload:
 *
 * 1. **The shell never unmounts.** Screens are swapped inside it; the nav and
 *    the error boundary persist. No data-loading failure anywhere below can
 *    take the frame down.
 *
 * 2. **Only the active screen is mounted.** Keeping all five alive would mean
 *    five sets of subscriptions and timers running against a memory budget
 *    that terminates the web view when exceeded (docs/ROOMOS.md §2). Screens
 *    are cheap to rebuild — all their state lives in signals outside them —
 *    so mounting on demand is both lighter and simpler.
 */
export function App() {
  return (
    <ErrorBoundary>
      <div class="shell" data-nav={ui.value.navPosition}>
        <div class="shell-nav">
          <Nav />
        </div>
        <main class="shell-main">
          <Screen />
        </main>
      </div>
      {/* One sheet for the whole app, driven by the `openEntity` signal.
          Mounted here so any screen can open one by writing a value, and so
          only one can ever be open. */}
      <EntitySheet />
      <Toast />
    </ErrorBoundary>
  );
}

function Screen() {
  if (!ready.value) {
    // Once we know why we cannot connect, say so. A spinner that never
    // resolves is indistinguishable from a crash, and this device has no
    // address bar to investigate with.
    if (connectionProblem.value) return <ConnectionHelp />;

    // Hold the boot spinner until the backend's `hello` has landed. Flashing
    // an empty dashboard for a few hundred milliseconds and then filling it
    // in looks broken; a brief spinner does not.
    return (
      <div id="boot">
        <span />
      </div>
    );
  }

  switch (route.value) {
    case 'home':
      return <Home />;
    case 'rooms':
      return <Rooms />;
    case 'media':
      return <Media />;
    case 'photos':
      return <Photos />;
    case 'settings':
      return <Settings />;
    default:
      return <Home />;
  }
}
