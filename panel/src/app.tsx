import { Nav } from '~/components/Nav.tsx';
import { Toast } from '~/components/Toast.tsx';
import { ErrorBoundary } from '~/components/ErrorBoundary.tsx';
import { Home } from '~/screens/Home.tsx';
import { Rooms } from '~/screens/Rooms.tsx';
import { Media } from '~/screens/Media.tsx';
import { Photos } from '~/screens/Photos.tsx';
import { Settings } from '~/screens/Settings.tsx';
import { ConnectionHelp } from '~/screens/ConnectionHelp.tsx';
import { Screensaver } from '~/screens/Screensaver.tsx';
import { Cast } from '~/screens/Cast.tsx';
import { EntitySheet } from '~/components/EntitySheet.tsx';
import { ui } from '~/config/index.ts';
import { connectionProblem, ready, route, screensaverActive } from '~/state/ui.ts';
import { isCastDashboard, isCastMode, startCastReceiver } from '~/lib/cast.ts';

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
/**
 * Cast mode is decided once, from the URL, and never changes.
 *
 * A signal would imply it can be toggled at runtime; it cannot, and reading a
 * constant keeps the Navigator's render path identical to what it was.
 */
const CAST = isCastMode();
/** `?cast=1&pane=dashboard` — the real dashboard, on a cast display. */
const CAST_DASHBOARD = CAST && isCastDashboard();

/*
 * Claim the Cast session as early as possible, for BOTH cast variants.
 *
 * Not inside a component: the receiver has to be claimed once per page, and
 * the timeout it is racing starts when the page loads, not when a component
 * happens to mount.
 */
if (CAST) void startCastReceiver();

export function App() {
  /*
   * Cast mode replaces the shell outright.
   *
   * No nav, no screensaver, no entity sheet — a cast display has nowhere to
   * navigate to and nothing to open. Mounting the full shell and hiding it
   * would leave every screen's timers and subscriptions running on a device
   * with less headroom than the Navigator.
   */
  if (CAST && !CAST_DASHBOARD) {
    return (
      <ErrorBoundary>
        {ready.value ? <Cast /> : <div id="boot"><span /></div>}
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      {/*
        The screensaver replaces the shell entirely rather than overlaying it.
        Mounting it means the dashboard's timers and subscriptions unmount,
        which matters on a device that runs for weeks — and unmounting it
        releases every decoded photo (see media/photos.ts) so the slideshow
        never holds tens of megabytes while the dashboard is in use.

        Waking is handled by the global activity listener in state/idle.ts, so
        a touch anywhere on the photo brings the panel back.
      */}
      {/*
        The screensaver is suppressed on a cast display. It is woken by touch,
        and on a Hub that may not deliver any — so it could take the screen and
        never give it back. Use the `photos` pane if you want the slideshow on
        a Hub.
      */}
      {screensaverActive.value && ready.value && !CAST ? <Screensaver /> : null}

      <div
        class="shell"
        data-nav={ui.value.navPosition}
        data-cast={CAST_DASHBOARD ? '' : undefined}
        data-hidden={screensaverActive.value && ready.value && !CAST ? '' : undefined}
      >
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
