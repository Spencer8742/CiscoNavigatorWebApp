import { useRef, useCallback, useEffect } from 'preact/hooks';
import type { JSX } from 'preact';

/**
 * The drag control everything else is built on: brightness, volume,
 * temperature, cover position, fan speed.
 *
 * This is the most performance-sensitive component in the app, so it breaks
 * the normal Preact rules on purpose:
 *
 * **It does not re-render while dragging.** The fill and thumb are moved by
 * writing `style.transform` directly on refs inside the pointermove handler.
 * A render per move event — up to 120/second — is exactly the "much work in
 * event handlers" Cisco warns against (docs/ROOMOS.md §2), and on a CPU
 * deprioritised behind a video pipeline it is the difference between the
 * thumb tracking your finger and lagging behind it.
 *
 * **The fill is `scaleX`, never `width`.** Animating width is a layout +
 * paint on every frame; `transform` is a compositor operation. Same visual
 * result, an order of magnitude cheaper. This is why the fill lives in its
 * own element with `transform-origin: left`.
 *
 * **`pointerId` is tracked explicitly.** Cisco documents that touch event
 * ordering is not stable and that identifiers must be used (docs/ROOMOS.md
 * §6); Pointer Events give that, and `setPointerCapture` keeps the drag alive
 * when a finger slides off the track — which happens constantly on a control
 * that is 3rem tall and 20rem wide.
 *
 * The parent is told about changes twice: continuously with `final=false`
 * (throttled downstream), and once on release with `final=true`, which is
 * guaranteed to carry the exact value the finger stopped on.
 */

export interface SliderProps {
  /** Current value, in `min`..`max`. */
  value: number;
  min?: number;
  max?: number;
  /** Rounding applied to emitted values. */
  step?: number;
  /** Called continuously while dragging, then once with final=true. */
  onChange: (value: number, final: boolean) => void;
  disabled?: boolean;
  /** Extra class for domain colouring (e.g. `slider-warm`). */
  class?: string;
  /** Shown above the track on the left. */
  icon?: JSX.Element;
  /** Shown above the track on the right — the current value. */
  readout?: string;
  ariaLabel?: string;
  /** Taller track for primary controls like brightness. */
  size?: 'md' | 'lg';
}

export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  disabled = false,
  class: cls = '',
  icon,
  readout,
  ariaLabel,
  size = 'md',
}: SliderProps) {
  const track = useRef<HTMLDivElement | null>(null);
  const fill = useRef<HTMLDivElement | null>(null);
  const pointer = useRef<number | null>(null);
  /** True while a finger owns this slider — suppresses prop-driven updates. */
  const dragging = useRef(false);

  const fraction = (v: number): number => {
    if (max === min) return 0;
    return Math.max(0, Math.min(1, (v - min) / (max - min)));
  };

  /**
   * `invertFill` scales from the far end instead, which the colour-temperature
   * slider uses: its track carries the full warm-to-cool ramp and the "fill"
   * is a scrim dimming the part you have not selected.
   */
  const invert = cls.includes('slider-temp');

  const paint = useCallback(
    (f: number) => {
      // Direct style write. No setState, no render.
      if (fill.current) fill.current.style.transform = `scaleX(${invert ? 1 - f : f})`;
    },
    [invert],
  );

  /*
   * Incoming state updates repaint the fill — but NEVER while dragging.
   *
   * Without that guard, Home Assistant's echo of a mid-drag command would
   * yank the fill back to a value the finger has already moved past, and the
   * slider would visibly stutter under the thumb.
   */
  useEffect(() => {
    if (!dragging.current) paint(fraction(value));
  });

  const valueAt = useCallback(
    (clientX: number): number => {
      const el = track.current;
      if (!el) return value;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0) return value;
      const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const raw = min + f * (max - min);
      return Math.round(raw / step) * step;
    },
    [min, max, step, value],
  );

  const onPointerDown = useCallback(
    (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
      if (disabled || pointer.current !== null || e.button !== 0) return;

      pointer.current = e.pointerId;
      dragging.current = true;

      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported; a slide-off will simply end the drag */
      }

      // Jump to the touched position immediately — a slider that requires you
      // to find the thumb first feels broken at this size.
      const next = valueAt(e.clientX);
      paint(fraction(next));
      onChange(next, false);
    },
    [disabled, valueAt, paint, onChange],
  );

  const onPointerMove = useCallback(
    (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
      if (pointer.current !== e.pointerId) return;
      const next = valueAt(e.clientX);
      paint(fraction(next));
      onChange(next, false);
    },
    [valueAt, paint, onChange],
  );

  const end = useCallback(
    (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
      if (pointer.current !== e.pointerId) return;
      pointer.current = null;
      dragging.current = false;

      // The one send that must not be throttled or dropped: wherever the
      // finger stopped is what the user meant.
      const next = valueAt(e.clientX);
      paint(fraction(next));
      onChange(next, true);
    },
    [valueAt, paint, onChange],
  );

  const cancel = useCallback(() => {
    pointer.current = null;
    dragging.current = false;
    paint(fraction(value));
  }, [paint, value]);

  return (
    <div
      class={`slider slider-${size} ${cls}`}
      data-disabled={disabled ? '' : undefined}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={disabled ? -1 : 0}
    >
      {/*
        The icon and value live ABOVE the track, not inside it.

        Inside looks tidier until you use it: the fill grows from the left, so
        a right-aligned readout sits on the fill at high values and on the bare
        track at low ones. No single colour is legible on both, and picking one
        makes the number vanish at one end of the range. Above the track it is
        always readable, at any value, on any of the fill styles.
      */}
      {icon || readout ? (
        <div class="slider-head">
          {icon ? <span class="slider-icon">{icon}</span> : null}
          {readout ? <span class="slider-readout tnum">{readout}</span> : null}
        </div>
      ) : null}

      <div
        class="slider-track"
        ref={track}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={cancel}
      >
        <div class="slider-fill" ref={fill} />
      </div>
    </div>
  );
}
