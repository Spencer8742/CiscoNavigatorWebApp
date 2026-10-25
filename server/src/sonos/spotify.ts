import { logger } from '~/lib/log.ts';
import { escapeXml, textOf } from '~/sonos/xml.ts';
import type { SonosClient } from '~/sonos/client.ts';
import type { UriRegistry } from '~/sonos/uris.ts';
import type { MediaArt } from '~/http/media-art.ts';
import type { Env } from '~/env.ts';
import type { MusicServices } from '~/sonos/music.ts';
import { BROWSE_PAGE } from '@shared/protocol.ts';
import type { BrowseResult, MediaItem, MediaKind } from '@shared/protocol.ts';
import type { PlayStyle } from '~/sonos/uris.ts';

const log = logger('sonos-spotify');

/**
 * Searching Spotify, and playing the result on Sonos.
 *
 * The split matters and is the whole reason this is short:
 *
 *  - **Search** goes to Spotify's Web API with a client-credentials token —
 *    server to server, no user login, no redirect, no access to anybody's
 *    account. It reads the public catalog and nothing else.
 *  - **Playback** goes to the speaker as a `x-sonos-spotify:` URI, played
 *    through **your household's own linked Spotify account**. These
 *    credentials never touch it.
 *
 * `docs/SONOS.md` §8 weighs this against the alternative, which is the SMAPI
 * device-link handshake — the proper route, and one that needs a person to
 * approve a URL in a browser on a device that has one tab and cannot open
 * another. This delivers the same capability in a fraction of the time and
 * shares its playback path, so nothing is thrown away if SMAPI follows.
 *
 * ## The two numbers
 *
 * A Sonos Spotify URI carries `sid` (which music service) and `sn` (which
 * linked account). Both belong to the household, not to us, and getting
 * either wrong produces a speaker that accepts the command and plays silence.
 *
 * So they are **learned from the household itself**: any existing Spotify item
 * in your favourites is a URI Sonos built, carrying the right values. Failing
 * that, `ListAvailableServices` gives the service id and `sn` falls back to 1.
 * Learned values are cached for the life of the process.
 */

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
/** The page behind Spotify's "Embed playlist" widget. See `#embedded`. */
const EMBED_URL = 'https://open.spotify.com/embed/playlist';
const SEARCH_URL = `${API}/search`;

/** Spotify Development Mode reduced the search maximum to 10 in February 2026. */
const LIMIT = 10;

const TIMEOUT_MS = 10_000;

type SpotifyKind = 'track' | 'album' | 'artist' | 'playlist' | 'show' | 'episode';

/** Refresh a little before expiry rather than after a failure. */
const TOKEN_SKEW_MS = 60_000;

/**
 * Sonos's flag word for a Spotify item.
 *
 * Opaque, and copied from what the Sonos app itself sends. It encodes how the
 * item should be treated (queueable, seekable); the value below is the one
 * every local controller uses for tracks, albums and playlists alike.
 */
const FLAGS = 8224;

interface Account {
  /** Music service id, as it appears in a URI. */
  sid: number;
  /** Which linked account of that service. */
  sn: number;
}

export class SpotifySearch {
  readonly #env: Env['spotify'];
  readonly #client: SonosClient;
  readonly #uris: UriRegistry;
  readonly #art: MediaArt;
  readonly #services: MusicServices;

  #token: string | null = null;
  #tokenExpires = 0;
  #account: Account | null = null;
  /**
   * Rows asked for per call when opening something. Spotify's own maximum is
   * 50; Development Mode has been cutting maximums without notice (search to
   * 10 in February 2026), so a refused limit drops this to `LIMIT` for the
   * life of the process instead of failing every open.
   */
  #chunk = 50;

  constructor(
    env: Env['spotify'],
    client: SonosClient,
    uris: UriRegistry,
    art: MediaArt,
    services: MusicServices,
  ) {
    this.#env = env;
    this.#client = client;
    this.#uris = uris;
    this.#art = art;
    this.#services = services;
  }

  get enabled(): boolean {
    return this.#env.enabled;
  }

  /**
   * Search the catalog.
   *
   * Throws with something worth reading on a wall panel — an unconfigured
   * integration and a rejected key need different things done about them and
   * are indistinguishable as an empty list.
   */
  async search(query: string): Promise<BrowseResult> {
    if (!this.#env.enabled) {
      throw new Error(
        'Spotify search is not set up. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET ' +
          'from a free app at developer.spotify.com — they are used for search only.',
      );
    }

    const account = await this.#resolveAccount();
    if (!account) {
      throw new Error(
        'No Spotify account is linked in Sonos. Add Spotify in the Sonos app, then ' +
          'favourite one thing from it so the panel can learn the account.',
      );
    }

    const token = await this.#accessToken();
    const url =
      `${SEARCH_URL}?q=${encodeURIComponent(query)}` +
      `&type=track,album,artist,playlist,show,episode&limit=${LIMIT}` +
      `&market=${encodeURIComponent(this.#env.market)}`;

    const body = await this.#get(url, 'Spotify search failed', token);

    const groups = [
      { name: 'Songs', items: this.#shapeAll(body, 'tracks', 'track', account) },
      { name: 'Albums', items: this.#shapeAll(body, 'albums', 'album', account) },
      { name: 'Artists', items: this.#shapeAll(body, 'artists', 'artist', account) },
      { name: 'Playlists', items: this.#shapeAll(body, 'playlists', 'playlist', account) },
      { name: 'Podcast shows', items: this.#shapeAll(body, 'shows', 'podcast', account, 'show') },
      { name: 'Podcast episodes', items: this.#shapeAll(body, 'episodes', 'podcast', account, 'episode') },
    ];

    return { kind: 'groups', groups: groups.filter((g) => g.items.length > 0) };
  }

  /**
   * What is on a Spotify album, playlist, artist or podcast that search
   * returned — so the panel can open it, not only play it.
   *
   * Null when `playUri` is not a Spotify container this can read, so the
   * caller can fall through to Sonos's own browse. Reads the same public
   * catalog as search, with the same client-credentials token: still nothing
   * of anybody's account.
   */
  async contents(playUri: string, offset: number): Promise<BrowseResult | null> {
    const ref = spotifyRef(playUri);
    if (!ref || !this.#env.enabled) return null;

    const account = await this.#resolveAccount();
    if (!account) throw new Error('No Spotify account is linked in Sonos.');

    const market = `market=${encodeURIComponent(this.#env.market)}`;
    const id = encodeURIComponent(ref.id);

    switch (ref.kind) {
      case 'album': {
        // Album tracks carry no artwork of their own; the album's goes on
        // every row, which is also what tells the panel to list them rather
        // than flow fourteen copies of one cover.
        const album = await this.#get(`${API}/albums/${id}?${market}`, 'Spotify could not open that album');
        const art = imageOf(album);
        const page = await this.#collect(`${API}/albums/${id}/tracks?${market}`, offset, 'Spotify could not list that album');
        return this.#list(page, offset, (raw) => this.#shape(raw, 'track', account, 'track', art));
      }

      case 'artist': {
        const page = await this.#collect(
          `${API}/artists/${id}/albums?include_groups=album,single,compilation&${market}`,
          offset,
          'Spotify could not list that artist',
        );
        return this.#list(page, offset, (raw) => this.#shape(raw, 'album', account, 'album'));
      }

      case 'show': {
        const page = await this.#collect(`${API}/shows/${id}/episodes?${market}`, offset, 'Spotify could not list that podcast');
        return this.#list(page, offset, (raw) => this.#shape(raw, 'podcast', account, 'episode'));
      }

      case 'playlist': {
        let page: { items: unknown[]; more: boolean };
        try {
          page = await this.#collect(`${API}/playlists/${id}/tracks?${market}`, offset, 'Spotify could not list that playlist');
        } catch (err) {
          /*
           * The Web API no longer lists a playlist for an app like this one:
           * Spotify's own playlists have been withheld since November 2024,
           * and since February 2026 Development Mode lists only playlists
           * the signed-in user owns — and this app signs nobody in. The
           * embed widget's page still carries the list, so that is asked
           * next; if it fails too, the playlist still plays.
           */
          if (/HTTP (403|404)/.test(err instanceof Error ? err.message : '')) {
            const embedded = await this.#embedded(ref.id, offset, account).catch((e: unknown) => {
              log.warn(`Spotify embed for playlist ${ref.id} failed: ${e instanceof Error ? e.message : e}`);
              return null;
            });
            if (embedded) return embedded;
            return {
              kind: 'list',
              items: [],
              offset,
              more: false,
              note: 'Spotify does not share the tracks of this playlist with other apps. Play still works.',
            };
          }
          throw err;
        }
        return this.#list(page, offset, (raw) => {
          // Playlist rows wrap the track, and may be an episode, a removed
          // track (null) or a local file Sonos cannot reach.
          const entry = isObject(raw) ? raw['track'] : null;
          if (!isObject(entry) || entry['is_local'] === true) return null;
          return entry['type'] === 'episode'
            ? this.#shape(entry, 'podcast', account, 'episode')
            : this.#shape(entry, 'track', account, 'track');
        });
      }
    }
  }

  /**
   * A playlist's tracks, read from the page Spotify serves for its embed
   * widget — public, unauthenticated, and the same list anybody sees when a
   * playlist is embedded in a web page.
   *
   * Not a documented API, so it is the fallback rather than the route, and
   * anything unexpected in it is a null rather than an error. It carries at
   * most the first 100 tracks and no per-track artwork; the playlist's cover
   * goes on each row instead.
   */
  async #embedded(id: string, offset: number, account: Account): Promise<BrowseResult | null> {
    const response = await this.#fetch(`${EMBED_URL}/${encodeURIComponent(id)}`, {
      headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html' },
    });
    if (!response.ok) return null;
    const parsed = parseEmbed(await response.text());
    if (!parsed || parsed.tracks.length === 0) return null;

    const rows = parsed.tracks.slice(offset, offset + BROWSE_PAGE);
    const items: MediaItem[] = [];
    for (const t of rows) {
      const spotifyKind = t.kind === 'episode' ? 'episode' : 'track';
      const item = this.#shape(
        { id: t.uri.split(':').pop(), name: t.title, uri: t.uri, artists: t.subtitle ? [{ name: t.subtitle }] : [] },
        spotifyKind === 'episode' ? 'podcast' : 'track',
        account,
        spotifyKind,
        parsed.art,
      );
      if (item) items.push(item);
    }

    const more = offset + BROWSE_PAGE < parsed.tracks.length;
    return {
      kind: 'list',
      items,
      offset,
      more,
      ...(!more && parsed.tracks.length >= EMBED_MAX
        ? { note: `Spotify shares only the first ${EMBED_MAX} tracks of this playlist. Play still plays all of it.` }
        : {}),
    };
  }

  /**
   * One panel page of a Spotify listing, in as many calls as it takes.
   *
   * The panel pages by `BROWSE_PAGE` items and Spotify by at most 50, so a
   * page that asked Spotify for one 50 would skip ten rows on every "More".
   */
  async #collect(base: string, offset: number, what: string): Promise<{ items: unknown[]; more: boolean }> {
    const items: unknown[] = [];
    let at = offset;
    let more = false;

    while (items.length < BROWSE_PAGE) {
      const want = Math.min(this.#chunk, BROWSE_PAGE - items.length);
      let body: Record<string, unknown>;
      try {
        body = await this.#get(`${base}&limit=${want}&offset=${at}`, what);
      } catch (err) {
        if (this.#chunk > LIMIT && /HTTP 400/.test(err instanceof Error ? err.message : '')) {
          this.#chunk = LIMIT;
          continue;
        }
        throw err;
      }
      const list = Array.isArray(body['items']) ? (body['items'] as unknown[]) : [];
      items.push(...list);
      at += list.length;
      more = typeof body['next'] === 'string' && list.length > 0;
      if (!more) break;
    }

    return { items, more };
  }

  #list(
    page: { items: unknown[]; more: boolean },
    offset: number,
    shape: (raw: unknown) => MediaItem | null,
  ): BrowseResult {
    const items: MediaItem[] = [];
    for (const raw of page.items) {
      const item = shape(raw);
      if (item) items.push(item);
    }
    return { kind: 'list', items, offset, more: page.more };
  }

  /* ── Spotify's API ─────────────────────────────────────────────────────*/

  async #accessToken(): Promise<string> {
    if (this.#token && Date.now() < this.#tokenExpires - TOKEN_SKEW_MS) return this.#token;

    const basic = Buffer.from(`${this.#env.clientId}:${this.#env.clientSecret}`).toString('base64');

    const response = await this.#fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      // 400 here is almost always a wrong id or secret, and saying so beats
      // "search failed" on a device nobody will read logs for.
      throw new Error(
        response.status === 400 || response.status === 401
          ? 'Spotify rejected SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET.'
          : `Spotify would not issue a token (HTTP ${response.status}).`,
      );
    }

    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (typeof body.access_token !== 'string') {
      throw new Error('Spotify returned no access token');
    }

    this.#token = body.access_token;
    this.#tokenExpires = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.#token;
  }

  async #get(url: string, what: string, given?: string): Promise<Record<string, unknown>> {
    const token = given ?? (await this.#accessToken());
    const response = await this.#fetch(url, { headers: { authorization: `Bearer ${token}` } });

    if (response.status === 401) {
      // The token expired earlier than advertised. One retry, with a fresh one.
      this.#token = null;
      const fresh = await this.#accessToken();
      const retry = await this.#fetch(url, { headers: { authorization: `Bearer ${fresh}` } });
      if (!retry.ok) throw new Error(await spotifyFailure(retry, what));
      return (await retry.json()) as Record<string, unknown>;
    }

    if (!response.ok) throw new Error(await spotifyFailure(response, what));
    return (await response.json()) as Record<string, unknown>;
  }

  async #fetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      throw new Error(
        controller.signal.aborted
          ? 'Spotify did not answer in time'
          : `Could not reach Spotify (${err instanceof Error ? err.message : 'unknown'})`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /* ── Shaping ───────────────────────────────────────────────────────────*/

  #shapeAll(
    body: Record<string, unknown>,
    section: string,
    kind: MediaKind,
    account: Account,
    spotifyKind: SpotifyKind = kind as SpotifyKind,
  ): MediaItem[] {
    const container = body[section];
    const list = isObject(container) ? container['items'] : null;
    if (!Array.isArray(list)) return [];

    const out: MediaItem[] = [];
    for (const raw of list) {
      const shaped = this.#shape(raw, kind, account, spotifyKind);
      if (shaped) out.push(shaped);
    }
    return out;
  }

  #shape(
    raw: unknown,
    kind: MediaKind,
    account: Account,
    spotifyKind: SpotifyKind,
    /** Artwork for a row that carries none of its own: an album's tracks. */
    fallbackArt: string | null = null,
  ): MediaItem | null {
    if (!isObject(raw)) return null;

    const name = typeof raw['name'] === 'string' ? raw['name'] : null;
    const id = typeof raw['id'] === 'string' ? raw['id'] : null;
    if (!name || !id) return null;

    const spotifyUri = typeof raw['uri'] === 'string' ? raw['uri'] : `spotify:${spotifyKind}:${id}`;
    const { uri, metadata, playStyle } = sonosUri(spotifyUri, name, spotifyKind, account);

    const item: MediaItem = {
      // The class goes with it so the registry knows an album is a container:
      // the URI scheme alone would say so too, but only for the kinds that
      // have a prefix, and the class is what keeps the two in step.
      u:
        this.#uris.register(
          uri,
          null,
          metadata,
          UPNP_CLASS[spotifyKind] ?? '',
          account.sid,
          playStyle,
        ) ?? '',
      n: name,
      k: kind,
      // An episode is one thing to play, whatever kind it is filed under.
      // Albums, artists, playlists and shows open through `contents()`.
      ...(spotifyKind === 'episode' ? { b: false as const } : {}),
    };

    const sub = subtitleOf(raw, spotifyKind);
    if (sub) item.s = sub;

    const art = this.#art.register(imageOf(raw) ?? fallbackArt);
    if (art) item.a = art;

    return item;
  }

  /* ── Which service, which account ──────────────────────────────────────*/

  /**
   * Work out the household's Spotify `sid` and `sn`.
   *
   * Preferring an existing favourite over `ListAvailableServices` is
   * deliberate: a URI Sonos itself built is ground truth, where the service
   * list gives an id that still leaves the account number to guess.
   */
  async #resolveAccount(): Promise<Account | null> {
    if (this.#account) return this.#account;

    // The shared service catalog reads `/status/accounts`, which is the only
    // reliable source of the account serial when a household has no Spotify
    // favourite (or has more than one Spotify login). Use it before the older
    // URI/service-list fallbacks kept for firmware without that endpoint.
    await this.#services.ready();
    const linked = this.#services
      .list()
      .find((service) => service.name.toLowerCase() === 'spotify' && service.sn !== null);
    const learned = linked?.sn !== null && linked?.sn !== undefined
      ? { sid: linked.sid, sn: linked.sn }
      : (await this.#learnFromFavourites()) ?? (await this.#learnFromServices());
    if (learned) {
      log.info(`Sonos Spotify account: sid=${learned.sid}, sn=${learned.sn}`);
      this.#account = learned;
    }
    return learned;
  }

  /** Lift `sid` and `sn` out of any Spotify URI the household already holds. */
  async #learnFromFavourites(): Promise<Account | null> {
    const host = [...this.#client.household.zones.values()][0]?.host;
    if (!host) return null;

    for (const objectId of ['FV:2', 'SQ:', 'Q:0']) {
      try {
        const response = await this.#client.call(host, 'ContentDirectory', 'Browse', {
          ObjectID: objectId,
          BrowseFlag: 'BrowseDirectChildren',
          Filter: '*',
          StartingIndex: 0,
          RequestedCount: 100,
          SortCriteria: '',
        });

        const found = accountFromUris(JSON.stringify(response));
        if (found) return found;
      } catch {
        // A household with no favourites, or a speaker that declined. Try the
        // next container rather than giving up on the whole feature.
      }
    }
    return null;
  }

  /** Fall back to the service list, which gives an id but no account number. */
  async #learnFromServices(): Promise<Account | null> {
    const host = [...this.#client.household.zones.values()][0]?.host;
    if (!host) return null;

    try {
      const response = await this.#client.call(host, 'MusicServices', 'ListAvailableServices');

      /*
       * The service list is a `<Service Id="9" Name="Spotify" …/>` attribute,
       * and the id comes BEFORE the name on a real speaker.
       *
       * This used to stringify the parsed node to JSON and look for
       * `"Name": "Spotify"` followed by `"Id"` — a pattern that cannot occur
       * in either the XML or its JSON form, in either order. It never matched,
       * so this fallback has never once returned an account.
       */
      const list = textOf(response, 'AvailableServiceDescriptorList') ?? '';
      const match = /<Service\b[^>]*\bId="(\d+)"[^>]*\bName="Spotify"/.exec(list);
      const sid = match?.[1] ? Number.parseInt(match[1], 10) : NaN;
      if (!Number.isFinite(sid)) return null;

      // One linked account is overwhelmingly the common case, and a wrong
      // guess here is visible immediately rather than silently.
      return { sid, sn: 1 };
    } catch {
      return null;
    }
  }
}

/** Keep Spotify's useful explanation instead of reducing every refusal to a status code. */
async function spotifyFailure(response: Response, prefix: string): Promise<string> {
  let detail = '';
  try {
    const body: unknown = await response.json();
    if (isObject(body)) {
      const error = body['error'];
      if (typeof error === 'string') detail = error;
      else if (isObject(error) && typeof error['message'] === 'string') detail = error['message'];
    }
  } catch {
    // Some proxy and outage responses are HTML. The status remains actionable.
  }
  return detail
    ? `${prefix} (HTTP ${response.status}): ${detail}`
    : `${prefix} (HTTP ${response.status})`;
}

/* ── URI construction ────────────────────────────────────────────────────*/

/**
 * A Spotify URI, as Sonos wants it.
 *
 *   track  x-sonos-spotify:spotify%3atrack%3a<id>?sid=9&flags=8224&sn=3
 *   album  x-rincon-cpcontainer:1004206cspotify%3aalbum%3a<id>?sid=9&…
 *
 * **A track and a container are not the same URI shape**, and that is the
 * whole reason this returns a scheme rather than always the first line. An
 * album addressed as `x-sonos-spotify:` is accepted by `SetAVTransportURI` and
 * then plays nothing, because there is no single stream behind it.
 *
 * The eight-digit prefix on a container is Sonos's own type tag. It looks like
 * a magic number because it is one: a wire format, not a design.
 *
 * The DIDL alongside is not optional either. Sonos needs the `<desc>` element
 * naming the service to know which account to play through, and an item sent
 * without it is accepted and plays silence — the most confusing failure in
 * this whole integration.
 */
export function sonosUri(
  spotifyUri: string,
  title: string,
  kind: SpotifyKind,
  account: Account,
): { uri: string; metadata: string; playStyle: PlayStyle } {
  // Sonos writes the colon escapes in this identifier in lower case. URI
  // escapes are equivalent by spec, but several speaker generations compare
  // the service object id literally while resolving it.
  const encoded = encodeURIComponent(spotifyUri).replace(/%3A/g, '%3a');
  const prefix = CONTAINER_URI_PREFIX[kind];

  const uri = prefix
    ? `x-rincon-cpcontainer:${prefix}${encoded}?sid=${account.sid}&flags=${CONTAINER_FLAGS}&sn=${account.sn}`
    : `x-sonos-spotify:${encoded}?sid=${account.sid}&flags=${FLAGS}&sn=${account.sn}`;

  const metadata = serviceDidl({
    id: `${ITEM_ID_PREFIX[kind] ?? ITEM_ID_PREFIX.track}${encoded}`,
    title,
    upnpClass: UPNP_CLASS[kind] ?? UPNP_CLASS['track'] ?? '',
    sid: account.sid,
  });

  // Spotify share links, including albums and playlists, are expanded by
  // AddURIToQueue. Sending a collection directly to SetAVTransportURI is the
  // command path that produces UPnP 701 on real speakers.
  return { uri, metadata, playStyle: 'track' };
}

/**
 * Sonos's type tag for each kind of container, which rides in front of the
 * service's own id inside an `x-rincon-cpcontainer:` URI.
 *
 * A kind absent from this table is an item rather than a container, and takes
 * the track URI shape instead.
 */
const CONTAINER_URI_PREFIX: Partial<Record<SpotifyKind, string>> = {
  album: '1004206c',
  playlist: '1006206c',
  artist: '1005004c',
  show: '1006206c',
};

/** DIDL ids use a different prefix from the transport URI. */
const ITEM_ID_PREFIX: Partial<Record<SpotifyKind, string>> = {
  track: '00032020',
  album: '00040000',
  playlist: '1006206c',
  artist: '1005004c',
  show: '1006206c',
  episode: '00032020',
};

/** Containers and items are flagged differently. Both are Sonos's values. */
const CONTAINER_FLAGS = 8300;

const UPNP_CLASS: Partial<Record<SpotifyKind, string>> = {
  track: 'object.item.audioItem.musicTrack',
  album: 'object.container.album.musicAlbum',
  artist: 'object.container.person.musicArtist',
  playlist: 'object.container.playlistContainer',
  show: 'object.container.playlistContainer',
  episode: 'object.item.audioItem.musicTrack',
};

/**
 * The DIDL a music-service item has to be handed back with.
 *
 * `serviceType = sid * 256 + 7` is Sonos's own relationship between a music
 * service's id and the token in its metadata descriptor — arbitrary-looking,
 * and load-bearing: it is how the speaker picks the account to play through.
 */
export function serviceDidl(item: {
  id: string;
  title: string;
  upnpClass: string;
  sid: number;
  parentId?: string;
}): string {
  const serviceType = item.sid * 256 + 7;
  return (
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" ' +
    'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
    `<item id="${escapeXml(item.id)}" parentID="${escapeXml(item.parentId ?? '-1')}" restricted="true">` +
    `<dc:title>${escapeXml(item.title)}</dc:title>` +
    `<upnp:class>${item.upnpClass}</upnp:class>` +
    '<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">' +
    `SA_RINCON${serviceType}_X_#Svc${serviceType}-0-Token</desc>` +
    '</item></DIDL-Lite>'
  );
}

/** Find a `sid`/`sn` pair in any Spotify URI inside a blob of response text. */
export function accountFromUris(text: string): Account | null {
  // `&amp;` survives one decode — Sonos escapes the URI's own `&` before it
  // escapes the DIDL around it. See `accountsFromUris` for what this cost.
  const flat = text.replace(/&amp;/g, '&');
  const match = /x-sonos-spotify:[^"'<\\\s]*[?&]sid=(\d+)[^"'<\\\s]*?[?&]sn=(\d+)/.exec(flat);
  if (!match?.[1] || !match[2]) return null;

  const sid = Number.parseInt(match[1], 10);
  const sn = Number.parseInt(match[2], 10);
  return Number.isFinite(sid) && Number.isFinite(sn) ? { sid, sn } : null;
}

/* ── Helpers ─────────────────────────────────────────────────────────────*/

function isObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null;
}

function subtitleOf(raw: Record<string, unknown>, kind: SpotifyKind): string | null {
  if (kind === 'artist') return null;

  const show = isObject(raw['show']) && typeof raw['show']['name'] === 'string'
    ? raw['show']['name']
    : null;
  const publisher = typeof raw['publisher'] === 'string' ? raw['publisher'] : null;

  const artists = Array.isArray(raw['artists'])
    ? raw['artists']
        .map((a) => (isObject(a) && typeof a['name'] === 'string' ? a['name'] : null))
        .filter((n): n is string => n !== null)
    : [];

  const album = isObject(raw['album']) && typeof raw['album']['name'] === 'string'
    ? raw['album']['name']
    : null;

  const parts = [
    artists.join(', '),
    kind === 'track' ? album : null,
    kind === 'episode' ? show : null,
    kind === 'show' ? publisher : null,
  ].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Which Spotify container a play URI points at, if it is one.
 *
 * Read back off the URI `sonosUri` built — `…cpcontainer:1004206cspotify%3a
 * album%3a<id>?…` — rather than from a table kept beside the key registry, so
 * a pinned or recent album still opens after the backend restarts.
 */
export function spotifyRef(
  playUri: string,
): { kind: 'album' | 'playlist' | 'artist' | 'show'; id: string } | null {
  if (!playUri.startsWith('x-rincon-cpcontainer:')) return null;
  const match = /spotify%3a(?:user%3a[^%?]+%3a)?(album|playlist|artist|show)%3a([A-Za-z0-9]+)/i.exec(playUri);
  if (!match?.[1] || !match[2]) return null;
  return { kind: match[1].toLowerCase() as 'album' | 'playlist' | 'artist' | 'show', id: match[2] };
}

/** The most tracks the embed page lists, however long the playlist. */
const EMBED_MAX = 100;

interface EmbedTrack {
  uri: string;
  title: string;
  subtitle: string;
  kind: 'track' | 'episode';
}

/**
 * The track list out of an embed page's `__NEXT_DATA__`.
 *
 * Shape as served in October 2026:
 * `props.pageProps.state.data.entity.{trackList[], coverArt.sources[]}`.
 * Null for anything else, so a change on Spotify's side degrades to the
 * "still plays" note instead of a broken card.
 */
export function parseEmbed(html: string): { tracks: EmbedTrack[]; art: string | null } | null {
  const match = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!match?.[1]) return null;

  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return null;
  }

  let entity: unknown = data;
  for (const key of ['props', 'pageProps', 'state', 'data', 'entity']) {
    entity = isObject(entity) ? entity[key] : null;
  }
  if (!isObject(entity) || !Array.isArray(entity['trackList'])) return null;

  const tracks: EmbedTrack[] = [];
  for (const raw of entity['trackList']) {
    if (!isObject(raw) || raw['isPlayable'] === false) continue;
    const uri = typeof raw['uri'] === 'string' ? raw['uri'] : '';
    const title = typeof raw['title'] === 'string' ? raw['title'] : '';
    const kind = /^spotify:episode:[A-Za-z0-9]+$/.test(uri) ? 'episode' : /^spotify:track:[A-Za-z0-9]+$/.test(uri) ? 'track' : null;
    if (!kind || !title) continue;
    tracks.push({ uri, title, subtitle: typeof raw['subtitle'] === 'string' ? raw['subtitle'] : '', kind });
  }

  const cover = isObject(entity['coverArt']) ? entity['coverArt']['sources'] : null;
  const art = Array.isArray(cover) ? imageOf({ images: cover }) : null;
  return { tracks, art };
}

/** Wide enough for a Cover Flow cover (about 20 rem) without being a poster. */
const ART_MIN_PX = 300;

/**
 * The smallest image that is still big enough.
 *
 * Spotify lists images largest-first, typically 640, 300 and 64 px. The 64
 * was enough for a list row and is a smear as a Cover Flow cover; the 640 is
 * four times the decoded memory of the 300 on a device that gets killed for
 * using too much (docs/ROOMOS.md §2). So: the smallest at least
 * `ART_MIN_PX`, or the largest there is.
 */
export function imageOf(raw: Record<string, unknown>): string | null {
  const container = isObject(raw['album']) ? raw['album'] : raw;
  const images = container['images'];
  if (!Array.isArray(images) || images.length === 0) return null;

  let pick: { url: string; w: number } | null = null;
  for (const image of images) {
    if (!isObject(image) || typeof image['url'] !== 'string') continue;
    // A playlist's single mosaic has no width; treat it as big enough.
    const w = typeof image['width'] === 'number' ? image['width'] : Number.POSITIVE_INFINITY;
    const better = !pick
      ? true
      : pick.w < ART_MIN_PX
        ? w > pick.w
        : w >= ART_MIN_PX && w < pick.w;
    if (better) pick = { url: image['url'], w };
  }
  return pick?.url ?? null;
}
