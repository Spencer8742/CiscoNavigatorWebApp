import { logger } from '~/lib/log.ts';
import { escapeXml, textOf } from '~/sonos/xml.ts';
import type { SonosClient } from '~/sonos/client.ts';
import type { UriRegistry } from '~/sonos/uris.ts';
import type { MediaArt } from '~/http/media-art.ts';
import type { Env } from '~/env.ts';
import type { BrowseResult, MediaItem, MediaKind } from '@shared/protocol.ts';

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
const SEARCH_URL = 'https://api.spotify.com/v1/search';

/** Per type, matching the panel's existing search sections. */
const LIMIT = 12;

const TIMEOUT_MS = 10_000;

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

  #token: string | null = null;
  #tokenExpires = 0;
  #account: Account | null = null;

  constructor(env: Env['spotify'], client: SonosClient, uris: UriRegistry, art: MediaArt) {
    this.#env = env;
    this.#client = client;
    this.#uris = uris;
    this.#art = art;
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
      `&type=track,album,artist,playlist&limit=${LIMIT}`;

    const body = await this.#get(url, token);

    const groups = [
      { name: 'Songs', items: this.#shapeAll(body, 'tracks', 'track', account) },
      { name: 'Albums', items: this.#shapeAll(body, 'albums', 'album', account) },
      { name: 'Artists', items: this.#shapeAll(body, 'artists', 'artist', account) },
      { name: 'Playlists', items: this.#shapeAll(body, 'playlists', 'playlist', account) },
    ];

    return { kind: 'groups', groups: groups.filter((g) => g.items.length > 0) };
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

  async #get(url: string, token: string): Promise<Record<string, unknown>> {
    const response = await this.#fetch(url, { headers: { authorization: `Bearer ${token}` } });

    if (response.status === 401) {
      // The token expired earlier than advertised. One retry, with a fresh one.
      this.#token = null;
      const fresh = await this.#accessToken();
      const retry = await this.#fetch(url, { headers: { authorization: `Bearer ${fresh}` } });
      if (!retry.ok) throw new Error(`Spotify search failed (HTTP ${retry.status})`);
      return (await retry.json()) as Record<string, unknown>;
    }

    if (!response.ok) throw new Error(`Spotify search failed (HTTP ${response.status})`);
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
  ): MediaItem[] {
    const container = body[section];
    const list = isObject(container) ? container['items'] : null;
    if (!Array.isArray(list)) return [];

    const out: MediaItem[] = [];
    for (const raw of list) {
      const shaped = this.#shape(raw, kind, account);
      if (shaped) out.push(shaped);
    }
    return out;
  }

  #shape(raw: unknown, kind: MediaKind, account: Account): MediaItem | null {
    if (!isObject(raw)) return null;

    const name = typeof raw['name'] === 'string' ? raw['name'] : null;
    const id = typeof raw['id'] === 'string' ? raw['id'] : null;
    if (!name || !id) return null;

    const spotifyUri = typeof raw['uri'] === 'string' ? raw['uri'] : `spotify:${kind}:${id}`;
    const { uri, metadata } = sonosUri(spotifyUri, name, kind, account);

    const item: MediaItem = {
      // The class goes with it so the registry knows an album is a container:
      // the URI scheme alone would say so too, but only for the kinds that
      // have a prefix, and the class is what keeps the two in step.
      u: this.#uris.register(uri, null, metadata, UPNP_CLASS[kind] ?? '') ?? '',
      n: name,
      k: kind,
    };

    const sub = subtitleOf(raw, kind);
    if (sub) item.s = sub;

    const art = this.#art.register(imageOf(raw));
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

    const learned = (await this.#learnFromFavourites()) ?? (await this.#learnFromServices());
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
  kind: MediaKind,
  account: Account,
): { uri: string; metadata: string } {
  const encoded = encodeURIComponent(spotifyUri);
  const prefix = CONTAINER_PREFIX[kind];

  const uri = prefix
    ? `x-rincon-cpcontainer:${prefix}${encoded}?sid=${account.sid}&flags=${CONTAINER_FLAGS}&sn=${account.sn}`
    : `x-sonos-spotify:${encoded}?sid=${account.sid}&flags=${FLAGS}&sn=${account.sn}`;

  const metadata = serviceDidl({
    id: prefix ? `${prefix}${encoded}` : spotifyUri,
    title,
    upnpClass: UPNP_CLASS[kind] ?? UPNP_CLASS['track'] ?? '',
    sid: account.sid,
  });

  return { uri, metadata };
}

/**
 * Sonos's type tag for each kind of container, which rides in front of the
 * service's own id inside an `x-rincon-cpcontainer:` URI.
 *
 * A kind absent from this table is an item rather than a container, and takes
 * the track URI shape instead.
 */
const CONTAINER_PREFIX: Partial<Record<MediaKind, string>> = {
  album: '1004206c',
  playlist: '1006206c',
  artist: '10052064',
};

/** Containers and items are flagged differently. Both are Sonos's values. */
const CONTAINER_FLAGS = 8300;

const UPNP_CLASS: Partial<Record<MediaKind, string>> = {
  track: 'object.item.audioItem.musicTrack',
  album: 'object.container.album.musicAlbum',
  artist: 'object.container.person.musicArtist',
  playlist: 'object.container.playlistContainer',
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

function subtitleOf(raw: Record<string, unknown>, kind: MediaKind): string | null {
  if (kind === 'artist') return null;

  const artists = Array.isArray(raw['artists'])
    ? raw['artists']
        .map((a) => (isObject(a) && typeof a['name'] === 'string' ? a['name'] : null))
        .filter((n): n is string => n !== null)
    : [];

  const album = isObject(raw['album']) && typeof raw['album']['name'] === 'string'
    ? raw['album']['name']
    : null;

  const parts = [artists.join(', '), kind === 'track' ? album : null].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The smallest image that is still big enough.
 *
 * Spotify lists images largest-first, and the panel draws these at about
 * 56 px. Taking the first would pull 640 px covers for a list of twelve, on a
 * device that gets killed for using too much memory (docs/ROOMOS.md §2).
 */
function imageOf(raw: Record<string, unknown>): string | null {
  const container = isObject(raw['album']) ? raw['album'] : raw;
  const images = container['images'];
  if (!Array.isArray(images) || images.length === 0) return null;

  const last = images[images.length - 1];
  return isObject(last) && typeof last['url'] === 'string' ? last['url'] : null;
}
