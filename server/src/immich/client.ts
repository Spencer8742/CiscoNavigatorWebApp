import { logger } from '~/lib/log.ts';
import type { Env } from '~/env.ts';
import type { ImmichSource } from '@shared/config.ts';
import type { PhotoRef } from '@shared/protocol.ts';

const log = logger('immich');

/**
 * Immich REST client.
 *
 * Written against the published OpenAPI description, **API version 3.1.0**.
 * The endpoints used:
 *
 *   POST /api/search/random     RandomSearchDto  -> AssetResponseDto[]
 *   POST /api/search/metadata   MetadataSearchDto-> SearchResponseDto
 *   GET  /api/assets/{id}/thumbnail?size=…
 *   GET  /api/server/ping
 *
 * One decision worth flagging: **album sources also go through
 * `/search/random`**, using its `albumIds` filter, rather than fetching the
 * album and shuffling its asset list here. `AlbumResponseDto` does not even
 * carry assets, so the alternative would be a second request per album plus
 * client-side shuffling of a list that can be tens of thousands long. One
 * request, filtered server-side, is both simpler and cheaper.
 */

/** Only what the panel needs. Everything else in the asset is dropped. */
interface ImmichAsset {
  id: string;
  type: string;
  thumbhash?: string | null;
  localDateTime?: string;
  fileCreatedAt?: string;
  exifInfo?: {
    exifImageWidth?: number | null;
    exifImageHeight?: number | null;
    city?: string | null;
    country?: string | null;
    dateTimeOriginal?: string | null;
  } | null;
}

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The result of a request that failed, in a form the panel can render.
 *
 * A slideshow that shows nothing is indistinguishable from a slideshow that
 * cannot reach its photos, so "no photos" is never a sufficient thing to
 * report. Whatever Immich actually said gets carried all the way to the
 * screen — see `panel/src/screens/Photos.tsx`.
 */
export interface ImmichFailure {
  /** Machine-readable, so the panel can give specific advice. */
  code: 'auth' | 'not-found' | 'bad-request' | 'server' | 'network';
  /** Human-readable, already including Immich's own message where it gave one. */
  message: string;
}

/** Immich's error envelope: { statusCode, message, error }. */
interface ImmichError {
  message?: string | string[];
  error?: string;
}

export class ImmichClient {
  readonly #env: Env['immich'];
  #reachable = false;
  #lastError: ImmichFailure | null = null;

  /**
   * Whether this server is old enough to want `isArchived` instead of
   * `visibility`. Discovered from a 400, then remembered.
   *
   * Immich renamed the field in 1.133.0: ≤ 1.132 has `isArchived`/`withArchived`,
   * ≥ 1.133 has `visibility`. Its request validation rejects unknown
   * properties outright, so sending the wrong one does not degrade to an
   * unfiltered search — it fails the whole query with a 400.
   */
  #useLegacyArchiveField = false;

  constructor(env: Env['immich']) {
    this.#env = env;
  }

  get enabled(): boolean {
    return this.#env.enabled;
  }

  get reachable(): boolean {
    return this.#reachable;
  }

  get lastError(): ImmichFailure | null {
    return this.#lastError;
  }

  async #request<T>(path: string, init?: RequestInit): Promise<T | null> {
    if (!this.#env.enabled) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(this.#env.url + path, {
        ...init,
        signal: controller.signal,
        headers: {
          // Immich authenticates API keys with this header, not a bearer
          // token. The key never leaves this process.
          'x-api-key': this.#env.apiKey,
          accept: 'application/json',
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
          ...init?.headers,
        },
      });

      if (!res.ok) {
        this.#reachable = res.status < 500;
        this.#lastError = await describeFailure(res, path);
        // Every one of these used to be silent below `error` level, which
        // made a misconfigured Immich look exactly like an empty library.
        log[res.status === 401 || res.status === 403 ? 'error' : 'warn'](
          `Immich: ${this.#lastError.message}`,
        );
        return null;
      }

      this.#reachable = true;
      this.#lastError = null;
      return (await res.json()) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#reachable = false;
      this.#lastError = {
        code: 'network',
        message: `cannot reach ${this.#env.url} — ${message}`,
      };
      // Was log.debug, i.e. invisible at the default level. A wrong
      // IMMICH_URL is the single most likely thing to be wrong on first
      // setup, and it produced no output at all.
      log.warn(`Immich: ${this.#lastError.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Liveness *and* credential check.
   *
   * `/api/server/ping` is deliberately unauthenticated in Immich, so it
   * proves only that something Immich-shaped is answering — a wrong or
   * unprivileged API key pings perfectly happily. Health said "connected"
   * while every actual query was being rejected. This asks for one asset
   * instead, which exercises the key and the permission the slideshow needs.
   */
  async ping(): Promise<boolean> {
    // Deliberately the barest possible query: one asset, no filters. It is
    // checking the key and the permission, so it must not fail for any other
    // reason — in particular it carries no archive field, and so works on
    // either side of the 1.133 rename.
    const res = await this.#request<{ assets?: { items?: ImmichAsset[] } }>('/api/search/metadata', {
      method: 'POST',
      body: JSON.stringify({ size: 1 }),
    });
    return res !== null;
  }

  /**
   * Fetch a batch of assets for one configured source.
   *
   * `size` is capped at 1000 by the API. We ask for a few hundred at a time
   * and shuffle server-side, which is what makes "random" actually random
   * across a large library rather than random within the first page.
   */
  /**
   * One `/search/random` query, retried once against the pre-1.133 field name
   * if this server turns out to be older.
   *
   * The retry is driven by what Immich actually says — a 400 naming
   * `visibility` — rather than by a version number, so it needs no version
   * probe and cannot misfire on a server that accepts the field.
   */
  async #search(body: Record<string, unknown>): Promise<ImmichAsset[] | null> {
    const withArchiveFilter = (legacy: boolean): Record<string, unknown> => ({
      ...body,
      // Archived and hidden photos are excluded deliberately: they were put
      // there to stay off screens.
      ...(legacy ? { isArchived: false } : { visibility: 'timeline' }),
    });

    const first = await this.#request<ImmichAsset[]>('/api/search/random', {
      method: 'POST',
      body: JSON.stringify(withArchiveFilter(this.#useLegacyArchiveField)),
    });
    if (first !== null) return first;

    const err = this.#lastError;
    if (this.#useLegacyArchiveField || err?.code !== 'bad-request') return null;
    if (!/visibility/i.test(err.message)) return null;

    log.warn(
      'This Immich predates 1.133, which renamed `isArchived` to `visibility`. ' +
        'Retrying with the older field — upgrading Immich is the tidier fix.',
    );
    this.#useLegacyArchiveField = true;

    return this.#request<ImmichAsset[]>('/api/search/random', {
      method: 'POST',
      body: JSON.stringify(withArchiveFilter(true)),
    });
  }

  async fetchSource(source: ImmichSource, count: number, opts: SourceOptions): Promise<PhotoRef[]> {
    const size = Math.max(1, Math.min(1000, count));

    const base: Record<string, unknown> = {
      size,
      withExif: true,
      ...(opts.imagesOnly ? { type: 'IMAGE' } : {}),
      ...(opts.takenAfter ? { takenAfter: opts.takenAfter } : {}),
    };

    switch (source.type) {
      case 'random': {
        return toPhotoRefs((await this.#search(base)) ?? []);
      }

      case 'favorites': {
        return toPhotoRefs((await this.#search({ ...base, isFavorite: true })) ?? []);
      }

      case 'album': {
        // albumIds is a RandomSearchDto filter, so this stays one request.
        const assets = await this.#search({ ...base, albumIds: [source.id] });
        if (assets !== null && assets.length === 0) {
          log.warn(
            `Album ${source.id} matched no photos. The album id comes from its ` +
              'URL, and the API key must have album.read as well as asset.read.',
          );
        }
        return toPhotoRefs(assets ?? []);
      }

      case 'recent': {
        // Metadata search, not random: "recent" means newest-first, which a
        // random sample cannot express. Same archive-field split as above.
        const since = new Date(Date.now() - source.days * 86_400_000).toISOString();
        const body = {
          ...base,
          takenAfter: since,
          order: 'desc',
          ...(this.#useLegacyArchiveField ? { isArchived: false } : { visibility: 'timeline' }),
        };
        const result = await this.#request<{ assets?: { items?: ImmichAsset[] } }>(
          '/api/search/metadata',
          { method: 'POST', body: JSON.stringify(body) },
        );
        return toPhotoRefs(result?.assets?.items ?? []);
      }

      default:
        return [];
    }
  }
}

/**
 * Turn a failed response into something worth reading.
 *
 * Immich returns `{ statusCode, message, error }`, and its message is
 * genuinely useful — a rejected property is named explicitly. Discarding it
 * and printing the status code alone, which is what this used to do, threw
 * away the answer and kept the symptom.
 */
async function describeFailure(res: Response, path: string): Promise<ImmichFailure> {
  let detail = '';
  try {
    const body = (await res.json()) as ImmichError;
    const raw = Array.isArray(body.message) ? body.message.join('; ') : body.message;
    if (raw) detail = raw;
  } catch {
    // Not JSON — a reverse proxy's HTML error page, most likely. The status
    // code still tells us something, so carry on with it.
  }

  const suffix = detail ? ` — ${detail}` : '';

  if (res.status === 401 || res.status === 403) {
    return {
      code: 'auth',
      message:
        `API key rejected (HTTP ${res.status})${suffix}. It needs the ` +
        'asset.read permission, plus album.read for album sources.',
    };
  }
  if (res.status === 404) {
    return {
      code: 'not-found',
      message:
        `${path} not found (HTTP 404)${suffix}. IMMICH_URL should be the ` +
        "server's base address, without a trailing /api.",
    };
  }
  if (res.status === 400) {
    return { code: 'bad-request', message: `${path} rejected the query (HTTP 400)${suffix}` };
  }
  return { code: 'server', message: `${path} returned HTTP ${res.status}${suffix}` };
}

export interface SourceOptions {
  imagesOnly: boolean;
  /** ISO date; photos older than this are excluded. */
  takenAfter?: string;
}

/**
 * Immich's asset shape → the panel's.
 *
 * This is where the wire payload shrinks by ~95%: an `AssetResponseDto`
 * carries owner, tags, people, checksums, paths and full EXIF. The panel
 * needs an id, dimensions, a hash and a caption. Sending the rest would be
 * bytes and parse time spent on a constrained device for nothing.
 */
function toPhotoRefs(assets: ImmichAsset[]): PhotoRef[] {
  const out: PhotoRef[] = [];

  for (const asset of assets) {
    if (!asset?.id) continue;

    const exif = asset.exifInfo ?? undefined;
    const w = exif?.exifImageWidth ?? 0;
    const h = exif?.exifImageHeight ?? 0;

    const ref: PhotoRef = { id: asset.id, w: w || 0, h: h || 0 };

    if (asset.thumbhash) ref.th = asset.thumbhash;

    const taken = exif?.dateTimeOriginal ?? asset.localDateTime ?? asset.fileCreatedAt;
    if (taken) ref.taken = taken;
    if (exif?.city) ref.city = exif.city;
    if (exif?.country) ref.country = exif.country;

    out.push(ref);
  }

  return out;
}
