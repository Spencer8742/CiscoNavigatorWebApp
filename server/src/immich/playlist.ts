import { logger } from '~/lib/log.ts';
import type { ImmichClient } from '~/immich/client.ts';
import type { DashboardConfig } from '@shared/config.ts';
import type { PhotoRef } from '@shared/protocol.ts';

const log = logger('playlist');

/**
 * The slideshow playlist, held server-side.
 *
 * Why the backend owns this rather than the panel:
 *
 * **Restarting the panel does not restart the slideshow.** RoomOS reloads the
 * web view daily and wipes its storage; if the position lived on the device
 * you would see the same first few photos every morning. Here the position
 * survives, so the slideshow just carries on.
 *
 * **The panel never runs a search.** It asks for "the next N" and gets a
 * small array of ids. All the querying, shuffling, de-duplicating and
 * refilling happens on a machine with CPU to spare.
 *
 * **Refills happen ahead of time.** When the buffer drops below a threshold a
 * background refill starts, so the panel never waits on an Immich query
 * mid-slideshow.
 */

/** Target buffer size. A few hundred ids is tens of kilobytes. */
const TARGET = 240;
/** Refill when fewer than this remain unserved. */
const LOW_WATER = 60;
/** Never hammer Immich if it is unhealthy or the library is tiny. */
const MIN_REFILL_INTERVAL_MS = 30_000;

export class Playlist {
  readonly #client: ImmichClient;
  #config: DashboardConfig;

  #queue: PhotoRef[] = [];
  /** Ids served recently, so a small library does not repeat immediately. */
  #recent = new Set<string>();
  #refilling = false;
  #lastRefillAt = 0;

  constructor(client: ImmichClient, config: DashboardConfig) {
    this.#client = client;
    this.#config = config;
  }

  get size(): number {
    return this.#queue.length;
  }

  setConfig(config: DashboardConfig): void {
    const before = JSON.stringify(this.#config.immich);
    this.#config = config;
    if (JSON.stringify(config.immich) === before) return;

    // The sources changed, so everything queued is from the old selection.
    log.info('Photo sources changed — clearing the playlist');
    this.#queue = [];
    this.#recent.clear();
    this.#lastRefillAt = 0;
  }

  /**
   * Take the next `count` photos.
   *
   * Always returns immediately with whatever is buffered, and triggers a
   * background refill if running low — the panel must never block on Immich
   * mid-slideshow.
   */
  async take(count: number): Promise<PhotoRef[]> {
    const n = Math.max(1, Math.min(50, count));

    if (this.#queue.length < n) {
      // Nothing buffered at all: this is the first request after startup, so
      // waiting is correct — there is nothing to show otherwise.
      await this.#refill();
    } else if (this.#queue.length < LOW_WATER) {
      void this.#refill();
    }

    const out = this.#queue.splice(0, n);
    for (const photo of out) {
      this.#recent.add(photo.id);
    }

    // Bound the "recently shown" set, or it grows for as long as the panel
    // runs — which is weeks (docs/ROOMOS.md §2).
    if (this.#recent.size > TARGET * 3) {
      const excess = this.#recent.size - TARGET * 2;
      let i = 0;
      for (const id of this.#recent) {
        if (i++ >= excess) break;
        this.#recent.delete(id);
      }
    }

    return out;
  }

  async #refill(): Promise<void> {
    if (this.#refilling) return;
    if (!this.#client.enabled) return;

    const cfg = this.#config.immich;
    if (!cfg.enabled || cfg.sources.length === 0) return;

    const since = Date.now() - this.#lastRefillAt;
    if (since < MIN_REFILL_INTERVAL_MS && this.#queue.length > 0) return;

    this.#refilling = true;
    this.#lastRefillAt = Date.now();

    try {
      const perSource = Math.max(20, Math.ceil(TARGET / cfg.sources.length));
      const opts = {
        imagesOnly: cfg.imagesOnly,
        ...(cfg.maxAgeYears
          ? {
              takenAfter: new Date(
                Date.now() - cfg.maxAgeYears * 365.25 * 86_400_000,
              ).toISOString(),
            }
          : {}),
      };

      const batches = await Promise.all(
        cfg.sources.map((source) =>
          this.#client.fetchSource(source, perSource, opts).catch((err: unknown) => {
            // One failing source must not empty the slideshow — the others
            // still have photos.
            log.warn(`Source ${source.type} failed:`, err);
            return [] as PhotoRef[];
          }),
        ),
      );

      const seen = new Set(this.#queue.map((p) => p.id));
      const fresh: PhotoRef[] = [];

      for (const batch of batches) {
        for (const photo of batch) {
          if (seen.has(photo.id)) continue;
          seen.add(photo.id);
          // Skip anything shown recently — but only while we have plenty of
          // alternatives. On a small album, repeating beats running dry.
          if (this.#recent.has(photo.id) && fresh.length < TARGET) continue;
          fresh.push(photo);
        }
      }

      // If every candidate was recently shown the library is smaller than the
      // recent set. Allow repeats rather than showing nothing.
      if (fresh.length === 0) {
        this.#recent.clear();
        for (const batch of batches) fresh.push(...batch);
      }

      shuffle(fresh);
      this.#queue.push(...fresh);

      log.info(
        `Playlist refilled: +${fresh.length} photos (${this.#queue.length} queued; ` +
          `${describeShapes(fresh)})`,
      );
    } finally {
      this.#refilling = false;
    }
  }
}

/**
 * Summarise the shapes in a batch, for the refill log.
 *
 * Portrait pairing depends entirely on knowing each photo's shape, and when
 * it silently does nothing there is no way to tell from the outside whether
 * the library has no portraits, or the dimensions never arrived, or the
 * pairing itself is broken. One line in the log distinguishes all three.
 *
 * `unsized` is the interesting number: it means Immich reported no usable
 * dimensions, so nothing downstream can reason about orientation.
 */
function describeShapes(photos: PhotoRef[]): string {
  let portrait = 0;
  let landscape = 0;
  let unsized = 0;

  for (const p of photos) {
    if (!p.w || !p.h) unsized += 1;
    else if (p.w / p.h <= 1) portrait += 1;
    else landscape += 1;
  }

  return `${portrait} portrait, ${landscape} landscape, ${unsized} unsized`;
}

/** Fisher-Yates. Interleaves sources properly, which sorting by random does not. */
function shuffle<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = items[i] as T;
    const b = items[j] as T;
    items[i] = b;
    items[j] = a;
  }
}
