import { logger } from '~/lib/log.ts';
import { artUrl, effectiveClass, parseDidlList, type DidlEntry } from '~/sonos/didl.ts';
import { integer, SoapError } from '~/sonos/soap.ts';
import { textOf } from '~/sonos/xml.ts';
import type { SonosClient } from '~/sonos/client.ts';
import type { SonosStore } from '~/sonos/store.ts';
import type { UriRegistry } from '~/sonos/uris.ts';
import type { SpotifySearch } from '~/sonos/spotify.ts';
import { NeedsLink } from '~/sonos/music.ts';
import type { MusicServices } from '~/sonos/music.ts';
import type { SmapiItem } from '~/sonos/smapi.ts';
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
  music: MusicServices;
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
      case 'service':
        return this.#service(req.sid, req.id ?? 'root', clamp(req.offset));
      case 'sources':
        return this.#sources();
      case 'catalog':
        return this.#catalog();
    }
  }

  /**
   * Everywhere this household's music comes from.
   *
   * The top of the browser. Built from what the household ACTUALLY has rather
   * than from a fixed list of tabs: a house with no NAS share is not offered
   * Albums, and a house with Plex finds Plex here rather than behind a tab
   * called "Services".
   *
   * Provider accounts are intentionally absent. Sonos does not share their
   * credentials with another controller; the supported bridge is the saved
   * content below, whose DIDL already carries what the speakers need to play.
   *
   * Each local source is checked for emptiness first — one `Browse` asking for
   * a single row, which answers with the real `TotalMatches` — so the count in
   * the subtitle is a fact and an empty source can be left out entirely
   * instead of being a row that leads nowhere.
   */
  async #sources(): Promise<BrowseResult> {
    const music = this.#deps.music;
    const host = this.#anyHost();

    // Service discovery is still warmed here because favourites carry service
    // ids that the playback path needs. The browse root itself deliberately
    // exposes only content the household has already saved in Sonos.
    const [, counts] = await Promise.all([music.ready(), this.#counts(host)]);

    const items: MediaItem[] = [];

    const local = (objectId: string, name: string, kind: MediaKind): void => {
      const total = counts.get(objectId) ?? 0;
      if (total === 0) return;
      const key = this.#deps.uris.register(null, objectId, '', 'object.container');
      if (!key) return;
      items.push({
        u: key,
        n: name,
        k: kind,
        s: `${total} ${total === 1 ? 'item' : 'items'}`,
        // A place, not a record: no play button, and no "Play all" inside it.
        o: true,
      });
    };

    // Favourites first, always: it is what anybody reaches for, it holds
    // things from every service, and it needs no login on this side.
    local(LIBRARY['favorites'] as string, 'Favourites', 'playlist');
    local(LIBRARY['playlists'] as string, 'Sonos Playlists', 'playlist');

    local(LIBRARY['radio'] as string, 'Radio Stations', 'radio');
    /*
     * `A:` is the library's own root and answers with its categories —
     * Artists, Albums, Genres, Composers, Tracks. Browsing it rather than
     * listing four object ids here means the categories are whatever this
     * household's share actually has.
     */
    local('A:', 'Music Library', 'playlist');

    return {
      kind: 'list',
      items,
      offset: 0,
      more: false,
      note:
        'This is your Sonos household. Music saved here uses the service accounts ' +
        'already connected in the Sonos app; add favourites or playlists there and they appear here.',
    };
  }

  /**
   * Every service Sonos knows about, minus the ones already offered.
   *
   * Detection reads the household and can only find what the household has
   * left a trace of. A service somebody set up in the Sonos app but has never
   * favourited, never saved a station from, and whose account list the
   * firmware does not serve, leaves no trace at all — and would otherwise be
   * permanently unreachable here.
   *
   * Deliberately not merged into the source list: it is hundreds of rows, and
   * putting them on the screen everybody uses is what "a ton of lists I can't
   * make sense of" was.
   */
  async #catalog(): Promise<BrowseResult> {
    const music = this.#deps.music;
    await music.ready();

    const already = new Set(music.list().map((s) => s.sid));
    const items = music
      .all()
      .filter((s) => !already.has(s.sid))
      .map((service): MediaItem => ({
        u: this.#deps.uris.register(null, 'root', '', 'object.container', service.sid) ?? '',
        n: service.name,
        k: 'playlist',
        sid: service.sid,
        o: true,
      }));

    return {
      kind: 'list',
      items,
      offset: 0,
      more: false,
      ...(items.length === 0
        ? { note: 'Every service this household knows about is already listed.' }
        : {}),
    };
  }

  /**
   * How many items each local source holds.
   *
   * One `Browse` apiece asking for a single row: Sonos answers with the real
   * `TotalMatches` regardless, so this costs almost nothing and turns "show a
   * row that leads to an empty screen" into "do not show that row".
   *
   * A source that errors counts as zero. On this screen the difference between
   * "empty" and "unreachable" is not worth a row that cannot be opened.
   */
  async #counts(host: string): Promise<Map<string, number>> {
    const wanted = [LIBRARY['favorites'], LIBRARY['playlists'], LIBRARY['radio'], 'A:'];
    const out = new Map<string, number>();

    await Promise.all(
      wanted.map(async (objectId) => {
        if (!objectId) return;
        try {
          const response = await this.#deps.client.call(host, 'ContentDirectory', 'Browse', {
            ObjectID: objectId,
            BrowseFlag: 'BrowseDirectChildren',
            Filter: '*',
            StartingIndex: 0,
            RequestedCount: 1,
            SortCriteria: '',
          });
          out.set(objectId, integer(textOf(response, 'TotalMatches')) ?? 0);
        } catch {
          out.set(objectId, 0);
        }
      }),
    );

    return out;
  }

  /* ── Music services ────────────────────────────────────────────────────*/

  /**
   * One page of a service's own tree — Sonos Radio, Plex, SoundCloud.
   *
   * The rows come back as the service's own shape and are turned into exactly
   * the same `MediaItem` a local browse produces, so the panel draws a Plex
   * album and a NAS album with one component and neither knows the difference.
   */
  async #service(sid: number, id: string, offset: number): Promise<BrowseResult> {
    const music = this.#deps.music;
    await music.ready();

    const service = music.get(sid);
    if (!service) throw new Error('That service is not available here');
    music.select(sid);

    let rows;
    try {
      rows = await music.browse(sid, id, offset);
    } catch (err) {
      // Not an error to report, an action to offer.
      if (err instanceof NeedsLink) return needsLink(err);
      throw err;
    }

    const items = rows.map((row) => this.#shapeService(row, sid));

    /*
     * An empty service page needs the same honesty as an empty container, and
     * one extra offer.
     *
     * A service can answer politely with nothing when it does not really
     * consider us logged in — its catalog entry says `Anonymous`, it accepts
     * the call, and it returns an empty root rather than a fault. Sonos Radio
     * does this. Offering to connect turns a blank screen into the one action
     * that might fix it.
     */
    const linkable =
      items.length === 0 && !music.linked(sid)
        ? { connect: sid, note: `${service.name} returned nothing. It may need connecting.` }
        : items.length === 0
          ? { note: `${service.name} returned nothing here.` }
          : {};

    return {
      kind: 'list',
      items,
      offset,
      /*
       * A service reports a total that is often a guess, and several report
       * none at all. A full page is the honest signal that there may be more —
       * unlike the local library, where Sonos's own count is exact.
       */
      more: rows.length >= BROWSE_PAGE,
      ...linkable,
    };
  }

  /** A service catalog row → the four fields a list row draws. */
  #shapeService(row: SmapiItem, sid: number): MediaItem {
    const playable = this.#deps.music.playable(sid, row);

    const item: MediaItem = {
      /*
       * A container is registered under BOTH its playable URI and the
       * service's own id: the first plays it, the second opens it. That is the
       * same split as a favourite, for the same reason.
       */
      u:
        row.canPlay && playable
          ? (this.#deps.uris.register(
              playable.uri,
              row.id,
              playable.metadata,
              playable.upnpClass,
              sid,
            ) ?? '')
          : (this.#deps.uris.register(null, row.id, '', 'object.container', sid) ?? ''),
      n: row.title,
      k: kindOf(playable?.upnpClass ?? 'object.container'),
      // The service said this row cannot be played on its own.
      ...(row.canPlay && playable ? {} : { o: true as const }),
    };

    const sub = [row.artist, row.album].filter((p): p is string => !!p);
    const unique = [...new Set(sub)];
    if (unique.length > 0) item.s = unique.join(' · ');

    // Service artwork is a public URL rather than a path on a speaker, so it
    // goes through the same proxy as everything else and no further.
    const art = this.#deps.art.register(row.artUri);
    if (art) item.a = art;

    return item;
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

    if (typeof req.source === 'number') return this.#searchService(req.source, query);

    /*
     * Anything that is not `'library'` or a service id is refused rather than
     * quietly treated as the library. Falling through would answer a search of
     * a service the panel believes in with local results, which reads as "your
     * Plex has three albums" rather than as the mismatch it is.
     */
    if (req.source !== undefined && req.source !== 'library') {
      throw new Error('That is not a place this can search');
    }

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

    const groups = results.filter((g) => g.items.length > 0);
    if (groups.length > 0) return { kind: 'groups', groups };

    /*
     * A local search that finds nothing is usually a household with no local
     * library at all, not a household whose library lacks that word. Checking
     * costs one Browse and turns a blank screen into an answer.
     */
    const total = (await this.#counts(this.#anyHost())).get('A:') ?? 0;
    return {
      kind: 'list',
      items: [],
      offset: 0,
      more: false,
      note:
        total === 0
          ? 'There is no music library on this household to search. Search a music ' +
            'service instead, or add a share in the Sonos app.'
          : `Nothing in the library matches "${query}". Library search matches the ` +
            'start of a name rather than any part of it.',
    };
  }

  /**
   * Search one music service's catalog.
   *
   * Spotify has two possible backends and the better one wins: its Web API
   * returns richer results than SMAPI, but only if credentials happen to be
   * configured. When they are not — which is the common case, and needs no
   * setup at all — the service's own SMAPI search answers instead. One tab
   * either way; the panel is not told which was used.
   */
  async #searchService(sid: number, query: string): Promise<BrowseResult> {
    const music = this.#deps.music;
    await music.ready();

    const service = music.get(sid);
    if (this.#deps.spotify.enabled && service?.name === 'Spotify') {
      return this.#deps.spotify.search(query);
    }

    let groups;
    try {
      groups = await music.search(sid, query);
    } catch (err) {
      if (err instanceof NeedsLink) return needsLink(err);
      throw err;
    }

    if (groups.length === 0) {
      return {
        kind: 'list',
        items: [],
        offset: 0,
        more: false,
        note: `${service?.name ?? 'That service'} found nothing for "${query}".`,
      };
    }

    return {
      kind: 'groups',
      groups: groups.map((group) => ({
        name: group.name,
        items: group.items.map((row) => this.#shapeService(row, sid)),
      })),
    };
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

    /*
     * The OBJECT ID opens things; the URI plays them. A favourited playlist
     * carries both — `FV:2/12` and `x-rincon-cpcontainer:100…` — and Browsing
     * the second returns an empty list rather than an error, so preferring the
     * wrong one here is a tab that silently shows nothing.
     */
    const target = playable.objectId ?? playable.uri;
    if (!target) throw new Error('That item cannot be opened');

    // A service's ids mean nothing to a speaker: they are addresses inside
    // Plex or SoundCloud, and opening one is a call to that service.
    if (playable.sid !== null) return this.#service(playable.sid, target, offset);

    /*
     * The one synthetic address. Routed here rather than matched on its label
     * in the panel, so the row and what it opens stay one fact in one place.
     */
    if (target === 'catalog') return this.#catalog();

    return this.#page(target, offset);
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

    let raw: { entries: DidlEntry[]; total: number };
    try {
      raw = await this.#browseRaw(host, objectId, offset);
    } catch (err) {
      /*
       * A container this household does not have answers with a UPnP fault
       * rather than an empty list — `R:0/0` on a house that has never used
       * TuneIn, `A:ALBUM` with no share. The SPEAKER ANSWERED, so this is a
       * fact about the household and not a failure: it becomes the same empty
       * list, with the same explanation, as a container that exists and holds
       * nothing.
       *
       * A transport failure still throws. "Sonos could not answer that" is
       * the right thing to say when nothing answered at all.
       */
      if (!(err instanceof SoapError) || err.code === null) throw err;
      return { kind: 'list', items: [], offset, more: false, note: emptyNote(objectId) };
    }

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
      ...(items.length === 0 && offset === 0 ? { note: emptyNote(objectId) } : {}),
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
      /*
       * A UPnP fault is RETHROWN AS ITSELF so the caller can tell "this
       * household has no such container" from "nothing answered". Flattening
       * both into one sentence is what turned an ordinary empty shelf into
       * "Sonos could not answer that".
       */
      if (err instanceof SoapError && err.code !== null) throw err;
      throw new Error('Sonos could not answer that');
    }
  }

  /** A DIDL row → the four fields a list row draws. */
  #shape(entry: DidlEntry, host: string): MediaItem {
    /*
     * A favourite's own class describes the favouriting, not the favourite —
     * see `effectiveClass`. Reading the outer one draws every favourite with a
     * track icon and, worse, plays it down the wrong path.
     */
    const cls = effectiveClass(entry);

    const item: MediaItem = {
      /*
       * The KEY, not the URI. The panel never holds something a speaker would
       * fetch — see uris.ts for why that is the whole design rather than a
       * tidiness preference.
       *
       * Both halves are registered: the URI is what plays, the object id is
       * what opens. A favourited playlist has both and they are not
       * interchangeable.
       */
      u: this.#deps.uris.register(entry.res, entry.id, entry.resMD, cls) ?? '',
      n: entry.title,
      k: kindOf(cls),
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
  if (upnpClass.includes('podcast')) return 'podcast';
  if (upnpClass.includes('audioBook')) return 'audiobook';
  if (upnpClass.includes('playlistContainer')) return 'playlist';
  if (upnpClass.includes('musicTrack') || upnpClass.includes('audioItem')) return 'track';
  // A favourite can be a container of anything; treating an unknown one as a
  // playlist means the panel offers to open it, which is the safer guess.
  return upnpClass.includes('container') ? 'playlist' : 'track';
}

/** An empty page that offers to connect the service that refused it. */
function needsLink(err: NeedsLink): BrowseResult {
  return {
    kind: 'list',
    items: [],
    offset: 0,
    more: false,
    connect: err.sid,
    note: err.message,
  };
}

/**
 * Why a container came back empty.
 *
 * Every one of these is a household that is working correctly and simply does
 * not have the thing — no NAS share, no saved stations, nothing favourited
 * yet. On a wall panel that is indistinguishable from a broken integration
 * unless it is said out loud, which is the entire reason these strings exist.
 */
function emptyNote(objectId: string): string {
  if (objectId.startsWith('A:')) {
    return (
      'Nothing here. This is the music library on a NAS or computer share — ' +
      'add one under Settings → System → Music Library in the Sonos app.'
    );
  }
  if (objectId.startsWith('R:')) {
    return 'No saved radio stations. Star one in the Sonos app and it will appear here.';
  }
  if (objectId.startsWith('SQ:')) {
    return 'No Sonos playlists yet. Save a queue as a playlist in the Sonos app.';
  }
  if (objectId.startsWith('FV:')) {
    return 'Nothing favourited yet. Anything you star in the Sonos app shows up here.';
  }
  return 'Nothing here.';
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
