/**
 * Google Cast receiver support, for Nest Hub displays.
 *
 * ## Why this file exists at all
 *
 * A Nest Hub runs Fuchsia. It has no browser, no sideloading and no kiosk
 * mode, so casting is the *only* way to put our own pixels on that screen.
 * The usual route is DashCast — a published Cast receiver that simply
 * navigates to a URL you give it.
 *
 * That navigation is the problem. DashCast does `window.location = url`,
 * which destroys the receiver's own JavaScript context. Nothing is left
 * running to tell the device the session is still wanted, so Google's idle
 * timeout reclaims the screen — historically after ten minutes, and after the
 * Fuchsia update, after about thirty seconds.
 *
 * But *we* land in that context. Once DashCast has navigated, this page is
 * what is running inside the receiver, and it can pick up the receiver role
 * that DashCast dropped. That is the trick `ha-catt-fix` uses for Home
 * Assistant, and we can do it natively because we own the frontend.
 *
 * ## What we ask for
 *
 * - `disableIdleTimeout` — the actual fix. Tells the platform this receiver
 *   is a long-lived experience rather than a finished video.
 * - `touchScreenOptimizedApp` — asks the platform to deliver touch to the
 *   page. Whether a Nest Hub honours this for a receiver reached via
 *   DashCast is genuinely unverified; if it does, the dashboard becomes
 *   interactive, and if it does not, cast mode is still a display. Nothing
 *   depends on it working.
 *
 * ## What this deliberately does NOT do
 *
 * Nothing here runs unless the page was opened in cast mode. The Navigator is
 * the primary target and must not pay a byte for this: the SDK is loaded from
 * Google at runtime, only on a device that is already casting, and the import
 * never happens otherwise.
 */

const SDK_URL = 'https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js';

/** How long to wait for Google's SDK before giving up and just being a page. */
const SDK_TIMEOUT_MS = 8000;

/**
 * The receiver SDK's surface, narrowed to what we use.
 *
 * Hand-written rather than pulled from `@types/chromecast-caf-receiver`: we
 * touch four methods, and a dependency whose types describe an API we load at
 * runtime from a CDN would be a build-time cost for no checking we do not
 * already get from this.
 */
interface CastReceiverContext {
  start(options: Record<string, unknown>): void;
  setInactivityTimeout?(seconds: number): void;
}

interface CastGlobal {
  framework?: {
    CastReceiverContext?: { getInstance(): CastReceiverContext };
  };
}

declare global {
  interface Window {
    cast?: CastGlobal;
  }
}

/**
 * Whether this page should render as a cast display.
 *
 * Explicit `?cast=1` rather than sniffing the user agent. Sniffing would make
 * the panel behave differently on a device nobody chose it for, and the URL is
 * something you set once in the cast command anyway.
 */
export function isCastMode(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('cast') === '1';
  } catch {
    return false;
  }
}

/**
 * A single pane this display should show and stay on, from `?pane=`.
 *
 * Per-display rather than per-config because that is how these are actually
 * used: the kitchen Hub wants what is playing, the hallway one wants the
 * clock, and they share one `dashboard.yaml`. The cast URL is the only thing
 * that differs between them, so it is the right place to say so.
 *
 * Returns null when absent or unrecognised, which falls back to the
 * configured rotation.
 */
export function castPaneOverride(): string | null {
  try {
    const pane = new URLSearchParams(window.location.search).get('pane');
    return pane && pane.length < 20 ? pane : null;
  } catch {
    return null;
  }
}

let started = false;

/**
 * Take over the Cast receiver session, if we are in one.
 *
 * Safe to call anywhere: it resolves quietly when there is no cast context,
 * which is the normal case on the Navigator and in a desktop browser. Failure
 * is never fatal — the worst outcome is a page that renders correctly and gets
 * reclaimed by the idle timeout, which is exactly where we would have been
 * without it.
 */
export async function startCastReceiver(): Promise<boolean> {
  if (started) return true;
  started = true;

  try {
    await loadSdk();
  } catch {
    // No SDK: we are being viewed in an ordinary browser, or Google is
    // unreachable. Cast mode still renders; it just will not hold the screen.
    return false;
  }

  const ctx = window.cast?.framework?.CastReceiverContext?.getInstance();
  if (!ctx) return false;

  try {
    ctx.start({
      // The reason this file exists.
      disableIdleTimeout: true,
      // Ask for touch. Unverified on a Nest Hub reached through DashCast —
      // see the header comment. Nothing depends on it.
      touchScreenOptimizedApp: true,
      // We are not a media receiver and have no sender app to talk to.
      // Skipping the player avoids the SDK waiting for a media session that
      // is never going to arrive.
      skipPlayersLoad: true,
      // Do not tear the session down when the sender goes away: the sender
      // here is a one-shot `catt cast_site` that exits immediately.
      maxInactivity: 0,
    });

    // Belt and braces. Some platform builds honour this where the start
    // option is ignored; setting both costs nothing.
    ctx.setInactivityTimeout?.(0);
    return true;
  } catch {
    return false;
  }
}

function loadSdk(): Promise<void> {
  if (window.cast?.framework) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;

    const timer = setTimeout(() => {
      script.remove();
      reject(new Error('Cast SDK timed out'));
    }, SDK_TIMEOUT_MS);

    script.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    script.onerror = () => {
      clearTimeout(timer);
      script.remove();
      reject(new Error('Cast SDK failed to load'));
    };

    document.head.appendChild(script);
  });
}
