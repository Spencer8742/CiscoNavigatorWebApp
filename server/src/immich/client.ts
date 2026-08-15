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

export class ImmichClient {
  readonly #env: Env['immich'];
  #reachable = false;
  #lastError: string | null = null;

  constructor(env: Env['immich']) {
    this.#env = env;
  }

  get enabled(): boolean {
    return this.#env.enabled;
  }

  get reachable(): boolean {
    return this.#reachable;
  }

  get lastError(): string | null {
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
        this.#lastError = `HTTP ${res.status} from ${path}`;
        // 401 is worth shouting about: it means the API key is wrong or its
        // scopes are too narrow, and it will never fix itself.
        if (res.status === 401 || res.status === 403) {
          log.error(
            `Immich rejected the API key (HTTP ${res.status}). It needs the ` +
              'asset.read and album.read permissions.',
          );
        }
        return null;
      }

      this.#reachable = true;
      this.#lastError = null;
      return (await res.json()) as T;
    } catch (err) {
      this.#reachable = false;
      this.#lastError = err instanceof Error ? err.message : String(err);
      log.debug(`Request to ${path} failed:`, err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Cheap liveness check for the health report. */
  async ping(): Promise<boolean> {
    const res = await this.#request<{ res?: string }>('/api/server/ping');
    return res !== null;
  }

  /**
   * Fetch a batch of assets for one configured source.
   *
   * `size` is capped at 1000 by the API. We ask for a few hundred at a time
   * and shuffle server-side, which is what makes "random" actually random
   * across a large library rather than random within the first page.
   */
  async fetchSource(source: ImmichSource, count: number, opts: SourceOptions): Promise<PhotoRef[]> {
    const size = Math.max(1, Math.min(1000, count));

    const base: Record<string, unknown> = {
      size,
      withExif: true,
      // Archived and hidden photos are excluded deliberately: they were put
      // there to stay off screens.
      visibility: 'timeline',
      ...(opts.imagesOnly ? { type: 'IMAGE' } : {}),
      ...(opts.takenAfter ? { takenAfter: opts.takenAfter } : {}),
    };

    switch (source.type) {
      case 'random': {
        const assets = await this.#request<ImmichAsset[]>('/api/search/random', {
          method: 'POST',
          body: JSON.stringify(base),
        });
        return toPhotoRefs(assets ?? []);
      }

      case 'favorites': {
        const assets = await this.#request<ImmichAsset[]>('/api/search/random', {
          method: 'POST',
          body: JSON.stringify({ ...base, isFavorite: true }),
        });
        return toPhotoRefs(assets ?? []);
      }

      case 'album': {
        // albumIds is a RandomSearchDto filter, so this stays one request.
        const assets = await this.#request<ImmichAsset[]>('/api/search/random', {
          method: 'POST',
          body: JSON.stringify({ ...base, albumIds: [source.id] }),
        });
        if (assets === null) {
          log.warn(`Album ${source.id} returned nothing — is the ID correct?`);
        }
        return toPhotoRefs(assets ?? []);
      }

      case 'recent': {
        const since = new Date(Date.now() - source.days * 86_400_000).toISOString();
        const result = await this.#request<{ assets?: { items?: ImmichAsset[] } }>(
          '/api/search/metadata',
          {
            method: 'POST',
            body: JSON.stringify({
              ...base,
              takenAfter: since,
              order: 'desc',
            }),
          },
        );
        return toPhotoRefs(result?.assets?.items ?? []);
      }

      default:
        return [];
    }
  }
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
