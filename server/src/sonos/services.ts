import { logger } from '~/lib/log.ts';
import { authority } from '~/sonos/soap.ts';
import { findAll, parseXml, textOf } from '~/sonos/xml.ts';
import type { SonosClient } from '~/sonos/client.ts';

const log = logger('sonos-services');

/**
 * Which music services this household actually has.
 *
 * Sonos knows about hundreds of services; a household has a handful. Telling
 * them apart takes three sources, and none of them is sufficient alone:
 *
 * | Source                  | Gives                                    |
 * |-------------------------|------------------------------------------|
 * | `ListAvailableServices` | the catalog: name, endpoint, auth policy |
 * | `/status/accounts`      | which are LINKED, and each account's `sn` |
 * | favourites & playlists  | confirmation, from URIs Sonos itself built |
 *
 * The catalog alone would offer YouTube Music to somebody who has never linked
 * it. The accounts alone name a service by a number with no endpoint to call.
 * The third is the tiebreaker and the most trustworthy of the three: a URI in
 * a favourite was written by Sonos, so its `sid` and `sn` are facts rather
 * than inferences.
 *
 * ## `sid`, `sn`, and the serviceType
 *
 *   serviceType = sid * 256 + 7
 *
 * `sid` identifies the SERVICE (Spotify is 9, Plex 3079…). `sn` identifies the
 * ACCOUNT — a household with two Spotify logins has one sid and two serial
 * numbers. Both ride in every playable URI, and a URI with the wrong `sn`
 * plays silence rather than erroring.
 */

/** How a service expects to be authenticated. */
export type ServiceAuth = 'Anonymous' | 'UserId' | 'DeviceLink' | 'AppLink';

export interface MusicService {
  /** Service id — the `sid` in every URI. */
  sid: number;
  name: string;
  /** SMAPI endpoint. HTTPS, from `SecureUri`. */
  uri: string;
  auth: ServiceAuth;
  /**
   * Account serial number, when this household has linked the service.
   * Null means the catalog lists it but nobody here uses it.
   */
  sn: number | null;
  /** Bit 1 (`0x02`) is "can search". Sonos's own bitfield. */
  capabilities: number;
}

/** `sid` → `serviceType`, the form used in a `<desc>` and in accounts. */
export function serviceTypeOf(sid: number): number {
  return sid * 256 + 7;
}

/** The inverse. Returns null for a type that is not of that shape. */
export function sidOf(serviceType: number): number | null {
  if (serviceType === 0) return null;
  const sid = (serviceType - 7) / 256;
  return Number.isInteger(sid) && sid > 0 ? sid : null;
}

/** Can this service be asked to search its own catalog? */
export function canSearch(service: MusicService): boolean {
  return (service.capabilities & 0x02) !== 0;
}

export class MusicServiceCatalog {
  readonly #client: SonosClient;

  /** sid → service, for everything the household can reach. */
  #services = new Map<number, MusicService>();

  #householdId: string | null = null;
  #loadedAt = 0;

  constructor(client: SonosClient) {
    this.#client = client;
  }

  /** Services this household has linked, or that need no linking at all. */
  /**
   * Services this household actually has.
   *
   * The bar is an ACCOUNT, not an auth policy. `ListAvailableServices` is
   * Sonos's whole catalog — every service it supports in this region, hundreds
   * of them — and a great many need no login. Passing those through put a row
   * on screen for every podcast aggregator Sonos has ever heard of, which is
   * what "a ton of lists I can't make sense of" looks like from the sofa.
   *
   * `sn` is set from `/status/accounts` and from URIs inside the household's
   * own favourites, so it means "somebody added this in the Sonos app" — which
   * is the question being asked.
   */
  list(): MusicService[] {
    return [...this.#services.values()]
      .filter((s) => s.sn !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(sid: number): MusicService | null {
    return this.#services.get(sid) ?? null;
  }

  get householdId(): string | null {
    return this.#householdId;
  }

  get loaded(): boolean {
    return this.#loadedAt > 0;
  }

  /**
   * Learn the household's services.
   *
   * Every step is best-effort and failures are logged rather than thrown: a
   * household with no services at all is a normal state, and it must not stop
   * favourites and the local library from working.
   */
  async refresh(host?: string): Promise<void> {
    const speaker = host ?? this.#anyHost();
    if (!speaker) return;

    const catalog = await this.#catalog(speaker);
    if (catalog.size === 0) return;

    /*
     * Two sources, and the second is the one that keeps working.
     *
     * `/status/accounts` is not served by every firmware. Favourites are: each
     * one carries a URI Sonos itself wrote, naming the service and the account
     * it plays through. Between them, a service the household genuinely uses
     * is found whether or not the status page exists.
     */
    const linked = await this.#accounts(speaker);
    for (const [sid, sn] of await this.#inUse(speaker)) {
      if (!linked.has(sid)) linked.set(sid, sn);
    }

    for (const [sid, sn] of linked) {
      const service = catalog.get(sid);
      if (service) service.sn = sn;
    }

    this.#services = catalog;
    this.#householdId = (await this.#household(speaker)) ?? this.#householdId;
    this.#loadedAt = Date.now();

    const usable = this.list();
    if (usable.length > 0) {
      log.info(`Music services: ${usable.map((s) => s.name).join(', ')}`);
    } else {
      /*
       * Say WHICH source came up empty. "No music services" is true of a
       * household that has none and of a bug that finds none, and the two
       * need completely different things done about them.
       */
      log.warn(
        `No music services found: ${catalog.size} in the catalog, ` +
          `${linked.size} account(s) detected. ` +
          (catalog.size === 0
            ? 'The speaker listed no services at all.'
            : 'The catalog loaded but nothing in it is linked to this household.'),
      );
    }
  }

  /**
   * Fill in an `sn` learned from a URI Sonos itself wrote.
   *
   * `/status/accounts` is not served by every firmware, so this is the path
   * that keeps working when it is missing — and it is the more trustworthy of
   * the two regardless.
   */
  observe(sid: number, sn: number): void {
    const service = this.#services.get(sid);
    if (!service || service.sn === sn) return;
    service.sn = sn;
    log.debug(`Learned account ${sn} for ${service.name} from a favourite`);
  }

  /* ── The three sources ─────────────────────────────────────────────────*/

  /** `ListAvailableServices` — the catalog, with no account information. */
  async #catalog(host: string): Promise<Map<number, MusicService>> {
    const out = new Map<number, MusicService>();
    try {
      const response = await this.#client.call(host, 'MusicServices', 'ListAvailableServices');
      // The list is a whole XML document escaped into one element.
      const root = parseXml(textOf(response, 'AvailableServiceDescriptorList') ?? '');
      if (!root) return out;

      for (const node of findAll(root, 'Service')) {
        const sid = Number.parseInt(node.attrs['Id'] ?? '', 10);
        const name = node.attrs['Name'];
        // `SecureUri` over `Uri`: these calls carry a credential.
        const uri = node.attrs['SecureUri'] ?? node.attrs['Uri'];
        if (!Number.isFinite(sid) || !name || !uri || !safeEndpoint(uri)) continue;

        const policy = findAll(node, 'Policy')[0];
        out.set(sid, {
          sid,
          name,
          uri,
          auth: authOf(policy?.attrs['Auth']),
          sn: null,
          capabilities: Number.parseInt(node.attrs['Capabilities'] ?? '0', 10) || 0,
        });
      }
    } catch (err) {
      log.warn(`Could not list music services: ${message(err)}`);
    }
    return out;
  }

  /**
   * `/status/accounts` — which services are linked, and under what serial.
   *
   * A plain HTTP GET rather than SOAP, and not present on every firmware, so
   * an empty answer here is unremarkable. It carries no tokens: the account
   * credentials never leave the speaker, which is why linking a service to
   * THIS app is a separate act rather than something that can be borrowed.
   */
  async #accounts(host: string): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    try {
      const response = await fetch(`http://${authority(host)}/status/accounts`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) return out;

      const root = parseXml(await response.text());
      if (!root) return out;

      for (const node of findAll(root, 'Account')) {
        if (node.attrs['Deleted'] === '1') continue;
        const sid = sidOf(Number.parseInt(node.attrs['Type'] ?? '', 10));
        const sn = Number.parseInt(node.attrs['SerialNum'] ?? '', 10);
        if (sid !== null && Number.isFinite(sn)) out.set(sid, sn);
      }
    } catch (err) {
      log.debug(`No account list from ${host}: ${message(err)}`);
    }
    return out;
  }

  /**
   * Which services the household's own content actually references.
   *
   * Favourites and Sonos playlists are full of URIs the speaker built, and
   * each carries `sid=` and `sn=`. Reading them is ground truth: a service
   * that something is favourited from is a service this household has,
   * whatever `/status/accounts` does or does not say.
   */
  async #inUse(host: string): Promise<Map<number, number>> {
    const out = new Map<number, number>();

    await Promise.all(
      ['FV:2', 'SQ:'].map(async (objectId) => {
        try {
          const response = await this.#client.call(host, 'ContentDirectory', 'Browse', {
            ObjectID: objectId,
            BrowseFlag: 'BrowseDirectChildren',
            Filter: '*',
            StartingIndex: 0,
            // Enough to see every service in use; not a page to render.
            RequestedCount: 200,
            SortCriteria: '',
          });
          for (const [sid, sn] of accountsFromUris(textOf(response, 'Result') ?? '')) {
            out.set(sid, sn);
          }
        } catch {
          // A household with no favourites is a normal state, not a failure.
        }
      }),
    );

    return out;
  }

  /** The household id, which every SMAPI call has to identify itself with. */
  async #household(host: string): Promise<string | null> {
    try {
      const response = await this.#client.call(host, 'DeviceProperties', 'GetHouseholdID');
      return textOf(response, 'CurrentHouseholdID');
    } catch (err) {
      log.debug(`Could not read the household id: ${message(err)}`);
      return null;
    }
  }

  #anyHost(): string | null {
    return [...this.#client.household.zones.values()][0]?.host ?? null;
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────────*/

const AUTH_KINDS: ReadonlySet<string> = new Set([
  'Anonymous',
  'UserId',
  'DeviceLink',
  'AppLink',
]);

/**
 * Somewhere it is acceptable to send a service credential.
 *
 * HTTPS anywhere, and plain HTTP only on this machine or a private network.
 * The rule is about the credential rather than about the protocol: a token in
 * cleartext across the internet is a real exposure, while a self-hosted
 * service on the LAN is the household's own network and is how several of
 * these are actually deployed.
 */
function safeEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;

  const host = url.hostname.replace(/^\[|]$/g, '');
  return (
    host === 'localhost' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    // Unique-local IPv6.
    /^f[cd]/i.test(host)
  );
}

function authOf(raw: string | undefined): ServiceAuth {
  // An unrecognised policy is treated as needing a link rather than as open:
  // guessing "Anonymous" would produce calls that fail confusingly, where
  // guessing "DeviceLink" produces a service that asks to be connected.
  return raw && AUTH_KINDS.has(raw) ? (raw as ServiceAuth) : 'DeviceLink';
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Every `sid`/`sn` pair in a blob of Sonos-written text.
 *
 * Favourites and playlists are full of URIs the speaker built, and each one
 * names the account it plays through. Reading them is how this survives a
 * firmware that does not serve `/status/accounts`.
 */
export function accountsFromUris(text: string): Map<number, number> {
  const out = new Map<number, number>();

  /*
   * `&amp;` first, and this is the whole bug this function once had.
   *
   * Sonos escapes a URI's own `&` when it writes the DIDL, and escapes the
   * DIDL again when it puts it in `<Result>`. One decode gets you the DIDL
   * with the query string still reading `?sid=9&amp;flags=32&amp;sn=3` — so a
   * pattern expecting a literal `&` before `sn=` matches NOTHING, at any
   * nesting depth, on every real household.
   *
   * The symptom was total: no service ever got an account number, so the
   * household appeared to have no music services at all.
   */
  const flat = text.replace(/&amp;/g, '&');
  const re = /[?&]sid=(\d+)[^"'<\s\\]*?[?&]sn=(\d+)/g;

  let match: RegExpExecArray | null;
  while ((match = re.exec(flat)) !== null) {
    const sid = Number.parseInt(match[1] ?? '', 10);
    const sn = Number.parseInt(match[2] ?? '', 10);
    if (Number.isFinite(sid) && Number.isFinite(sn)) out.set(sid, sn);
  }
  return out;
}
