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

/**
 * Three slides' worth: previous (still fading out), current, and next.
 *
 * Six is not slack — with portrait pairing a slide is up to two images, so
 * this is exactly 3 × 2. The arithmetic only works because `preloadAhead`
 * predicts the next slide's actual pairing: fetch the wrong photos and the
 * inserts evict a photo that is still on screen, clearing its `src`
 * mid-crossfade.
 */
const CACHE_SIZE = 6;
/** Refill the queue when fewer than this remain. */
const LOW_WATER = 8;
/** Ask for this many at a time. */
const BATCH = 24;

export const currentPhoto = signal<PhotoRef | null>(null);
export const nextPhoto = signal<PhotoRef | null>(null);
/**
 * What the screensaver should draw right now: one photo, or two portraits
 * side by side.
 *
 * `currentPhoto` remains the first of them, so everything else that reads it
 * (captions, average-colour background) keeps working unchanged.
 */
export const currentSlide = signal<PhotoRef[]>([]);
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
/** The in-flight batch, shared so concurrent callers await the same one. */
let inFlight: Promise<void> | null = null;
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
  if (hit) {
    backfillSize(ref, hit);
    return hit;
  }

  const img = new Image();
  img.decoding = 'async';
  img.src = photoUrl(ref.id, 'full');

  try {
    await img.decode();
  } catch {
    // Broken image, or the element was evicted mid-flight.
    return null;
  }

  backfillSize(ref, img);
  cache.set(ref.id, img);
  return img;
}

/**
 * Fetch the next batch, coalescing concurrent callers.
 *
 * The subtlety is in what a second caller gets. Returning early while a fetch
 * is in flight makes `await fill()` a no-op for that caller — so `advance()`
 * would find the queue still empty, give up, and wait a whole interval before
 * trying again. On the screensaver that is a blank screen for `intervalSeconds`
 * on every cold start. Sharing the in-flight promise means the second caller
 * waits for the same batch and then has photos, which is what it asked for.
 */
async function fill(): Promise<void> {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const photos = await requestPhotos(BATCH);
      if (photos.length === 0) {
        photosEmpty.value = queue.length === 0 && history.length === 0;
        return;
      }
      photosEmpty.value = false;
      queue.push(...photos);
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Preload exactly the next slide, without blocking anything.
 *
 * It has to predict the pairing rather than simply take the next two from the
 * queue: a partner may come from several places further along, so "the next
 * two" can be the wrong two. Getting it wrong is not just a missed
 * optimisation — it fills the cache with images the next slide will not use,
 * and evicting to make room for the ones it does use can clear the `src` of a
 * photo still fading out on screen.
 *
 * Preloading precisely keeps occupancy at previous + current + next, which is
 * what CACHE_SIZE is sized for.
 */
function preloadAhead(): void {
  for (const ref of peekNextSlide()) void load(ref);
}

/**
 * Whether a photo is tall enough to be worth pairing.
 *
 * Anything at least as tall as it is wide qualifies, squares included. Each
 * half of a 16:9 panel is about 0.8 wide-to-tall, so a square loses roughly a
 * fifth of its width to the crop — worth it, because the alternative is a
 * third of the screen showing nothing.
 *
 * Dimensions come from the backend already corrected for EXIF orientation;
 * without that a phone-shot portrait reports landscape numbers and never
 * pairs. See `displayDimensions` in server/src/immich/client.ts.
 */
function isPortrait(ref: PhotoRef): boolean {
  return ref.w > 0 && ref.h > 0 && ref.w / ref.h <= 1;
}

/**
 * Fill in dimensions Immich did not supply, from the decoded image.
 *
 * Some assets genuinely have no EXIF size — screenshots and a few formats.
 * Those would never pair, since shape is unknowable from metadata alone. The
 * decoded bitmap knows, and it is authoritative: it is the rotated render
 * that will actually be displayed.
 */
function backfillSize(ref: PhotoRef, img: HTMLImageElement): void {
  if (ref.w > 0 && ref.h > 0) return;
  if (!img.naturalWidth || !img.naturalHeight) return;
  ref.w = img.naturalWidth;
  ref.h = img.naturalHeight;
}

/** Whether pairing is on. Read at advance() time so config edits take effect. */
let pairingEnabled = true;
export function setPairing(on: boolean): void {
  pairingEnabled = on;
}

/**
 * How far past the next photo to look for a portrait to pair with.
 *
 * In a mixed library portraits are scattered, so the immediately following
 * photo is usually landscape — strict adjacency would almost never pair
 * anything. Bounded so a long landscape stretch costs nothing.
 */
const LOOKAHEAD = 6;

/** Index in `queue` of a partner for `ref`, or -1. Pure: does not mutate. */
function partnerIndexFor(ref: PhotoRef, from = 0): number {
  if (!pairingEnabled || !isPortrait(ref)) return -1;

  const limit = Math.min(from + LOOKAHEAD, queue.length);
  for (let i = from; i < limit; i += 1) {
    const candidate = queue[i];
    if (candidate && isPortrait(candidate)) return i;
  }
  return -1;
}

/** Find a partner for a portrait photo, and take it out of the queue. */
function takePartnerFor(ref: PhotoRef): PhotoRef | null {
  const i = partnerIndexFor(ref);
  if (i < 0) return null;
  const [partner] = queue.splice(i, 1);
  return partner ?? null;
}

/** What the next slide will be, without consuming anything. */
function peekNextSlide(): PhotoRef[] {
  const first = queue[0];
  if (!first) return [];
  // The partner search starts past the head, which advance() will have
  // consumed by then.
  const i = partnerIndexFor(first, 1);
  const partner = i >= 0 ? queue[i] : undefined;
  return partner ? [first, partner] : [first];
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

    // A portrait fills about a third of a 16:9 panel. Pair it with another
    // portrait so the rest is photo instead of filler.
    const partner = takePartnerFor(ref);
    // Both halves must be decoded before the crossfade starts, or the
    // collage assembles itself on screen one photo at a time. If the partner
    // will not decode, fall back to showing this one alone — a single
    // contained portrait is a worse layout, not a broken one.
    const slide = partner && (await load(partner)) ? [ref, partner] : [ref];

    history.push(ref);
    if (history.length > CACHE_SIZE * 4) history.shift();
    index = history.length - 1;

    currentPhoto.value = ref;
    currentSlide.value = slide;
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
  // History records the photos shown, not how they were laid out, so going
  // back shows this one on its own rather than re-guessing a pairing.
  currentSlide.value = [ref];
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
  currentSlide.value = [];
  nextPhoto.value = null;
  photosReady.value = false;
  photosEmpty.value = false;
}
