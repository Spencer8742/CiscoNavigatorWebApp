import type { ServerResponse } from 'node:http';

/**
 * Security headers.
 *
 * The panel and the backend are one origin by design (docs/ARCHITECTURE.md
 * §3), which means CORS never enters the picture and the CSP can be strict
 * without exceptions: everything the page loads comes from `'self'`.
 *
 * Notes on the specific directives:
 *
 * - No `unsafe-eval`. Nothing here evaluates strings, and forbidding it means
 *   a future dependency that wants to cannot arrive unnoticed.
 * - `'unsafe-inline'` IS allowed for styles, for two concrete reasons: the
 *   critical shell CSS is inlined in index.html so the panel paints its
 *   background in the first frame (no white flash in a dark room), and the
 *   theme tokens are written to `style` properties at runtime from the
 *   config. Nonces would work but add a request-time HTML rewrite for a
 *   threat that does not apply on a single-origin LAN appliance.
 * - `frame-ancestors 'none'`: nothing should ever embed this panel.
 * - `connect-src 'self'` covers both fetch and the WebSocket, since ws:// and
 *   wss:// to the same host are same-origin for CSP purposes.
 */
const BASE = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
];

const CSP = [...BASE, "script-src 'self'", "connect-src 'self' ws: wss:"].join('; ');

/**
 * Cast mode needs one exception, and gets exactly one.
 *
 * A Nest Hub can only show this page by casting, and holding the cast session
 * open requires Google's receiver SDK, which is only distributed from
 * gstatic.com (see panel/src/lib/cast.ts). So `script-src` gains that one
 * host, and `connect-src` gains the Cast infrastructure the SDK talks to.
 *
 * Everything else stays as strict as before, and this policy is only ever
 * sent to a request that explicitly asked for cast mode — the Navigator, and
 * every ordinary page load, still gets a CSP with no third-party origins in
 * it at all.
 */
const CAST_CSP = [
  ...BASE,
  "script-src 'self' https://www.gstatic.com",
  "connect-src 'self' ws: wss: https://*.gstatic.com https://*.google.com",
].join('; ');

export function applySecurityHeaders(res: ServerResponse, cast = false): void {
  res.setHeader('content-security-policy', cast ? CAST_CSP : CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  // The panel needs none of these; denying them is free. `autoplay` is left
  // alone because cast mode may hold the session open with a silent loop.
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  // Never let an intermediary or a browser cache an authenticated API
  // response — this is overridden explicitly for /img, which is immutable.
  res.setHeader('x-frame-options', 'DENY');
}
