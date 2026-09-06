import { authority } from '~/sonos/soap.ts';
import { find, parseXml, textOf } from '~/sonos/xml.ts';

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
  /** Seconds, when the provider includes it on the playable `res` element. */
  duration: number | null;
}

/** One row of a browse result. */
export interface DidlEntry {
  /** DIDL object id — `Q:0/5`, `A:ALBUM/…`, `FV:2/12`. */
  id: string;
  title: string;
  /** Artist, or the station for a radio favourite. */
  creator: string | null;
  album: string | null;
  artUri: string | null;
  /** `upnp:class`, which is how Sonos says what kind of thing this is. */
  upnpClass: string;
  /**
   * The class of what a favourite POINTS AT, from inside `r:resMD`.
   *
   * A row in `FV:2` carries `object.itemobject.item.sonos-favorite` — the class
   * of *being a favourite*, which says nothing about the content. The real
   * class is one level down, in the metadata Sonos wants handed back.
   *
   * Reading only the outer class makes every favourite look like a track: it
   * is drawn with a track icon, and — much worse — it is played down the queue
   * path, which is how a favourited playlist becomes UPnP 701.
   */
  resClass: string | null;
  /** Object id inside `r:resMD`, used to open local favourites. */
  resId: string | null;
  /** The playable URI, when the row has one. Containers often do. */
  res: string | null;
  /**
   * `r:resMD` — the metadata Sonos needs handed back to play this.
   *
   * Favourites and music-service items carry it, and playing one WITHOUT it
   * gets a speaker that accepts the command and plays silence. It is the
   * single most important field on a favourite, and the least obvious.
   */
  resMD: string | null;
  /** Seconds, from the `res` element's `duration` attribute. */
  duration: number | null;
}

/**
 * Parse a `Browse` result: a DIDL-Lite document of items and containers.
 *
 * Containers and items are treated the same way deliberately. An album is a
 * container and a track is an item, but both have a title, artwork and a URI
 * you can hand to a speaker, and the panel draws them from the same row
 * component. What separates them is `upnp:class`, which is carried through
 * rather than baked into two shapes here.
 */
export function parseDidlList(xml: string | null): DidlEntry[] {
  if (!xml || xml.length === 0) return [];
  const root = parseXml(xml);
  if (!root) return [];

  const out: DidlEntry[] = [];

  /*
   * Walked in DOCUMENT ORDER, over the root's own children.
   *
   * Collecting all the items and then all the containers would be simpler and
   * would silently re-sort every mixed result — Favorites holds playlists,
   * stations and albums interleaved in the order somebody chose in the Sonos
   * app, and that order is the whole value of the list.
   */
  for (const node of root.children) {
    const local = node.name.slice(node.name.indexOf(':') + 1);
    if (local !== 'item' && local !== 'container') continue;

    const title = textOf(node, 'title');
    if (!title) continue;

    const res = find(node, 'res');
    const resMD = textOf(node, 'resMD');

    const metadata = metadataOf(resMD);
    out.push({
      id: node.attrs['id'] ?? '',
      title,
      creator: textOf(node, 'creator') ?? textOf(node, 'artist') ?? null,
      album: textOf(node, 'album'),
      artUri: textOf(node, 'albumArtURI'),
      upnpClass: textOf(node, 'class') ?? '',
      resClass: metadata.className,
      resId: metadata.id,
      res: res ? (res.text.trim() || null) : null,
      resMD,
      duration: hmsToSeconds(res?.attrs['duration']),
    });
  }
  return out;
}

/**
 * The `upnp:class` inside a favourite's `r:resMD`.
 *
 * `resMD` is a whole DIDL document escaped into one text node, so this is a
 * second parse of a string the outer parse already decoded — cheap (a few
 * hundred bytes) and done per row, which is the price of knowing that
 * "Discover Weekly" is a playlist rather than a track.
 */
function metadataOf(resMD: string | null): { className: string | null; id: string | null } {
  if (!resMD) return { className: null, id: null };
  const root = parseXml(resMD);
  if (!root) return { className: null, id: null };
  const record = root.children.find((node) => {
    const local = node.name.slice(node.name.indexOf(':') + 1);
    return local === 'item' || local === 'container';
  });
  return {
    className: textOf(root, 'class'),
    id: record?.attrs['id'] ?? null,
  };
}

/**
 * What a favourite really is, preferring the inner class over the outer one.
 *
 * Everywhere except inside `FV:2` these are the same string, so this is a
 * no-op for the library, the queue and every service listing.
 */
export function effectiveClass(entry: DidlEntry): string {
  if (entry.resClass && entry.upnpClass.includes('sonos-favorite')) return entry.resClass;
  return entry.upnpClass || (entry.resClass ?? '');
}

/** `0:03:21.000` → 201. The `res` duration carries milliseconds Sonos ignores. */
function hmsToSeconds(raw: string | undefined): number | null {
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length !== 3) return null;

  let total = 0;
  for (const part of parts) {
    const n = Number.parseFloat(part);
    if (!Number.isFinite(n)) return null;
    total = total * 60 + n;
  }
  return Math.round(total);
}

/** Parse a `TrackMetaData` / `CurrentURIMetaData` payload. */
export function parseTrackMetadata(xml: string | null): DidlTrack | null {
  if (!xml || xml.length === 0 || xml === 'NOT_IMPLEMENTED') return null;

  const root = parseXml(xml);
  if (!root) return null;

  const res = find(root, 'res');
  const track: DidlTrack = {
    title: textOf(root, 'title'),
    // `dc:creator` is the performing artist. `upnp:artist` also appears on
    // some providers, so it is the fallback rather than a second field.
    artist: textOf(root, 'creator') ?? textOf(root, 'artist'),
    album: textOf(root, 'album'),
    artUri: textOf(root, 'albumArtURI'),
    streamContent: textOf(root, 'streamContent'),
    duration: hmsToSeconds(res?.attrs['duration']),
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
