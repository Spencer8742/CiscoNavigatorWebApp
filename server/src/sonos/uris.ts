import { createHash } from 'node:crypto';

/**
 * Playable things, addressed by a key the backend minted.
 *
 * Sonos will play whatever URI you hand it, including
 * `x-rincon-mp3radio://<anything>`. That is the same hole `mass/commands.ts`
 * closes by requiring a library URI with a non-network scheme — except that
 * Sonos's playable URIs *are* network URIs, so that defence does not port.
 *
 * The answer is already in this codebase. `http/media-art.ts` solves the
 * identical problem for artwork: the panel never names a URL, it names an
 * **opaque key the backend minted** from a URL an upstream produced.
 *
 *   browse result → register(uri, metadata) → MediaItem.u = "a3f9c1d2e8b40571"
 *   panel plays   → { verb: 'playItem', item: "a3f9c1d2e8b40571" }
 *   backend       → looks the pair up, sends SOAP
 *
 * There is no request the panel can compose that makes a speaker fetch a host
 * of its choosing. A key can only exist because a browse produced the URI it
 * stands for.
 *
 * The DIDL metadata rides along, which matters for more than tidiness: Sonos
 * needs an item's `r:resMD` to play it from a music service, and the panel
 * should never have been carrying that.
 */

/** Roughly a few library pages' worth. Well under a megabyte of strings. */
const MAX_ENTRIES = 4000;

/** Keys are hex digests, so this rejects anything the registry did not mint. */
const KEY_RE = /^[0-9a-f]{16}$/;

export interface Playable {
  /** The `res` value: what actually goes to the speaker. */
  uri: string;
  /** DIDL-Lite describing it, or '' when Sonos does not need any. */
  metadata: string;
  /**
   * Whether this must REPLACE what is playing rather than join a queue.
   *
   * A radio stream is not a track: it has no end, cannot be queued behind
   * anything, and `AddURIToQueue` on one either fails or produces a queue
   * entry that plays forever. Deciding this at registration is what keeps the
   * decision next to the metadata that justified it.
   */
  stream: boolean;
}

/**
 * URI schemes that are live streams rather than tracks.
 *
 * `x-sonosapi-stream` is a radio station, `x-sonosapi-radio` a service's radio
 * (Sonos Radio, Spotify's artist radio), `x-rincon-mp3radio` a direct MP3
 * stream, and `x-sonosapi-hls`/`hls-radio` the HLS forms. `x-rincon-stream` is
 * a physical line-in, and `x-sonos-htastream` a TV's optical input — neither
 * queueable either.
 */
const STREAM_SCHEMES = new Set([
  'x-sonosapi-stream',
  'x-sonosapi-radio',
  'x-sonosapi-hls',
  'x-sonosapi-hls-static',
  'hls-radio',
  'x-rincon-mp3radio',
  'x-rincon-stream',
  'x-sonos-htastream',
  'aac',
  'mms',
]);

/** True when this URI names something that cannot sensibly be queued. */
export function isStream(uri: string, upnpClass = ''): boolean {
  if (upnpClass.includes('audioBroadcast')) return true;
  const scheme = uri.slice(0, uri.indexOf(':')).toLowerCase();
  return STREAM_SCHEMES.has(scheme);
}

export class UriRegistry {
  /** key → playable. Insertion-ordered, which is what makes eviction FIFO. */
  readonly #items = new Map<string, Playable>();

  /**
   * Register something playable and return the key the panel should use.
   *
   * Returns null for anything without a URI, so a browse row that cannot be
   * played becomes a row with no key — which the panel already draws as
   * disabled — rather than a key that fails later.
   */
  register(uri: unknown, metadata: unknown, upnpClass = ''): string | null {
    if (typeof uri !== 'string' || uri.length === 0 || uri.length > 2000) return null;

    const key = createHash('sha256').update(uri).digest('hex').slice(0, 16);

    // Re-registering moves the entry to the back of the eviction queue, so
    // something still on screen does not age out from under a panel that has
    // been idling on one page.
    this.#items.delete(key);
    this.#items.set(key, {
      uri,
      metadata: typeof metadata === 'string' ? metadata : '',
      stream: isStream(uri, upnpClass),
    });

    while (this.#items.size > MAX_ENTRIES) {
      const oldest = this.#items.keys().next().value;
      if (oldest === undefined) break;
      this.#items.delete(oldest);
    }

    return key;
  }

  /**
   * Look a key up.
   *
   * Null after a backend restart, or once a key has aged out. The panel is
   * told plainly rather than being handed a silent failure — the item is
   * still on screen, so "browse to it again" is an instruction somebody can
   * actually follow.
   */
  get(key: unknown): Playable | null {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
    return this.#items.get(key) ?? null;
  }

  get size(): number {
    return this.#items.size;
  }
}
