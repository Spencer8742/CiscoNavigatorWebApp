import type { JSX } from 'preact';
import { useCallback, useRef, useState } from 'preact/hooks';
import { revealed } from '~/state/ui.ts';

/**
 * The way back into a finished panel.
 *
 * Once Settings is hidden and the nav has collapsed, there is no control on
 * screen that can undo either — which is the point, and which would also be a
 * brick if there were no gesture. Hold this corner and both come back.
 *
 * **Two seconds, not the 550 ms `Pressable` uses.** This is on a wall in a
 * room with people in it; a gesture that fires from a lean or a passing hand
 * would undo the lock at random. Two seconds is long enough that it only
 * happens on purpose, and the ring makes the wait legible rather than making
 * somebody guess whether it is working.
 *
 * **It is a dead zone**, and that is the honest cost: 44 px in the top-right
 * swallow taps that would otherwise reach whatever is under them. Mounted
 * ONLY while something is actually hidden, so a panel with its nav and
 * Settings visible has no dead corner at all — and 44 px over the corner of a
 * large key still leaves most of the key. Top-right because the nav is on the
 * left or the bottom, so this is the one corner neither layout puts a
 * destination in.
 */

/** Long enough that a lean cannot do it; short enough to not feel broken. */
const HOLD_MS = 2000;
/** A drifting finger is not a deliberate hold. */
const SLOP_PX = 16;

export function RevealCorner() {
  const [progress, setProgress] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ramp = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);

  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    clearTimeout(ramp.current);
    timer.current = undefined;
    ramp.current = undefined;
    start.current = null;
    setProgress(0);
  }, []);

  const onPointerDown = useCallback(
    (e: JSX.TargetedPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || start.current) return;
      start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };

      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported — sliding off still cancels via pointermove */
      }

      // A frame later, so the transition has a start value to animate FROM.
      // Setting it synchronously would jump straight to full.
      ramp.current = setTimeout(() => setProgress(1), 30);
      timer.current = setTimeout(() => {
        cancel();
        revealed.value = true;
      }, HOLD_MS);
    },
    [cancel],
  );

  const onPointerMove = useCallback(
    (e: JSX.TargetedPointerEvent<HTMLElement>) => {
      const s = start.current;
      if (!s || s.id !== e.pointerId) return;
      if (Math.abs(e.clientX - s.x) > SLOP_PX || Math.abs(e.clientY - s.y) > SLOP_PX) cancel();
    },
    [cancel],
  );

  return (
    <div
      class="reveal-corner"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      role="button"
      aria-label="Hold to show settings"
    >
      <span
        class="reveal-ring"
        data-filling={progress ? '' : undefined}
        style={{ transitionDuration: `${HOLD_MS}ms` }}
      />
    </div>
  );
}
