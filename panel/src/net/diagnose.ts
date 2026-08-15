import { authHeaders, getToken } from '~/net/auth.ts';

/**
 * Work out *why* the panel cannot connect, and say so on screen.
 *
 * This exists because of a failure mode that actually happened: the backend
 * was running and healthy, the page loaded, and the panel sat on a spinner
 * forever while the server log filled with `Rejected unauthenticated
 * WebSocket upgrade`. The panel had no token because the URL was opened
 * without `?t=`. Nothing on screen said so — and on a Room Navigator in
 * kiosk mode there is no address bar, no console, and no way to reach the
 * Settings screen, because Settings is behind the very connection that is
 * failing.
 *
 * A spinner that never resolves is indistinguishable from a crash. On a
 * device you need a ladder to reach, that is not an acceptable failure mode.
 *
 * ## Why probe at all?
 *
 * The browser WebSocket API deliberately hides the HTTP status of a failed
 * upgrade — `onerror` carries no detail and `onclose` reports 1006 for
 * everything. So the socket itself can never tell us whether it was refused
 * for auth, blocked by a proxy, or simply unreachable.
 *
 * Two plain HTTP requests can, because they differ in exactly one respect:
 *
 *   /api/health   never requires a token
 *   /api/config   always requires one
 *
 * | health | config | conclusion                                  |
 * |--------|--------|---------------------------------------------|
 * | fails  |   —    | backend unreachable                         |
 * |  200   |  401   | token missing or wrong                      |
 * |  200   |  200   | HTTP fine, WebSocket blocked (proxy)        |
 */

export type ProblemKind = 'unreachable' | 'unauthorized' | 'websocket-blocked' | 'unknown';

export interface ConnectionProblem {
  kind: ProblemKind;
  title: string;
  detail: string;
  /** The one thing to do about it. */
  fix: string;
}

const TIMEOUT_MS = 5000;

async function probe(path: string, withAuth: boolean): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      signal: controller.signal,
      headers: withAuth ? authHeaders() : {},
      cache: 'no-store',
    });
    return res.status;
  } catch {
    // Network-level failure — no response at all.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function diagnose(): Promise<ConnectionProblem> {
  const host = window.location.host;

  const healthStatus = await probe('/api/health', false);

  if (healthStatus === null) {
    return {
      kind: 'unreachable',
      title: 'Cannot reach the panel server',
      detail: `No response from ${host}.`,
      fix: 'Check that the navigator-panel container is running, and that this device is on the same network.',
    };
  }

  const configStatus = await probe('/api/config', true);

  if (configStatus === 401) {
    return {
      kind: 'unauthorized',
      title: getToken() ? 'This panel token is not accepted' : 'No panel token',
      detail: getToken()
        ? 'The server rejected the stored token. It was most likely changed on the server.'
        : 'This page was opened without a token, so the panel cannot authenticate.',
      // The single most useful sentence this app can display.
      fix: `Open this address once, with the PANEL_TOKEN set on the server:\n\nhttp://${host}/?t=YOUR_PANEL_TOKEN`,
    };
  }

  if (configStatus !== null && configStatus >= 200 && configStatus < 300) {
    return {
      kind: 'websocket-blocked',
      title: 'Live connection blocked',
      detail:
        'The server is reachable and the token is accepted, but the WebSocket could not be established.',
      fix: 'If a reverse proxy sits in front of the panel, it must forward the Upgrade and Connection headers. See docs/DEPLOYMENT.md §2.',
    };
  }

  return {
    kind: 'unknown',
    title: 'Cannot connect',
    detail: `The server answered /api/config with HTTP ${configStatus ?? 'no response'}.`,
    fix: 'Check the container logs: docker logs navigator-panel',
  };
}
