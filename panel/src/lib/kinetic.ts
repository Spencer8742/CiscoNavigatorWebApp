import type { RefObject } from 'preact';
import { useEffect } from 'preact/hooks';

/**
 * Drag-to-scroll with momentum, for a list the panel's web engine will not
 * fling on its own.
 *
 * On the Room Navigator a swipe moves an overflow list exactly as far as the
 * finger travelled and stops dead on release — no glide — so a list longer
 * than a few rows takes a dozen swipes to get through. This takes the gesture
 * over: the list follows the finger, then keeps going at the release speed
 * and eases to a stop, the way a phone list does.
 *
 * The element needs `touch-action: none` (so the browser hands the whole
 * gesture to these pointer events instead of starting its own pan and
 * cancelling them). The wheel and scrollbar are untouched.
 *
 * At either end of the list the rest of the drag goes to the nearest
 * scrolling ancestor, so a swipe that runs out of list still moves the page.
 *
 * Taps are left alone: nothing happens until the finger has moved past
 * `SLOP_PX`, which is below Pressable's own slop, so a Join inside the list
 * still gets its press — and a drag that crosses it cancels that press the
 * normal way.
 */

const SLOP_PX = 6;
/** Per-millisecond decay; ~0.3 s of noticeable glide from a brisk swipe. */
const FRICTION = 0.995;
/** Below this (px/ms) the glide is over. */
const MIN_VELOCITY = 0.02;
/** Only the last stretch of the drag decides the release speed. */
const VELOCITY_WINDOW_MS = 100;

/**
 * `mounted` is whatever decides whether the element exists, so the listeners
 * follow it in and out of the tree.
 */
export function useKineticScroll(ref: RefObject<HTMLElement>, mounted: boolean): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let pointer: number | null = null;
    let startY = 0;
    let lastY = 0;
    let dragging = false;
    let samples: { t: number; y: number }[] = [];
    let frame = 0;

    const stopGlide = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };

    /** Scroll by `dy`, passing what the list cannot take to the page. */
    const scrollBy = (dy: number): boolean => {
      const before = el.scrollTop;
      el.scrollTop = before + dy;
      const taken = el.scrollTop - before;
      const rest = dy - taken;
      if (Math.abs(rest) >= 1) {
        const outer = scrollingAncestor(el);
        if (outer) {
          const o = outer.scrollTop;
          outer.scrollTop = o + rest;
          return taken !== 0 || outer.scrollTop !== o;
        }
      }
      return taken !== 0;
    };

    const onDown = (e: PointerEvent) => {
      if (pointer !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      stopGlide();
      pointer = e.pointerId;
      startY = lastY = e.clientY;
      dragging = false;
      samples = [{ t: e.timeStamp, y: e.clientY }];
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      if (!dragging && Math.abs(e.clientY - startY) < SLOP_PX) return;
      dragging = true;
      scrollBy(lastY - e.clientY);
      lastY = e.clientY;
      samples.push({ t: e.timeStamp, y: e.clientY });
      const cutoff = e.timeStamp - VELOCITY_WINDOW_MS;
      while (samples.length > 2 && samples[0]!.t < cutoff) samples.shift();
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      if (!dragging) return;
      dragging = false;

      const first = samples[0]!;
      const last = samples[samples.length - 1]!;
      const dt = last.t - first.t;
      // Held still before letting go: no fling.
      if (dt <= 0 || e.timeStamp - last.t > 60) return;
      let velocity = (first.y - last.y) / dt; // px/ms, positive scrolls down

      let prev = performance.now();
      const step = (now: number) => {
        const elapsed = Math.min(now - prev, 50);
        prev = now;
        velocity *= FRICTION ** elapsed;
        if (Math.abs(velocity) < MIN_VELOCITY || !scrollBy(velocity * elapsed)) {
          frame = 0;
          return;
        }
        frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    };

    const onCancel = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      pointer = null;
      dragging = false;
    };

    // Capture phase: a Join button inside the list captures its pointer, and
    // the drag has to be seen before that retargets anything.
    el.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    return () => {
      stopGlide();
      el.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
    };
  }, [ref, mounted]);
}

function scrollingAncestor(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight) {
      const y = getComputedStyle(node).overflowY;
      if (y === 'auto' || y === 'scroll') return node;
    }
  }
  return null;
}
