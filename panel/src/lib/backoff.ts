/**
 * Exponential backoff with full jitter.
 *
 * Jitter is not cosmetic here. After a power cut the Navigator, the backend,
 * Home Assistant and Immich all come back within a few seconds of each other.
 * Without jitter every client retries in lockstep, hammering a service that is
 * still starting up and pushing everyone into the next, longer, synchronised
 * retry. Full jitter (`random() * delay`, not `delay ± random`) spreads the
 * herd properly — see AWS's "Exponential Backoff and Jitter".
 */
export interface BackoffOptions {
  /** Delay for the first retry, before jitter. */
  baseMs?: number;
  /** Ceiling for the computed delay, before jitter. */
  maxMs?: number;
  /** Multiplier per attempt. */
  factor?: number;
}

export class Backoff {
  readonly #base: number;
  readonly #max: number;
  readonly #factor: number;
  #attempt = 0;

  constructor({ baseMs = 500, maxMs = 30_000, factor = 2 }: BackoffOptions = {}) {
    this.#base = baseMs;
    this.#max = maxMs;
    this.#factor = factor;
  }

  get attempt(): number {
    return this.#attempt;
  }

  /** Milliseconds to wait before the next attempt. Advances the counter. */
  next(): number {
    const capped = Math.min(this.#max, this.#base * this.#factor ** this.#attempt);
    this.#attempt += 1;
    // Full jitter: uniform in [0, capped]. Floored so we never busy-loop.
    return Math.max(100, Math.round(Math.random() * capped));
  }

  /** Call after a successful connection that stayed up. */
  reset(): void {
    this.#attempt = 0;
  }
}
