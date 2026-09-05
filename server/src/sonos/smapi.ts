import { serviceTypeOf, type MusicService } from '~/sonos/services.ts';
import { escapeXml, find, parseXml, textOf, type XmlNode } from '~/sonos/xml.ts';


/**
 * SMAPI — the API a music service exposes TO Sonos.
 *
 * This is the other half of the integration and a different kind of thing from
 * everything else in `sonos/`. The rest of this directory talks to speakers on
 * the LAN; this talks to Plex, SoundCloud, YouTube Music and Sonos Radio over
 * the internet, in the dialect their Sonos endpoints speak — the same one the
 * speakers themselves use.
 *
 * ## Why this is needed at all
 *
 * A favourite carries everything required to play it, which is why favourites
 * work with no service login on this side. What they cannot do is SEARCH. To
 * find something that is not already favourited, the service's own catalog has
 * to be asked, and only SMAPI can ask it.
 *
 * ## Why linking is a separate act
 *
 * The credentials for a service live on the speakers and are not readable —
 * `/status/accounts` gives account numbers and no tokens. So an app that wants
 * to browse Plex has to be linked to Plex itself, once, in its own right.
 *
 * The flow suits a wall panel unusually well. `getDeviceLinkCode` returns a
 * URL and a short code; somebody types the code on their phone, and this polls
 * until the service hands back a token. **No redirect and no browser on this
 * side** — which matters, because RoomOS has one tab and `window.open`
 * replaces the page it was called from.
 *
 * ## What is reverse-engineered here
 *
 * SMAPI is documented; the URI construction below is not. The eight-hex-digit
 * prefixes in `CONTAINER_PREFIX` are Sonos's own type tags, learned from URIs
 * that speakers produce. They are the least certain part of this file, and the
 * failure they cause is loud (a container that will not open) rather than
 * silent, which is the reason to prefer them over guessing at playback time.
 */

const NS = 'http://www.sonos.com/Services/1.1';

/** SMAPI calls go to the open internet, so they get a real timeout. */
const TIMEOUT_MS = 10_000;

/** A page of results. Services cap this well below what a panel would ask. */
const PAGE = 60;

export interface ServiceToken {
  token: string;
  key: string;
  /** The account number this token stands in for, once known. */
  sn: number | null;
}

/** One row from a service's catalog. */
export interface SmapiItem {
  id: string;
  title: string;
  /** `album`, `track`, `playlist`, `stream`, `artist`… Sonos's vocabulary. */
  itemType: string;
  artist: string | null;
  album: string | null;
  artUri: string | null;
  duration: number | null;
  /** False when the service says this row is not playable on its own. */
  canPlay: boolean;
}

export interface SmapiPage {
  items: SmapiItem[];
  total: number;
}

/** What a device-link attempt is waiting on. */
export interface LinkPrompt {
  /** Where the person has to go. Shown as text — the panel cannot navigate. */
  url: string;
  /** The short code they type there. Some services show it themselves. */
  code: string | null;
}

export class SmapiError extends Error {
  readonly fault: string;

  constructor(message: string, fault = '') {
    super(message);
    this.name = 'SmapiError';
    this.fault = fault;
  }

  /** The service is telling us the link has not been confirmed yet. */
  get pending(): boolean {
    return this.fault.includes('NOT_LINKED_RETRY');
  }

  /** The token we hold is no longer good — the service must be re-linked. */
  get expired(): boolean {
    return (
      this.fault.includes('AUTH_TOKEN_EXPIRED') ||
      this.fault.includes('Client.AuthTokenExpired') ||
      this.fault.includes('NOT_LINKED_FAILURE') ||
      this.fault.includes('Client.LoginUnauthorized')
    );
  }
}

export class SmapiClient {
  readonly #service: MusicService;
  readonly #householdId: string;
  readonly #deviceId: string;
  #token: ServiceToken | null;
  readonly #onToken: ((token: ServiceToken) => Promise<void>) | undefined;

  constructor(
    service: MusicService,
    householdId: string,
    deviceId: string,
    token: ServiceToken | null,
    onToken?: (token: ServiceToken) => Promise<void>,
  ) {
    this.#service = service;
    this.#householdId = householdId;
    this.#deviceId = deviceId;
    this.#token = token;
    this.#onToken = onToken;
  }

  get service(): MusicService {
    return this.#service;
  }

  /** Whether this service can be called right now. */
  get ready(): boolean {
    return this.#service.auth === 'Anonymous' || this.#token !== null;
  }

  setToken(token: ServiceToken | null): void {
    this.#token = token;
  }

  /* ── Browsing ──────────────────────────────────────────────────────────*/

  /**
   * One page of a container. `'root'` is every service's top level.
   */
  async getMetadata(id: string, offset = 0, count = PAGE): Promise<SmapiPage> {
    const body =
      `<id>${escapeXml(id)}</id>` +
      `<index>${offset}</index>` +
      `<count>${count}</count>` +
      '<recursive>false</recursive>';

    const result = await this.#call('getMetadata', body);
    return parsePage(find(result, 'getMetadataResult'));
  }

  /**
   * Search one category of the catalog.
   *
   * `category` is the service's own name for it — most offer `albums`,
   * `tracks`, `artists`, `playlists`, and a service is entitled to offer none
   * of those. The categories come from the presentation map, which this does
   * not fetch, so an unknown category is a normal failure rather than a bug.
   */
  async search(category: string, term: string, count = PAGE): Promise<SmapiPage> {
    const body =
      `<id>${escapeXml(category)}</id>` +
      `<term>${escapeXml(term)}</term>` +
      '<index>0</index>' +
      `<count>${count}</count>`;

    const result = await this.#call('search', body);
    return parsePage(find(result, 'searchResult'));
  }

  /* ── Linking ───────────────────────────────────────────────────────────*/

  /**
   * Begin a device link. Returns what to show the person.
   *
   * The `linkCode` has to be kept — `getDeviceAuthToken` is the same code
   * handed back, and a service will not issue a token for a code it did not
   * just mint.
   */
  async beginLink(): Promise<{ prompt: LinkPrompt; linkCode: string; linkDeviceId: string | null }> {
    /*
     * TWO calls, one for each of Sonos's linking policies.
     *
     * `AppLink` is the newer one and answers `getAppLink`; `DeviceLink`
     * answers `getDeviceLinkCode`. Sending the wrong one gets a fault, so a
     * service that advertised `AppLink` could never be connected while this
     * only ever asked for a device link code.
     *
     * What comes back is the same three fields either way — `getAppLink`
     * simply wraps them in `authorizeAccount/deviceLink` — so the fields are
     * looked up by name anywhere in the reply rather than at a fixed path.
     */
    const appLink = this.#service.auth === 'AppLink';
    const household = `<householdId>${escapeXml(this.#householdId)}</householdId>`;

    /*
     * `getAppLink` takes more than the household, and several services reject
     * a call missing them rather than defaulting. They describe the CLIENT
     * asking to be linked, which is this app rather than a speaker — saying so
     * honestly is also what stops a service treating us as a player it can
     * make assumptions about.
     */
    const body = appLink
      ? `${household}<hardware>navigator-panel</hardware>` +
        '<osVersion>1.0</osVersion>' +
        '<sonosAppName>Navigator Panel</sonosAppName><callbackPath></callbackPath>'
      : household;

    const result = await this.#call(appLink ? 'getAppLink' : 'getDeviceLinkCode', body);

    // Only authorizeAccount belongs to this flow; createAccount may have a different code.
    const part = appLink ? find(find(result, 'authorizeAccount'), 'deviceLink') : result;
    const linkCode = textOf(part, 'linkCode');
    const url = textOf(part, 'regUrl');
    if (!linkCode || !url) throw new SmapiError('The service did not offer a link code');

    return {
      // `showLinkCode` false means the service shows the code on its own page,
      // so repeating it here would be one more number to mistype.
      prompt: { url, code: ['false', '0'].includes(textOf(part, 'showLinkCode') ?? '') ? null : linkCode },
      linkCode,
      linkDeviceId: textOf(part, 'linkDeviceId'),
    };
  }

  /**
   * Ask whether the person has confirmed the link yet.
   *
   * Throws with `pending` set while they have not, which is the service's
   * normal answer rather than an error — the caller polls on it.
   */
  async finishLink(linkCode: string, linkDeviceId: string | null = null): Promise<ServiceToken> {
    const result = await this.#call(
      'getDeviceAuthToken',
      `<householdId>${escapeXml(this.#householdId)}</householdId>` +
        `<linkCode>${escapeXml(linkCode)}</linkCode>` +
        (linkDeviceId ? `<linkDeviceId>${escapeXml(linkDeviceId)}</linkDeviceId>` : ''),
    );

    const token = textOf(result, 'authToken');
    if (!token) throw new SmapiError('The service did not return a token');

    return { token, key: textOf(result, 'privateKey') ?? '', sn: null };
  }

  /* ── Transport ─────────────────────────────────────────────────────────*/

  async #call(action: string, body: string, retried = false): Promise<XmlNode> {
    const envelope =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">' +
      `<s:Header>${this.#credentials()}</s:Header>` +
      `<s:Body><${action} xmlns="${NS}">${body}</${action}></s:Body>` +
      '</s:Envelope>';

    let response: Response;
    try {
      response = await fetch(this.#service.uri, {
        method: 'POST',
        headers: {
          'content-type': 'text/xml; charset="utf-8"',
          SOAPAction: `"${NS}#${action}"`,
          // Some services vary their answer by client. Naming ourselves
          // honestly is better than impersonating a speaker.
          'user-agent': 'Linux UPnP/1.0 Sonos/00.0-00000',
        },
        body: envelope,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new SmapiError(`${this.#service.name} did not answer: ${describe(err)}`);
    }

    const text = await response.text();
    const root = parseXml(text);

    const faultNode = find(root, 'Fault');
    if (faultNode || !response.ok) {
      // Preserve the code even when a service also supplies exception details.
      const fault = [...new Set(['faultcode', 'faultstring', 'ExceptionInfo', 'ExceptionDetail']
        .map((name) => textOf(faultNode, name)).filter(Boolean))].join(' ');
      if (!retried && this.#token && fault.includes('Client.TokenRefreshRequired')) {
        const refresh = find(faultNode, 'refreshAuthTokenResult');
        const token = textOf(refresh, 'authToken');
        const key = textOf(refresh, 'privateKey');
        if (token && key !== null) {
          this.#token = { ...this.#token, token, key };
          await this.#onToken?.(this.#token);
          return this.#call(action, body, true);
        }
      }
      throw new SmapiError(
        `${this.#service.name} refused ${action} (HTTP ${response.status})`, fault,
      );
    }

    if (!root || !find(root, `${action}Response`)) {
      throw new SmapiError(`${this.#service.name} sent an unreadable reply`);
    }
    return root;
  }

  /**
   * The SOAP header every SMAPI call carries.
   *
   * An anonymous service gets identity without authority: who is asking, but
   * no claim to an account. Everything else adds the token this app was issued
   * when it was linked.
   */
  #credentials(): string {
    const head =
      `<credentials xmlns="${NS}">` +
      `<deviceId>${escapeXml(this.#deviceId)}</deviceId>` +
      '<deviceProvider>Sonos</deviceProvider>';

    if (!this.#token) return `${head}</credentials>`;

    return (
      `${head}<loginToken>` +
      `<token>${escapeXml(this.#token.token)}</token>` +
      `<key>${escapeXml(this.#token.key)}</key>` +
      `<householdId>${escapeXml(this.#householdId)}</householdId>` +
      '</loginToken></credentials>'
    );
  }
}

/* ── Parsing ─────────────────────────────────────────────────────────────*/

/**
 * A `getMetadataResult` or `searchResult`.
 *
 * Collections and items are interleaved and BOTH are kept in document order,
 * for the same reason favourites are: a service that returns "playlists, then
 * albums" chose that order and re-sorting it loses information the person
 * would have used.
 */
function parsePage(node: XmlNode | null): SmapiPage {
  if (!node) throw new SmapiError('The service returned no catalog result');

  const items: SmapiItem[] = [];
  for (const child of node.children) {
    const local = child.name.slice(child.name.indexOf(':') + 1);
    if (local !== 'mediaCollection' && local !== 'mediaMetadata') continue;

    const id = textOf(child, 'id');
    const title = textOf(child, 'title');
    if (!id || !title) continue;

    // A track's artist and duration hide one level down, in `trackMetadata`.
    const meta = find(child, 'trackMetadata') ?? child;

    items.push({
      id,
      title,
      itemType: textOf(child, 'itemType') ?? (local === 'mediaCollection' ? 'container' : 'track'),
      artist: textOf(meta, 'artist') ?? textOf(child, 'artist'),
      album: textOf(meta, 'album') ?? textOf(child, 'album'),
      artUri: textOf(meta, 'albumArtURI') ?? textOf(child, 'albumArtURI'),
      duration: seconds(textOf(meta, 'duration')),
      // Absent means playable; only an explicit "false" is a refusal.
      canPlay: !['false', '0'].includes(textOf(child, 'canPlay') ?? ''),
    });
  }

  const total = Number.parseInt(textOf(node, 'total') ?? '', 10);
  return { items, total: Number.isFinite(total) ? total : items.length };
}

function seconds(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    // `fetch` reports every transport failure as "fetch failed"; the reason is
    // one level down.
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error) return cause.message;
    return err.message;
  }
  return String(err);
}

/* ── Turning a catalog row into something a speaker will play ────────────*/

/**
 * Sonos's type tag for each kind of container.
 *
 * These prefixes ride in front of the service's own id inside an
 * `x-rincon-cpcontainer:` URI, and they are how a speaker knows whether it was
 * handed an album or a playlist before it fetches anything.
 *
 * Reverse-engineered from URIs that real speakers produce. An itemType missing
 * from this table falls back to the generic container tag, which is usually
 * right and never dangerous — the worst case is a container that opens but
 * renders with the wrong idea of what it is.
 */
const CONTAINER_PREFIX: Record<string, string> = {
  album: '1004206c',
  albumList: '100d206c',
  artist: '10052064',
  artistTrackList: '100f2064',
  audiobook: '1009206c',
  container: '10062a6c',
  collection: '10062a6c',
  favorites: '10fe2064',
  genre: '100f2064',
  playlist: '1006206c',
  trackList: '1008206c',
};

/** itemTypes that are a live stream rather than something with an end. */
const STREAM_TYPES: ReadonlySet<string> = new Set(['stream', 'show', 'program']);

/** itemTypes that are one playable thing rather than a collection. */
const ITEM_TYPES: ReadonlySet<string> = new Set(['track', 'song', 'audiobook-track']);

export interface ServicePlayable {
  uri: string;
  metadata: string;
  upnpClass: string;
}

/**
 * A catalog row → the URI and DIDL a speaker needs.
 *
 * The DIDL is not decoration. Its `<desc>` names the service account, and an
 * item handed over without one is accepted and plays silence — which is why
 * this returns the pair rather than a URI that a caller might use alone.
 */
export function servicePlayable(
  item: SmapiItem,
  service: MusicService,
): ServicePlayable | null {
  const sn = service.sn ?? 1;
  const encoded = encodeURIComponent(item.id);
  const account = `sid=${service.sid}&sn=${sn}`;

  if (STREAM_TYPES.has(item.itemType)) {
    return {
      uri: `x-sonosapi-stream:${encoded}?${account}&flags=8224`,
      metadata: serviceDidl(item.id, item.title, AUDIO_BROADCAST, service.sid),
      upnpClass: AUDIO_BROADCAST,
    };
  }

  if (ITEM_TYPES.has(item.itemType)) {
    /*
     * `x-sonos-http:` with a `.mp3` suffix is the generic form for a service
     * track. The extension is a convention rather than a claim about the
     * codec — the service decides what it actually sends.
     */
    return {
      uri: `x-sonos-http:${encoded}.mp3?${account}&flags=8224`,
      metadata: serviceDidl(item.id, item.title, MUSIC_TRACK, service.sid),
      upnpClass: MUSIC_TRACK,
    };
  }

  const prefix = CONTAINER_PREFIX[item.itemType] ?? CONTAINER_PREFIX['container'];
  const id = `${prefix}${encoded}`;
  const upnpClass = CONTAINER_CLASS[item.itemType] ?? 'object.container';

  return {
    uri: `x-rincon-cpcontainer:${id}?${account}&flags=8300`,
    metadata: serviceDidl(id, item.title, upnpClass, service.sid),
    upnpClass,
  };
}

const MUSIC_TRACK = 'object.item.audioItem.musicTrack';
const AUDIO_BROADCAST = 'object.item.audioItem.audioBroadcast';

const CONTAINER_CLASS: Record<string, string> = {
  album: 'object.container.album.musicAlbum',
  albumList: 'object.container.albumlist',
  artist: 'object.container.person.musicArtist',
  audiobook: 'object.container.album.musicAlbum',
  genre: 'object.container.genre.musicGenre',
  playlist: 'object.container.playlistContainer',
  trackList: 'object.container.playlistContainer',
};

/**
 * The DIDL a music-service item has to be handed back with.
 *
 * `serviceType = sid * 256 + 7` is Sonos's own relationship between a service
 * id and the token in its metadata descriptor — arbitrary-looking, and
 * load-bearing: it is how the speaker picks the account to play through.
 */
export function serviceDidl(
  id: string,
  title: string,
  upnpClass: string,
  sid: number,
): string {
  const type = serviceTypeOf(sid);
  return (
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" ' +
    'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
    `<item id="${escapeXml(id)}" parentID="-1" restricted="true">` +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    `<upnp:class>${upnpClass}</upnp:class>` +
    '<desc id="cdudn" nameSpace="urn:schemas-rinconnetworks-com:metadata-1-0/">' +
    `SA_RINCON${type}_X_#Svc${type}-0-Token</desc>` +
    '</item></DIDL-Lite>'
  );
}

/**
 * The search categories a service is likely to accept.
 *
 * The authoritative list is in each service's presentation map, which is a
 * second HTTP fetch and a second XML dialect for a list that is nearly always
 * these four. Asking for all of them concurrently and keeping whatever answers
 * costs one round trip and no parsing at all.
 */
export const SEARCH_CATEGORIES: readonly { id: string; name: string }[] = [
  { id: 'tracks', name: 'Songs' },
  { id: 'albums', name: 'Albums' },
  { id: 'artists', name: 'Artists' },
  { id: 'playlists', name: 'Playlists' },
];
