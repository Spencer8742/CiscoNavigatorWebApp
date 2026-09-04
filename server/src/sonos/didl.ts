import { authority } from '~/sonos/soap.ts';
import { parseXml, textOf } from '~/sonos/xml.ts';

/**
 * DIDL-Lite: how Sonos describes a piece of music.
 *
 * It turns up everywhere — the current track, every row of the queue, every
 * favourite and every browse result — always as XML escaped inside another
 * XML document, and in phase 2 as XML escaped inside XML escaped inside a
 * `LastChange` event.
 *
 * Phase 1 reads one track. Browsing (phase 4) reads lists of these and needs
 * the `res` URI and the `r:resMD` metadata that go with playing them, which is
 * why this is its own file rather than a helper inside the store.
 */

export interface DidlTrack {
  title: string | null;
  artist: string | null;
  album: string | null;
  /** As Sonos gave it: usually a path on the coordinator, not a full URL. */
  artUri: string | null;
  /**
   * A radio stream's free-text "now playing" line.
   *
   * Live streams put the station in `dc:title` and the actual song here, so a
   * panel that only reads `dc:title` shows the station name for an hour and
   * looks frozen.
   */
  streamContent: string | null;
}

/** Parse a `TrackMetaData` / `CurrentURIMetaData` payload. */
export function parseTrackMetadata(xml: string | null): DidlTrack | null {
  if (!xml || xml.length === 0 || xml === 'NOT_IMPLEMENTED') return null;

  const root = parseXml(xml);
  if (!root) return null;

  const track: DidlTrack = {
    title: textOf(root, 'title'),
    // `dc:creator` is the performing artist. `upnp:artist` also appears on
    // some providers, so it is the fallback rather than a second field.
    artist: textOf(root, 'creator') ?? textOf(root, 'artist'),
    album: textOf(root, 'album'),
    artUri: textOf(root, 'albumArtURI'),
    streamContent: textOf(root, 'streamContent'),
  };

  const empty =
    track.title === null &&
    track.artist === null &&
    track.album === null &&
    track.streamContent === null;

  return empty ? null : track;
}

/**
 * Turn an album-art reference into something fetchable.
 *
 * Sonos returns a path on the coordinator (`/getaa?s=1&u=…`), so it only means
 * anything relative to that speaker. Resolving it here is what lets the
 * existing `MediaArt` registry treat it like any other upstream artwork URL —
 * the panel keeps receiving `/img/art?k=…` and knows nothing about Sonos.
 */
export function artUrl(artUri: string | null, host: string): string | null {
  if (!artUri) return null;
  try {
    return new URL(artUri, `http://${authority(host)}`).href;
  } catch {
    return null;
  }
}
