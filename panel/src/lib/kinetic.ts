/**
 * Drag-to-scroll with momentum, for every scrolling list in the app.
 *
 * On the Room Navigator a swipe moves an overflow list exactly as far as the
 * finger travelled and stops dead on release — no glide — so any list longer
 * than a screen takes a dozen swipes to get through and reads as jerky. This
 * takes the gesture over: the list follows the finger, then keeps going at
 * the release speed and eases to a stop, the way a phone list does.
 *
 * It started as a hook on the Desk Pro meeting list alone. It is installed
 * once, on the document, instead: a drag is matched to whichever element it
 * starts in that can scroll in the drag's direction, so a new list gets the
 * same feel without anybody remembering to opt it in.
 *
 * Scroll containers carry `touch-action: none` (see `.scroll` in base.css),
 * so the browser hands the whole gesture to these pointer events instead of
 * starting its own pan and cancelling them. The wheel is untouched.
 *
 * **Things that own their drag are left alone.** A slider, the Apple TV swipe
 * pad and the reveal corner all declare `touch-action: none` themselves; a
 * drag that starts inside one of those, before any scroller is reached, is
 * theirs, not the list's. Form fields are skipped the same way.
 *
 * At either end of a list the rest of the drag goes to the next scrolling
 * ancestor in the same direction, so a swipe that runs out of list still
 * moves the page.
 *
 * Taps are left alone: nothing happens until the finger has moved past
 * `SLOP_PX`, which is below Pressable's own slop, so a key inside a list
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

type Axis = 'x' | 'y';

/** Install once, at start-up. Returns an uninstaller, for tests. */
export function installKineticScroll(): () => void {
  let pointer: number | null = null;
  let target: Element | null = null;
  let startX = 0;
  let startY = 0;
  let last = 0;
  let axis: Axis | null = null;
  let scroller: HTMLElement | null = null;
  let samples: { t: number; p: number }[] = [];
  let frame = 0;

  const stopGlide = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };

  const reset = () => {
    pointer = null;
    target = null;
    axis = null;
    scroller = null;
  };

  const onDown = (e: PointerEvent) => {
    if (pointer !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    // A touch on a gliding list stops it, as on a phone.
    stopGlide();
    pointer = e.pointerId;
    target = e.target instanceof Element ? e.target : null;
    startX = e.clientX;
    startY = e.clientY;
    axis = null;
    scroller = null;
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;

    if (!axis) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SLOP_PX) return;
      axis = Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x';
      scroller = target ? findScroller(target, axis) : null;
      if (!scroller) {
        // Not a scroll: a slider, a swipe pad, or nothing that can move this
        // way. Stop watching until the next finger.
        reset();
        return;
      }
      last = axis === 'y' ? startY : startX;
      samples = [{ t: e.timeStamp, p: last }];
    }

    const p = axis === 'y' ? e.clientY : e.clientX;
    scrollChain(scroller!, axis, last - p);
    last = p;
    samples.push({ t: e.timeStamp, p });
    const cutoff = e.timeStamp - VELOCITY_WINDOW_MS;
    while (samples.length > 2 && samples[0]!.t < cutoff) samples.shift();
  };

  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    const el = scroller;
    const dir = axis;
    reset();
    if (!el || !dir) return;

    const first = samples[0]!;
    const end = samples[samples.length - 1]!;
    const dt = end.t - first.t;
    // Held still before letting go: no fling.
    if (dt <= 0 || e.timeStamp - end.t > 60) return;
    let velocity = (first.p - end.p) / dt; // px/ms, positive scrolls forward

    let prev = performance.now();
    const step = (now: number) => {
      const elapsed = Math.min(now - prev, 50);
      prev = now;
      velocity *= FRICTION ** elapsed;
      if (Math.abs(velocity) < MIN_VELOCITY || !scrollChain(el, dir, velocity * elapsed)) {
        frame = 0;
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  };

  const onCancel = (e: PointerEvent) => {
    if (e.pointerId === pointer) reset();
  };

  // Capture phase: a key inside a list captures its pointer, and the drag
  // has to be seen before that retargets anything.
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
  return () => {
    stopGlide();
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
  };
}

/**
 * Scroll `el` by `delta` along `axis`, passing what it cannot take to the
 * next scroller out. True when anything moved.
 */
function scrollChain(el: HTMLElement, axis: Axis, delta: number): boolean {
  let moved = false;
  let rest = delta;
  for (let node: HTMLElement | null = el; node && Math.abs(rest) >= 0.5; ) {
    const before = position(node, axis);
    setPosition(node, axis, before + rest);
    const taken = position(node, axis) - before;
    if (taken !== 0) moved = true;
    rest -= taken;
    node = Math.abs(rest) >= 1 ? nextScroller(node, axis) : null;
  }
  return moved;
}

/**
 * The element a drag starting at `from` should scroll, or null when the drag
 * belongs to something else.
 */
function findScroller(from: Element, axis: Axis): HTMLElement | null {
  for (let node: Element | null = from; node; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    if (canScroll(node, axis)) return node;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)) return null;
    // A control that declares it owns its touches: a slider, a swipe pad.
    // Scroll containers declare it too — so they can be driven from here —
    // and a vertical drag in a sideways shelf must carry on up to the page.
    const style = getComputedStyle(node);
    if (style.touchAction === 'none' && !isScrollContainer(style)) return null;
  }
  return null;
}

function nextScroller(el: HTMLElement, axis: Axis): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (canScroll(node, axis)) return node;
  }
  return null;
}

function canScroll(el: HTMLElement, axis: Axis): boolean {
  const overflows =
    axis === 'y' ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1;
  if (!overflows) return false;
  const style = getComputedStyle(el);
  const value = axis === 'y' ? style.overflowY : style.overflowX;
  return value === 'auto' || value === 'scroll';
}

function isScrollContainer(style: CSSStyleDeclaration): boolean {
  return /auto|scroll/.test(style.overflowX) || /auto|scroll/.test(style.overflowY);
}

function position(el: HTMLElement, axis: Axis): number {
  return axis === 'y' ? el.scrollTop : el.scrollLeft;
}

function setPosition(el: HTMLElement, axis: Axis, value: number): void {
  if (axis === 'y') el.scrollTop = value;
  else el.scrollLeft = value;
}
