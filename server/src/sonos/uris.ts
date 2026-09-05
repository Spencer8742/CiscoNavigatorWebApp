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

/**
 * How a thing has to be handed to a speaker.
 *
 * Not a taxonomy of music — a taxonomy of *SOAP sequences*, because Sonos has
 * three genuinely different ones and sending the wrong one is accepted and
 * then fails, or worse, succeeds silently.
 *
 * | Style       | Play now                       | Add to queue        |
 * |-------------|--------------------------------|---------------------|
 * | `stream`    | `SetAVTransportURI`            | impossible          |
 * | `container` | `SetAVTransportURI`            | `AddURIToQueue`     |
 * | `track`     | `AddURIToQueue` + point at it  | `AddURIToQueue`     |
 */
export type PlayStyle = 'stream' | 'container' | 'track';

export interface Playable {
  /**
   * The `res` value: what actually goes to the speaker. Null for a row that
   * had none, which is normal for local library containers.
   */
  uri: string | null;
  /**
   * The DIDL object id — `A:ALBUM/The%20Wall`, `FV:2/12`.
   *
   * Kept alongside the URI rather than instead of it because the two are used
   * for different things: the URI plays, the object id BROWSES. A favourited
   * playlist has both, and using its `x-rincon-cpcontainer:` URI to try to
   * open it is a Browse that returns nothing.
   */
  objectId: string | null;
  /** DIDL-Lite describing it, or '' when Sonos does not need any. */
  metadata: string;
  style: PlayStyle;
  /**
   * The music service this came from, when it came from one.
   *
   * What makes `objectId` mean two different things. A local container's id is
   * an address in a speaker's ContentDirectory; a Plex container's id is an
   * address in Plex, and opening it means a SMAPI call to Plex rather than a
   * Browse to a speaker. Without this the two are indistinguishable strings.
   */
  sid: number | null;
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

/**
 * URI schemes that name a COLLECTION the speaker resolves for itself.
 *
 * `x-rincon-cpcontainer` is a music service's playlist, album or station list
 * — the thing behind almost every favourite that is not a radio station.
 * `x-rincon-playlist` is the local-library equivalent.
 *
 * Both are handed to `SetAVTransportURI` to play, and that is the fix for the
 * bug this table exists to prevent: sent down the track path instead, the
 * speaker enqueues nothing, the transport is pointed at an empty queue, and
 * `Play` answers UPnP 701.
 */
const CONTAINER_SCHEMES = new Set(['x-rincon-cpcontainer', 'x-rincon-playlist']);

function schemeOf(uri: string): string {
  const colon = uri.indexOf(':');
  return colon === -1 ? '' : uri.slice(0, colon).toLowerCase();
}

/** Which of the three SOAP sequences this thing needs. */
export function playStyleOf(uri: string | null, upnpClass = ''): PlayStyle {
  if (upnpClass.includes('audioBroadcast')) return 'stream';

  if (uri) {
    const scheme = schemeOf(uri);
    if (STREAM_SCHEMES.has(scheme)) return 'stream';
    if (CONTAINER_SCHEMES.has(scheme)) return 'container';
  }

  // `object.container...` covers albums, artists, playlists and genres —
  // everything the local library returns without a `res` of its own.
  return upnpClass.includes('object.container') ? 'container' : 'track';
}

export class UriRegistry {
  /** key → playable. Insertion-ordered, which is what makes eviction FIFO. */
  readonly #items = new Map<string, Playable>();

  /**
   * Register something playable and return the key the panel should use.
   *
   * Returns null when there is neither a URI nor an object id, so a browse row
   * that cannot be played becomes a row with no key — which the panel already
   * draws as disabled — rather than a key that fails later.
   */
  register(
    uri: string | null,
    objectId: string | null,
    metadata: unknown,
    upnpClass = '',
    sid: number | null = null,
  ): string | null {
    const playUri = usable(uri);
    const id = usable(objectId);
    if (!playUri && !id) return null;

    /*
     * Keyed on all three parts, separated by a character none can contain.
     *
     * A local album carries only an object id, and a favourite pointing at the
     * same album carries only a URI; they are different rows and must not
     * collide. Joining them without a separator would let one row's URI plus
     * an empty id hash identically to an empty URI plus another row's id.
     *
     * The service matters for the same reason and more sharply: every
     * service's tree is rooted at the id `root`, so without it Plex's root and
     * SoundCloud's would be the same key and one would evict the other.
     */
    const key = createHash('sha256')
      .update(`${playUri ?? ''}\u0000${id ?? ''}\u0000${sid ?? ''}`)
      .digest('hex')
      .slice(0, 16);

    // Re-registering moves the entry to the back of the eviction queue, so
    // something still on screen does not age out from under a panel that has
    // been idling on one page.
    this.#items.delete(key);
    this.#items.set(key, {
      uri: playUri,
      objectId: id,
      metadata: typeof metadata === 'string' ? metadata : '',
      style: playStyleOf(playUri, upnpClass),
      sid,
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

/** A non-empty string of sane length, or null. */
function usable(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= 2000 ? trimmed : null;
}
