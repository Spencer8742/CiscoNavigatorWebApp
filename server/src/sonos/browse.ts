import { logger } from '~/lib/log.ts';
import { artUrl, parseDidlList, type DidlEntry } from '~/sonos/didl.ts';
import { integer } from '~/sonos/soap.ts';
import { textOf } from '~/sonos/xml.ts';
import type { SonosClient } from '~/sonos/client.ts';
import type { SonosStore } from '~/sonos/store.ts';
import type { UriRegistry } from '~/sonos/uris.ts';
import type { SpotifySearch } from '~/sonos/spotify.ts';
import type { MediaArt } from '~/http/media-art.ts';
import {
  BROWSE_PAGE,
  type BrowseRequest,
  type BrowseResult,
  type MediaItem,
  type MediaKind,
  type QueueEntry,
} from '@shared/protocol.ts';

const log = logger('sonos-browse');

/**
 * Browsing Sonos, locally.
 *
 * All of this comes off the speakers themselves — no cloud, no account, no
 * API key. `ContentDirectory.Browse` addresses everything by an object id,
 * and the ids are the whole trick:
 *
 * | Object id  | What it is                                    |
 * |------------|-----------------------------------------------|
 * | `FV:2`     | Sonos favourites — the highest-value one       |
 * | `SQ:`      | Sonos playlists                                |
 * | `A:ALBUM`  | albums in the local library                    |
 * | `A:ARTIST` | artists                                        |
 * | `A:TRACKS` | tracks                                         |
 * | `R:0/0`    | saved radio stations                           |
 * | `Q:0`      | the queue the group is playing                 |
 *
 * **Favourites do most of the work.** Anything favourited in the Sonos app —
 * a Spotify playlist, a Sonos Radio station, an album — is in `FV:2` with the
 * metadata needed to play it, and needs no service authentication at all. That
 * is why it is the first tab rather than a footnote.
 *
 * ## Searching
 *
 * The local library searches by appending the term to a category id:
 * `A:ARTIST:beatles`. It is a prefix match rather than a real search, it is
 * what every local Sonos controller does, and it costs nothing.
 *
 * A streaming catalog cannot be searched this way — that needs the service's
 * own API, which is what `spotify.ts` is for.
 */

/** How Sonos names each library category. */
const LIBRARY: Record<string, string> = {
  favorites: 'FV:2',
  playlists: 'SQ:',
  album: 'A:ALBUM',
  artist: 'A:ARTIST',
  track: 'A:TRACKS',
  radio: 'R:0/0',
};

/** Which category a text search of the library should look in, by kind. */
const SEARCH_CATEGORY: Partial<Record<MediaKind, string>> = {
  track: 'A:TRACKS',
  album: 'A:ALBUM',
  artist: 'A:ARTIST',
};

const MAX_SEARCH_TEXT = 120;

export interface SonosBrowserDeps {
  client: SonosClient;
  store: SonosStore;
  uris: UriRegistry;
  art: MediaArt;
  spotify: SpotifySearch;
}

export class SonosBrowser {
  readonly #deps: SonosBrowserDeps;

  constructor(deps: SonosBrowserDeps) {
    this.#deps = deps;
  }

  /**
   * Handle one browse request.
   *
   * Throws with a message meant to be read on the panel — these are
   * user-visible and actionable, unlike the command guard's deliberately
   * vague refusals.
   */
  async browse(req: BrowseRequest): Promise<BrowseResult> {
    const client = this.#deps.client;
    if (!client.enabled) throw new Error('Sonos is not configured');
    if (client.state !== 'connected') {
      throw new Error(client.lastError ?? 'Sonos is not reachable');
    }

    switch (req.kind) {
      case 'library':
        return this.#library(req);
      case 'search':
        return this.#search(req);
      case 'item':
        return this.#item(req.uri, clamp(req.offset));
      case 'queue':
        return this.#queue(req.queueId, clamp(req.offset));
    }
  }

  /* ── Library ───────────────────────────────────────────────────────────*/

  async #library(req: Extract<BrowseRequest, { kind: 'library' }>): Promise<BrowseResult> {
    const offset = clamp(req.offset);

    /*
     * `favorite: true` means the Favorites tab, which on Sonos is a place
     * rather than a filter — `FV:2` is its own container holding whatever was
     * favourited, of any kind. So it is looked up before the media type,
     * which would otherwise send it to the album list.
     */
    const objectId = req.favorite ? LIBRARY['favorites'] : (LIBRARY[req.media] ?? LIBRARY['track']);

    return this.#page(objectId as string, offset);
  }

  /* ── Search ────────────────────────────────────────────────────────────*/

  async #search(req: Extract<BrowseRequest, { kind: 'search' }>): Promise<BrowseResult> {
    const query = typeof req.text === 'string' ? req.text.trim().slice(0, MAX_SEARCH_TEXT) : '';
    if (query.length === 0) return { kind: 'groups', groups: [] };

    if (req.source === 'spotify') return this.#deps.spotify.search(query);

    /*
     * Three category searches rather than one, because Sonos has no "search
     * everything" object id — and doing them concurrently means the extra two
     * cost nothing on a LAN.
     */
    const sections: { name: string; kind: MediaKind }[] = [
      { name: 'Songs', kind: 'track' },
      { name: 'Albums', kind: 'album' },
      { name: 'Artists', kind: 'artist' },
    ];

    const results = await Promise.all(
      sections.map(async (section) => {
        const category = SEARCH_CATEGORY[section.kind];
        if (!category) return { name: section.name, items: [] };
        try {
          // `A:ARTIST:beatles` — the term appended to the category is how a
          // local Sonos search is addressed. Prefix match, not full text.
          const page = await this.#page(`${category}:${query}`, 0);
          return {
            name: section.name,
            items: page.kind === 'list' ? page.items : [],
          };
        } catch {
          // A category with nothing indexed answers with an error rather than
          // an empty list. That is not a failed search.
          return { name: section.name, items: [] };
        }
      }),
    );

    return { kind: 'groups', groups: results.filter((g) => g.items.length > 0) };
  }

  /* ── Drilling in ───────────────────────────────────────────────────────*/

  /**
   * The contents of one container — an album's tracks, an artist's albums.
   *
   * The panel hands back the key it was given, which the registry resolves to
   * a DIDL object id. That is the same key it would use to PLAY the thing, so
   * opening an album and playing it are the same address used two ways.
   */
  async #item(key: string, offset: number): Promise<BrowseResult> {
    const playable = this.#deps.uris.get(key);
    if (!playable) {
      throw new Error('That item is no longer loaded — browse to it again');
    }
    // Containers usually have no `res`, so the registry stored their object id
    // instead — which is exactly what Browse wants to open them.
    return this.#page(playable.uri, offset);
  }

  /* ── The queue ─────────────────────────────────────────────────────────*/

  async #queue(playerId: string, offset: number): Promise<BrowseResult> {
    const zone = this.#deps.client.household.zones.get(playerId);
    if (!zone) throw new Error('Not permitted');

    const lead = this.#deps.client.household.zones.get(zone.coordinator) ?? zone;
    const raw = await this.#browseRaw(lead.host, 'Q:0', offset);
    const entries: QueueEntry[] = raw.entries.map((entry, i) =>
      this.#queueEntry(entry, offset + i, lead.host),
    );

    const queue = this.#deps.store.snapshot().queues.find((q) => q.id === lead.uuid);

    return {
      kind: 'queuePage',
      queueId: playerId,
      entries,
      offset,
      total: raw.total || queue?.count || entries.length,
      current: queue?.index ?? null,
    };
  }

  #queueEntry(entry: DidlEntry, index: number, host: string): QueueEntry {
    return {
      /*
       * The DIDL object id — `Q:0/5` — NOT a position.
       *
       * Sonos removes a queue track by that id, and it stays correct while
       * other tracks move around it. A position would silently address the
       * wrong track the moment anything was reordered.
       */
      id: entry.id,
      name: entry.title,
      sub: subtitle(entry),
      art: this.#deps.art.register(artUrl(entry.artUri, host)),
      duration: entry.duration,
      index,
    };
  }

  /* ── Plumbing ──────────────────────────────────────────────────────────*/

  /** One page of one container, shaped for the panel. */
  async #page(objectId: string, offset: number): Promise<BrowseResult> {
    const host = this.#anyHost();
    const raw = await this.#browseRaw(host, objectId, offset);

    const items = raw.entries.map((entry) => this.#shape(entry, host));

    return {
      kind: 'list',
      items,
      offset,
      /*
       * Sonos reports a real total, so "is there another page" is a fact
       * rather than the guess that a full page implied more.
       */
      more: raw.total > offset + items.length,
    };
  }

  async #browseRaw(
    host: string,
    objectId: string,
    offset: number,
  ): Promise<{ entries: DidlEntry[]; total: number }> {
    try {
      const response = await this.#deps.client.call(host, 'ContentDirectory', 'Browse', {
        ObjectID: objectId,
        BrowseFlag: 'BrowseDirectChildren',
        Filter: '*',
        StartingIndex: offset,
        RequestedCount: BROWSE_PAGE,
        SortCriteria: '',
      });

      return {
        entries: parseDidlList(textOf(response, 'Result')),
        total: integer(textOf(response, 'TotalMatches')) ?? 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Browse of ${objectId} failed: ${message}`);
      throw new Error('Sonos could not answer that');
    }
  }

  /** A DIDL row → the four fields a list row draws. */
  #shape(entry: DidlEntry, host: string): MediaItem {
    const item: MediaItem = {
      /*
       * The KEY, not the URI. The panel never holds something a speaker would
       * fetch — see uris.ts for why that is the whole design rather than a
       * tidiness preference.
       *
       * Containers are registered under their object id, because that is what
       * both Browse and AddURIToQueue want for them.
       */
      u: this.#deps.uris.register(entry.res ?? entry.id, entry.resMD, entry.upnpClass) ?? '',
      n: entry.title,
      k: kindOf(entry.upnpClass),
    };

    const sub = subtitle(entry);
    if (sub) item.s = sub;

    const art = this.#deps.art.register(artUrl(entry.artUri, host));
    if (art) item.a = art;

    return item;
  }

  /** Any reachable speaker. The library is the household's, not a speaker's. */
  #anyHost(): string {
    const zones = [...this.#deps.client.household.zones.values()];
    const host = zones[0]?.host;
    if (!host) throw new Error('No Sonos speakers are available');
    return host;
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────────*/

/**
 * `upnp:class` → the kind the panel draws.
 *
 * Checked longest-first: `object.container.album.musicAlbum` contains both
 * "album" and "container", and matching the wrong one turns every album into
 * a playlist.
 */
export function kindOf(upnpClass: string): MediaKind {
  if (upnpClass.includes('musicAlbum')) return 'album';
  if (upnpClass.includes('musicArtist')) return 'artist';
  if (upnpClass.includes('audioBroadcast')) return 'radio';
  if (upnpClass.includes('playlistContainer')) return 'playlist';
  if (upnpClass.includes('musicTrack') || upnpClass.includes('audioItem')) return 'track';
  // A favourite can be a container of anything; treating an unknown one as a
  // playlist means the panel offers to open it, which is the safer guess.
  return upnpClass.includes('container') ? 'playlist' : 'track';
}

/** "Artist · Album" for a track, "Artist" for an album, nothing for the rest. */
function subtitle(entry: DidlEntry): string | null {
  const parts = [entry.creator, entry.album].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  // A track on its own album repeats itself otherwise.
  const unique = [...new Set(parts)];
  return unique.length > 0 ? unique.join(' · ') : null;
}

function clamp(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return Math.min(Math.max(0, Math.floor(raw)), 1_000_000);
}
