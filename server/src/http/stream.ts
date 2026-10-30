import type { ServerResponse } from 'node:http';

/**
 * Stream an upstream body to a panel, within a byte limit.
 *
 * Every proxy here — Immich photos, Home Assistant artwork and TTS audio,
 * browse covers — ends the same way, and the loop each of them used to carry
 * had three faults that only show up over months on a wall:
 *
 *  - **A panel that went away mid-image stranded the request.** Waiting for
 *    `drain` on a socket that has closed waits forever: the close never
 *    fires `drain`, and the upstream reader, its buffers and the closure all
 *    stayed reachable. Swiping quickly through photos on flaky Wi-Fi does
 *    exactly this, and each one leaked.
 *  - **The upstream kept downloading for nobody.** The fetch was only ever
 *    aborted by its timeout, so a closed panel still pulled the whole image.
 *  - **A cut-off body was sent as a complete one.** Truncating at the limit,
 *    or failing halfway, ended the response normally — and the response was
 *    marked cacheable, sometimes `immutable`, so the browser kept the broken
 *    half-image for a day or a week. Destroying the socket instead makes the
 *    browser see a failed load, which it does not cache and the panel already
 *    handles with its placeholder.
 *
 * Call this after the status and headers have been decided but BEFORE
 * `writeHead`: an upstream that declares a length over the limit is refused
 * with a clean 502 instead of being started and then cut.
 *
 * Resolves once the response has finished or been destroyed. Never rejects.
 */
export async function streamUpstream(
  upstream: Response,
  res: ServerResponse,
  opts: {
    status?: number;
    headers: Record<string, string>;
    maxBytes: number;
    /** Aborted when the panel disconnects, so the upstream stops too. */
    controller: AbortController;
    /** Called with a short reason when the body could not be sent whole. */
    onFail?: (reason: string) => void;
  },
): Promise<void> {
  const { controller, maxBytes } = opts;
  const body = upstream.body;

  const declared = Number(upstream.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    controller.abort();
    opts.onFail?.(`declared ${declared} bytes, over the ${maxBytes} byte limit`);
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Upstream response too large');
    return;
  }

  // Forwarding a known length lets the browser tell a cut-off body from a
  // complete one even if a proxy between here and the panel buffers it.
  const headers = { ...opts.headers };
  if (Number.isFinite(declared) && declared > 0 && !upstream.headers.get('content-encoding')) {
    headers['content-length'] = String(declared);
  }

  let gone = false;
  const onClose = (): void => {
    if (res.writableFinished) return;
    gone = true;
    controller.abort();
  };
  res.once('close', onClose);

  res.writeHead(opts.status ?? 200, headers);
  if (!body) {
    res.off('close', onClose);
    res.end();
    return;
  }

  const reader = body.getReader();
  let sent = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (gone) throw new Error('panel disconnected');
      sent += value.byteLength;
      if (sent > maxBytes) throw new Error(`exceeded the ${maxBytes} byte limit`);
      if (!res.write(value)) await drainOrClose(res);
    }
    res.off('close', onClose);
    res.end();
  } catch (err) {
    res.off('close', onClose);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    if (!gone) opts.onFail?.(err instanceof Error ? err.message : String(err));
    // Not end(): an ended response is a complete one as far as the browser
    // and its cache are concerned.
    res.destroy();
  }
}

/** Resolve when the response can take more, or has closed and never will. */
function drainOrClose(res: ServerResponse): Promise<void> {
  if (res.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}
