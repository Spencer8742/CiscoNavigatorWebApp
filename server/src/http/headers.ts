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
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "media-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  // The panel needs none of these; denying them is free.
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  // Never let an intermediary or a browser cache an authenticated API
  // response — this is overridden explicitly for /img, which is immutable.
  res.setHeader('x-frame-options', 'DENY');
}
