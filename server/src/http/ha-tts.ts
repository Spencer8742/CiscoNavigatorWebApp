import type { ServerResponse } from 'node:http';
import { logger } from '~/lib/log.ts';
import type { Env } from '~/env.ts';

const log = logger('tts');

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

/**
 * Proxy for Home Assistant generated TTS audio.
 *
 * Assist returns a HA-local URL for generated speech. The Echo should not need
 * to know that host or hold a HA token, so the panel plays this same-origin
 * proxy path instead.
 */
export class HaTtsProxy {
  readonly #env: Env['ha'];

  constructor(env: Env['ha']) {
    this.#env = env;
  }

  pathFor(rawUrl: string | null): string | null {
    const path = safeHaTtsPath(rawUrl);
    if (!path) return null;
    return `/api/assist/tts?p=${encodeURIComponent(path)}`;
  }

  async serve(res: ServerResponse, rawPath: string | null): Promise<void> {
    if (!this.#env.enabled) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('Home Assistant is not configured');
      return;
    }

    const path = safeHaTtsPath(rawPath);
    if (!path) {
      log.warn(`Refused TTS path: ${String(rawPath).slice(0, 120)}`);
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad path');
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const upstream = await fetch(this.#env.url + path, {
        headers: { authorization: `Bearer ${this.#env.token}` },
        signal: controller.signal,
      });

      if (!upstream.ok || !upstream.body) {
        res.writeHead(upstream.status === 404 ? 404 : 502, { 'content-type': 'text/plain' });
        res.end('TTS audio unavailable');
        return;
      }

      const type = (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (!type.startsWith('audio/')) {
        log.warn(`Upstream returned non-audio content-type "${type}" for TTS`);
        res.writeHead(415, { 'content-type': 'text/plain' });
        res.end('Not audio');
        return;
      }

      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
      });

      let sent = 0;
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sent += value.byteLength;
        if (sent > MAX_BYTES) {
          log.warn('TTS audio exceeded size limit - truncating');
          await reader.cancel().catch(() => undefined);
          break;
        }
        if (!res.write(value)) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('TTS audio fetch failed');
      } else {
        res.end();
      }
      log.debug('TTS audio fetch failed:', err);
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeHaTtsPath(raw: string | null): string | null {
  if (!raw) return null;

  let path = raw;
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      const parsed = new URL(raw);
      path = parsed.pathname + parsed.search;
    } else {
      path = decodeURIComponent(raw);
    }
  } catch {
    return null;
  }

  if (path.includes('\0') || path.includes('\\')) return null;
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  if (path.includes('..')) return null;
  if (!path.startsWith('/api/tts_proxy/')) return null;

  return path;
}
