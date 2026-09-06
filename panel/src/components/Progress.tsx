import { useEffect, useState } from 'preact/hooks';
import { Slider } from '~/components/Slider.tsx';
import { formatDuration } from '~/lib/format.ts';

/**
 * Track position, and a way to move it.
 *
 * ## Why the position is computed here rather than pushed
 *
 * A speaker reports its position only when something changes.
 * Forwarding that would mean a message per second per speaker, waking the
 * panel's render loop continuously to move a bar a pixel — on a device whose
 * CPU sits behind a video pipeline and which is meant to idle into a
 * screensaver.
 *
 * So the backend sends the elapsed time *and the moment it was measured*, and
 * this component extrapolates: position = elapsed + (now − measuredAt). It
 * ticks locally at 1 Hz while playing and stops entirely when paused. The
 * result is a bar that moves smoothly on almost no traffic, and which
 * re-anchors exactly whenever a real update does arrive.
 */
export function Progress({
  elapsed,
  elapsedAt,
  duration,
  running,
  onSeek,
  class: cls = '',
}: {
  elapsed: number | null;
  elapsedAt: number | null;
  duration: number;
  running: boolean;
  onSeek?: (seconds: number) => void;
  class?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  /** Set while a finger is on the bar, so ticks cannot fight the drag. */
  const [scrubbing, setScrubbing] = useState<number | null>(null);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const base = elapsed ?? 0;
  const drift = running && elapsedAt ? Math.max(0, (now - elapsedAt) / 1000) : 0;
  const position = scrubbing ?? Math.min(duration, base + drift);

  return (
    <div class={`np-progress ${cls}`}>
      <span class="np-time">{formatDuration(Math.round(position))}</span>
      {onSeek ? (
        <Slider
          value={Math.round(position)}
          min={0}
          max={Math.round(duration)}
          step={1}
          ariaLabel="Track position"
          readout={formatDuration(Math.round(position))}
          onChange={(v, final) => {
            if (final) {
              setScrubbing(null);
              onSeek(v);
            } else {
              setScrubbing(v);
            }
          }}
        />
      ) : (
        <div
          class="np-progress-track"
          role="progressbar"
          aria-label="Track position"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(position)}
        >
          <div
            class="np-progress-fill"
            style={{ transform: `scaleX(${duration > 0 ? position / duration : 0})` }}
          />
        </div>
      )}
      <span class="np-time">{formatDuration(Math.round(duration))}</span>
    </div>
  );
}
