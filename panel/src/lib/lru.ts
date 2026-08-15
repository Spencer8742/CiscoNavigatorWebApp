/**
 * A bounded LRU map with an eviction hook.
 *
 * This exists because of docs/ROOMOS.md §2: the RoomOS web engine has an
 * unpublished memory ceiling and the web view is TERMINATED when it is
 * exceeded. On a panel that is expected to run for weeks, an unbounded cache
 * is not a slow leak — it is a crash, on a wall-mounted device with no back
 * button.
 *
 * Every cache in this application uses this class. If you find yourself
 * reaching for a plain Map or array that grows with time, that is the bug.
 *
 * The `onEvict` hook matters as much as the bound: for decoded images,
 * dropping the reference is not enough — the eviction handler clears `src` so
 * the image cache can actually release the bitmap.
 */
export class Lru<K, V> {
  readonly #max: number;
  readonly #map = new Map<K, V>();
  readonly #onEvict: ((key: K, value: V) => void) | undefined;

  constructor(max: number, onEvict?: (key: K, value: V) => void) {
    if (max < 1) throw new RangeError('Lru requires max >= 1');
    this.#max = max;
    this.#onEvict = onEvict;
  }

  get size(): number {
    return this.#map.size;
  }

  has(key: K): boolean {
    return this.#map.has(key);
  }

  /** Reading promotes the entry to most-recently-used. */
  get(key: K): V | undefined {
    const v = this.#map.get(key);
    if (v === undefined) return undefined;
    // Re-insert to move to the end of Map's insertion order.
    this.#map.delete(key);
    this.#map.set(key, v);
    return v;
  }

  /** Peek without affecting recency. */
  peek(key: K): V | undefined {
    return this.#map.get(key);
  }

  set(key: K, value: V): void {
    if (this.#map.has(key)) this.#map.delete(key);
    this.#map.set(key, value);

    while (this.#map.size > this.#max) {
      // Map iteration order is insertion order, so the first key is the LRU.
      const oldest = this.#map.keys().next();
      if (oldest.done) break;
      const k = oldest.value;
      const v = this.#map.get(k) as V;
      this.#map.delete(k);
      this.#onEvict?.(k, v);
    }
  }

  delete(key: K): boolean {
    const v = this.#map.get(key);
    if (v === undefined && !this.#map.has(key)) return false;
    this.#map.delete(key);
    this.#onEvict?.(key, v as V);
    return true;
  }

  clear(): void {
    for (const [k, v] of this.#map) this.#onEvict?.(k, v);
    this.#map.clear();
  }

  keys(): IterableIterator<K> {
    return this.#map.keys();
  }
}
