import { useRef, useCallback } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';

/**
 * The press primitive every touchable surface in the app is built on.
 *
 * Getting this right is most of the difference between "a web page on a
 * touchscreen" and "a control panel", so it is worth being explicit about
 * what it does that a plain `<button onClick>` does not:
 *
 * 1. **Feedback within one frame.** The pressed state is applied by writing
 *    an attribute directly on the DOM node in the `pointerdown` handler —
 *    not by setting component state and waiting for a render. On a CPU that
 *    RoomOS deprioritises behind the video pipeline, a render round trip is
 *    the difference between "instant" and "laggy". The visual change is a
 *    `transform: scale()` and an opacity swap, both compositor-only.
 *
 * 2. **Pointer Events keyed by `pointerId`.** Cisco warns that touch event
 *    ordering is not stable and that you must track touches by identifier
 *    (docs/ROOMOS.md §6). Pointer Events give us that for free, and
 *    `setPointerCapture` means a finger that slides off the element still
 *    delivers its `pointerup` here.
 *
 * 3. **Activation on release, with a slop radius.** Firing on `pointerdown`
 *    would make scrolling a list toggle every light it passes under. We
 *    activate on `pointerup` only if the finger stayed within ~14 px, which
 *    is the same heuristic native scroll views use.
 *
 * 4. **No 300 ms delay, no double-tap zoom, no grey flash.** Handled by
 *    `touch-action: manipulation` and `-webkit-tap-highlight-color` in
 *    base.css rather than a blanket `preventDefault` on `document`, which
 *    Cisco specifically warns breaks form elements.
 */

const SLOP_PX = 14;

export interface PressableProps {
  onPress?: () => void;
  /** Fired after ~550 ms held. Used to open entity detail sheets. */
  onLongPress?: () => void;
  disabled?: boolean;
  class?: string;
  children?: ComponentChildren;
  /** Rendered element. Defaults to `button`. */
  as?: 'button' | 'div';
  ariaLabel?: string;
  ariaPressed?: boolean;
  style?: JSX.CSSProperties | string;
  /**
   * Styling hook, rendered as `data-tone`.
   *
   * A real prop rather than a `data-tone` attribute written at the call site:
   * this is a component, not an intrinsic element, so an unknown attribute is
   * not forwarded to the DOM — it is silently dropped. Answer and Hang up
   * were written that way and rendered as two identical grey keys, which on a
   * call control is the one place you cannot afford a guess.
   */
  tone?: 'accent' | 'danger' | 'ok';
}

export function Pressable({
  onPress,
  onLongPress,
  disabled = false,
  class: cls = '',
  children,
  as = 'button',
  ariaLabel,
  ariaPressed,
  style,
  tone,
}: PressableProps) {
  const el = useRef<HTMLElement | null>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const longTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const longFired = useRef(false);

  const setPressed = useCallback((on: boolean) => {
    // Direct DOM write, deliberately bypassing the render cycle. See (1).
    const node = el.current;
    if (!node) return;
    if (on) node.setAttribute('data-pressed', '');
    else node.removeAttribute('data-pressed');
  }, []);

  const end = useCallback(() => {
    clearTimeout(longTimer.current);
    longTimer.current = undefined;
    start.current = null;
    setPressed(false);
  }, [setPressed]);

  const onPointerDown = useCallback(
    (e: JSX.TargetedPointerEvent<HTMLElement>) => {
      if (disabled) return;
      // Ignore secondary buttons and additional fingers on an already-held
      // control — the first pointer owns the interaction.
      if (e.button !== 0 || start.current) return;

      start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
      longFired.current = false;
      setPressed(true);

      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported for this pointer — slide-off just cancels */
      }

      if (onLongPress) {
        longTimer.current = setTimeout(() => {
          longFired.current = true;
          setPressed(false);
          onLongPress();
        }, 550);
      }
    },
    [disabled, onLongPress, setPressed],
  );

  const onPointerMove = useCallback(
    (e: JSX.TargetedPointerEvent<HTMLElement>) => {
      const s = start.current;
      if (!s || s.id !== e.pointerId) return;
      const moved = Math.abs(e.clientX - s.x) > SLOP_PX || Math.abs(e.clientY - s.y) > SLOP_PX;
      if (moved) {
        // The user is scrolling, not tapping. Release the visual state and
        // cancel activation, but let the scroll continue uninterrupted.
        end();
      }
    },
    [end],
  );

  const onPointerUp = useCallback(
    (e: JSX.TargetedPointerEvent<HTMLElement>) => {
      const s = start.current;
      end();
      if (disabled || !s || s.id !== e.pointerId || longFired.current) return;
      const moved = Math.abs(e.clientX - s.x) > SLOP_PX || Math.abs(e.clientY - s.y) > SLOP_PX;
      if (!moved) onPress?.();
    },
    [disabled, end, onPress],
  );

  const shared = {
    ref: el as never,
    class: `pressable ${cls}`,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: end,
    onClick: (e: JSX.TargetedMouseEvent<HTMLElement>) => {
      // Pointer activation already happened on release. Keyboard/AT clicks have no detail.
      if (e.detail === 0 && !disabled) onPress?.();
    },
    onKeyDown: (e: JSX.TargetedKeyboardEvent<HTMLElement>) => {
      if (as !== 'div' || disabled || e.repeat) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onPress?.();
      }
    },
    'aria-label': ariaLabel,
    'data-tone': tone,
    /*
     * Styling hook, on BOTH element types.
     *
     * `:disabled` only exists on a real `<button>`, so a disabled row rendered
     * as a div had no way to look disabled — it stayed fully lit while
     * refusing to respond, which reads as a broken panel rather than an
     * unavailable one. One attribute both can be styled by.
     */
    'data-disabled': disabled ? '' : undefined,
    'aria-disabled': disabled ? true : undefined,
    style,
  };

  if (as === 'div') {
    return (
      <div {...shared} role="button" tabIndex={disabled ? -1 : 0} aria-pressed={ariaPressed}>
        {children}
      </div>
    );
  }

  return (
    <button {...shared} type="button" disabled={disabled} aria-pressed={ariaPressed}>
      {children}
    </button>
  );
}
