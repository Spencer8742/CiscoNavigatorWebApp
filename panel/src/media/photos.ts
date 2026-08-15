import { signal } from '@preact/signals';
import { Lru } from '~/lib/lru.ts';
import { getToken } from '~/net/auth.ts';
import { requestPhotos } from '~/net/socket.ts';
import type { PhotoRef } from '@shared/protocol.ts';

/**
 * The slideshow engine: fetch, preload, decode, advance.
 *
 * Everything here exists to make the crossfade never show a partially loaded
 * image, on a device that will kill the whole web view if we hold too many
 * bitmaps (docs/ROOMOS.md §2).
 *
 * ## Why `decode()` and not `onload`
 *
 * `onload` fires when the bytes have arrived, not when the bitmap is ready.
 * Starting a crossfade there means the first frames can show a half-drawn or
 * blank image while the decoder catches up — on this CPU, visibly.
 * `img.decode()` resolves only once the frame is ready to paint, so the fade
 * starts on a complete picture every time.
 *
 * ## Why the cache is small
 *
 * Six `preview`-sized images is roughly 36 MB of decoded bitmap. That is
 * already a meaningful share of an unpublished budget whose overrun kills the
 * app, and a slideshow only ever needs the current image plus the next two.
 * Eviction sets `src = ''` as well as dropping the reference — without that
 * the browser's own image cache can keep the decoded frame alive.
 */

/** Current, next, next-but-one, plus a little slack for going backwards. */
const CACHE_SIZE = 6;
/** Refill the queue when fewer than this remain. */
const LOW_WATER = 8;
/** Ask for this many at a time. */
const BATCH = 24;

export const currentPhoto = signal<PhotoRef | null>(null);
export const nextPhoto = signal<PhotoRef | null>(null);
/** True once at least one image is decoded and ready to show. */
export const photosReady = signal(false);
/** Set when the backend has no photos to give — shown in the UI. */
export const photosEmpty = signal(false);

const cache = new Lru<string, HTMLImageElement>(CACHE_SIZE, (_id, img) => {
  // Both halves matter: dropping the reference alone leaves the decoded
  // bitmap alive in the browser's image cache.
  img.src = '';
  img.removeAttribute('src');
});

let queue: PhotoRef[] = [];
let fetching = false;
let index = -1;
/** Photos already served, kept so "previous" works within a session. */
const history: PhotoRef[] = [];

export function photoUrl(id: string, size: 'grid' | 'full'): string {
  const token = getToken();
  return `/img/${encodeURIComponent(id)}?s=${size}${token ? `&t=${encodeURIComponent(token)}` : ''}`;
}

/**
 * Load and decode an image, resolving only when it is ready to paint.
 *
 * Returns null on failure rather than throwing: one unreadable photo must
 * skip, not stop the slideshow.
 */
async function load(ref: PhotoRef): Promise<HTMLImageElement | null> {
  const hit = cache.get(ref.id);
  if (hit) return hit;

  const img = new Image();
  img.decoding = 'async';
  img.src = photoUrl(ref.id, 'full');

  try {
    await img.decode();
  } catch {
    // Broken image, or the element was evicted mid-flight.
    return null;
  }

  cache.set(ref.id, img);
  return img;
}

async function fill(): Promise<void> {
  if (fetching) return;
  fetching = true;
  try {
    const photos = await requestPhotos(BATCH);
    if (photos.length === 0) {
      photosEmpty.value = queue.length === 0 && history.length === 0;
      return;
    }
    photosEmpty.value = false;
    queue.push(...photos);
  } finally {
    fetching = false;
  }
}

/** Preload the next one or two without blocking anything. */
function preloadAhead(): void {
  const upcoming = queue.slice(0, 2);
  for (const ref of upcoming) void load(ref);
}

/**
 * Advance to the next photo.
 *
 * Resolves once the new image is decoded, so the caller can start a
 * crossfade knowing there is a complete picture to fade to.
 */
export async function advance(): Promise<void> {
  if (queue.length < LOW_WATER) void fill();

  if (queue.length === 0) {
    await fill();
    if (queue.length === 0) return;
  }

  // Skip anything that will not decode, but do not spin forever on a
  // library where every image is broken.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const ref = queue.shift();
    if (!ref) break;

    const img = await load(ref);
    if (!img) continue;

    history.push(ref);
    if (history.length > CACHE_SIZE * 4) history.shift();
    index = history.length - 1;

    currentPhoto.value = ref;
    nextPhoto.value = queue[0] ?? null;
    photosReady.value = true;
    preloadAhead();
    return;
  }
}

/** Step back through photos already shown this session. */
export async function previous(): Promise<void> {
  if (index <= 0) return;
  const ref = history[index - 1];
  if (!ref) return;
  const img = await load(ref);
  if (!img) return;
  index -= 1;
  currentPhoto.value = ref;
}

/** Grid photos for the Photos screen — separate from the slideshow queue. */
export async function fetchGrid(count: number): Promise<PhotoRef[]> {
  return requestPhotos(count);
}

/**
 * Release every decoded bitmap.
 *
 * Called when the screensaver stops. The slideshow is the only part of this
 * app that holds tens of megabytes, and it should not hold them while the
 * user is doing something else — especially since Home Assistant state,
 * artwork and the UI all want memory at the same time.
 */
export function releaseImages(): void {
  cache.clear();
  photosReady.value = false;
}

/** Diagnostics for the Settings screen. */
export function photoStats(): { cached: number; queued: number } {
  return { cached: cache.size, queued: queue.length };
}

/** Reset when the photo config changes under us. */
export function resetPlaylist(): void {
  queue = [];
  history.length = 0;
  index = -1;
  cache.clear();
  currentPhoto.value = null;
  nextPhoto.value = null;
  photosReady.value = false;
  photosEmpty.value = false;
}
