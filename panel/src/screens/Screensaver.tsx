import { useEffect, useRef, useState } from 'preact/hooks';
import { idleConfig, immichConfig, timeOpts, ui } from '~/config/index.ts';
import { now } from '~/state/clock.ts';
import {
  formatDate,
  formatMeridiem,
  formatPhotoDate,
  formatTime,
  type TimeOpts,
} from '~/lib/format.ts';
import { thumbHashCss } from '~/lib/thumbhash.ts';
import { advance, currentPhoto, photoUrl, photosEmpty, photosReady, releaseImages } from '~/media/photos.ts';
import { nowPlaying, weather } from '~/state/selectors.ts';
import { Icon } from '~/components/Icon.tsx';
import type { PhotoRef } from '@shared/protocol.ts';

/**
 * The photo screensaver.
 *
 * ## Crossfade
 *
 * Two stacked `<img>` layers whose opacity swaps. Only `opacity` animates, so
 * the whole transition is a compositor operation — no layout, no repaint
 * (docs/ROOMOS.md §2). The incoming layer is only made visible after
 * `media/photos.ts` has *decoded* the image, so a fade never reveals a
 * half-drawn frame.
 *
 * ## Burn-in
 *
 * The panel is an IPS LCD, so burn-in risk is far lower than OLED — but this
 * thing runs for months with a clock in the same place. Overlay elements
 * therefore drift slowly (transform only) and take a new corner on each photo
 * change, so nothing static ever sits in one spot for long.
 *
 * ## Waking
 *
 * Any touch exits, handled by the global activity listener in `state/idle.ts`
 * rather than here — so a tap anywhere wakes the panel, including on the
 * overlays.
 */
export function Screensaver() {
  const cfg = idleConfig.value;
  const immich = immichConfig.value;
  const t = timeOpts.value;
  const d = now.value;

  const photo = currentPhoto.value;
  const ready = photosReady.value;

  /** Which of the two layers is currently on top. */
  const [front, setFront] = useState(0);
  const layers = useRef<(PhotoRef | null)[]>([null, null]);
  /** Corner index for the overlay, changed per photo to spread wear. */
  const [corner, setCorner] = useState(0);

  // Kick the slideshow off and keep it advancing.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const step = async (): Promise<void> => {
      if (cancelled) return;
      await advance();
      if (cancelled) return;
      timer = setTimeout(() => void step(), Math.max(5, immich.intervalSeconds) * 1000);
    };

    void step();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      // Hand back the decoded bitmaps. The dashboard needs the memory more
      // than a slideshow nobody is watching.
      releaseImages();
    };
  }, [immich.intervalSeconds]);

  // Swap layers whenever a new photo is ready.
  useEffect(() => {
    if (!photo) return;
    const back = front === 0 ? 1 : 0;
    if (layers.current[front]?.id === photo.id) return;
    layers.current[back] = photo;
    setFront(back);
    if (cfg.burnInProtection) setCorner((c) => (c + 1) % 4);
  }, [photo?.id]);

  if (immich.enabled && photosEmpty.value) {
    return (
      <div class="saver saver-empty">
        <div class="saver-message">
          <Icon name="photos" size="2.5rem" weight={1.4} />
          <div>No photos available from Immich</div>
        </div>
        <SaverClock d={d} t={t} cfg={cfg} corner={0} />
      </div>
    );
  }

  // With Immich off, the screensaver is a clock — which is a perfectly good
  // thing for a wall panel to be, and better than refusing to idle at all.
  if (!immich.enabled) {
    return (
      <div class="saver saver-clock-only">
        <SaverClock d={d} t={t} cfg={cfg} corner={corner} big />
      </div>
    );
  }

  return (
    <div
      class="saver"
      // The average colour of the incoming photo, so the very first frame is
      // never black and a slow fetch never shows an empty screen.
      style={{ background: thumbHashCss(photo?.th) }}
    >
      {[0, 1].map((i) => {
        const ref = layers.current[i];
        return (
          <img
            key={i}
            class="saver-layer"
            data-front={i === front && ready ? '' : undefined}
            src={ref ? photoUrl(ref.id, 'full') : undefined}
            alt=""
            decoding="async"
            style={{
              transitionDuration: `${immich.transitionMs}ms`,
              // Portrait photos on a landscape panel look wrong cropped, so
              // they are contained; landscape fills.
              objectFit: ref && ref.h > ref.w ? 'contain' : 'cover',
            }}
          />
        );
      })}

      <div class="saver-overlays" data-corner={corner}>
        <SaverClock d={d} t={t} cfg={cfg} corner={corner} big />

        {cfg.overlays.photoInfo && photo ? <PhotoCaption photo={photo} t={t} /> : null}
      </div>
    </div>
  );
}

function SaverClock({
  d,
  t,
  cfg,
  corner,
  big,
}: {
  d: Date;
  t: TimeOpts;
  cfg: typeof idleConfig.value;
  corner: number;
  big?: boolean;
}) {
  const wx = weather.value;
  const playing = nowPlaying.value;

  return (
    <div class={big ? 'saver-info saver-info-big' : 'saver-info'} data-corner={corner}>
      {cfg.overlays.clock ? (
        <div class="saver-time tnum">
          {formatTime(d, t)}
          {ui.value.clock === '12h' ? (
            <span class="saver-meridiem">{formatMeridiem(d, t)}</span>
          ) : null}
        </div>
      ) : null}

      {cfg.overlays.date ? <div class="saver-date">{formatDate(d, t)}</div> : null}

      <div class="saver-row">
        {cfg.overlays.weather && wx && !wx.unavailable ? (
          <span class="saver-chip">
            <Icon name={wx.icon} size="1.1rem" weight={1.6} />
            {wx.value}
          </span>
        ) : null}

        {cfg.overlays.nowPlaying && playing ? (
          <span class="saver-chip truncate">
            <Icon name="media" size="1.1rem" weight={1.6} />
            {playing}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function PhotoCaption({ photo, t }: { photo: PhotoRef; t: TimeOpts }) {
  const place = [photo.city, photo.country].filter(Boolean).join(', ');
  const when = photo.taken ? formatPhotoDate(photo.taken, t) : '';
  if (!place && !when) return null;

  return (
    <div class="saver-caption">
      {when ? <span class="tnum">{when}</span> : null}
      {when && place ? <span class="saver-dot">·</span> : null}
      {place ? <span class="truncate">{place}</span> : null}
    </div>
  );
}
