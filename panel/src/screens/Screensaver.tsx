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
import {
  advance,
  currentPhoto,
  currentSlide,
  photoUrl,
  photosEmpty,
  photosReady,
  releaseImages,
  setPairing,
} from '~/media/photos.ts';
import {
  defaultPlayerId,
  nowPlaying,
  speakers,
  weather,
  type SpeakerInfo,
} from '~/state/selectors.ts';
import { Icon } from '~/components/Icon.tsx';
import { Progress } from '~/components/Progress.tsx';
import { getToken } from '~/net/auth.ts';
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
  const all = speakers.value;
  const preferred = all.find((speaker) => speaker.id === defaultPlayerId.value);
  const player =
    (preferred?.state === 'playing' && preferred.media ? preferred : undefined) ??
    all.find((speaker) => speaker.state === 'playing' && !speaker.syncedTo && speaker.media) ??
    all.find((speaker) => speaker.state === 'playing' && speaker.media);

  if (player?.media) return <PlayingScreensaver player={player} />;
  return <PhotoScreensaver />;
}

/** Music takes over the idle screen while Sonos is actively playing. */
function PlayingScreensaver({ player }: { player: SpeakerInfo }) {
  const media = player.media;
  const d = now.value;
  const t = timeOpts.value;
  const token = getToken();
  const [artFailed, setArtFailed] = useState(false);
  const art = media?.art;
  const artUrl = art ? `${art}${token ? `&t=${encodeURIComponent(token)}` : ''}` : null;

  useEffect(() => setArtFailed(false), [art]);

  return (
    <div class="saver saver-now-playing">
      {artUrl && !artFailed ? (
        <img class="saver-np-backdrop" src={artUrl} alt="" aria-hidden="true" />
      ) : null}
      <div class="saver-np-shade" />

      <div class="saver-np-layout">
        <div class="saver-np-art" data-empty={!artUrl || artFailed ? '' : undefined}>
          {artUrl && !artFailed ? (
            <img
              key={artUrl}
              src={artUrl}
              alt={media?.title ?? 'Album artwork'}
              decoding="async"
              onError={() => setArtFailed(true)}
            />
          ) : (
            <Icon name="media" size="6rem" weight={1.1} />
          )}
        </div>

        <div class="saver-np-info">
          <div class="saver-np-clock tnum">
            {formatTime(d, t)}
            {ui.value.clock === '12h' ? (
              <span class="saver-np-meridiem">{formatMeridiem(d, t)}</span>
            ) : null}
          </div>
          <div class="saver-np-date">{formatDate(d, t)}</div>

          <div class="saver-np-track">
            <div class="saver-np-title">{media?.title ?? 'Now playing'}</div>
            {media?.artist ? <div class="saver-np-artist">{media.artist}</div> : null}
            {media?.album ? <div class="saver-np-album">{media.album}</div> : null}
          </div>

          {media?.duration ? (
            <Progress
              class="saver-np-progress"
              elapsed={media.elapsed}
              elapsedAt={media.elapsedAt}
              duration={media.duration}
              running
            />
          ) : null}

          <div class="saver-np-room">
            <Icon name="speaker" size="1.1rem" weight={1.7} />
            <span class="truncate">Playing on {player.name}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function PhotoScreensaver() {
  const cfg = idleConfig.value;
  const immich = immichConfig.value;
  const t = timeOpts.value;
  const d = now.value;

  const photo = currentPhoto.value;
  const slide = currentSlide.value;
  const ready = photosReady.value;

  /** Which of the two layers is currently on top. */
  const [front, setFront] = useState(0);
  const layers = useRef<(PhotoRef[] | null)[]>([null, null]);
  /** Corner index for the overlay, changed per photo to spread wear. */
  const [corner, setCorner] = useState(0);

  // Kick the slideshow off and keep it advancing.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    setPairing(immich.pairPortraits);

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
  }, [immich.intervalSeconds, immich.pairPortraits]);

  // Swap layers whenever a new slide is ready.
  useEffect(() => {
    if (slide.length === 0) return;
    const back = front === 0 ? 1 : 0;
    if (layers.current[front]?.[0]?.id === slide[0]?.id) return;
    layers.current[back] = slide;
    setFront(back);
    if (cfg.burnInProtection) setCorner((c) => (c + 1) % 4);
  }, [slide]);

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
        const refs = layers.current[i];
        const paired = (refs?.length ?? 0) > 1;
        return (
          <div
            key={i}
            class="saver-layer"
            data-front={i === front && ready ? '' : undefined}
            data-paired={paired ? '' : undefined}
            style={{ transitionDuration: `${immich.transitionMs}ms` }}
          >
            {(refs ?? []).map((ref) => (
              <img
                key={ref.id}
                class="saver-photo"
                src={photoUrl(ref.id, 'full')}
                alt=""
                decoding="async"
                style={{
                  // A paired portrait gets half the screen, which is close to
                  // its own aspect ratio — so it can fill without losing
                  // anything worth keeping. Alone, it must be contained or
                  // the crop eats the subject.
                  objectFit: paired || ref.w > ref.h ? 'cover' : 'contain',
                }}
              />
            ))}
          </div>
        );
      })}

      <div class="saver-overlays" data-corner={corner}>
        <SaverClock d={d} t={t} cfg={cfg} corner={corner} big />

        {cfg.overlays.photoInfo && photo ? <PhotoCaption photos={slide} t={t} /> : null}
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

/**
 * One caption for the whole slide.
 *
 * With two photos there are two dates and two places, and printing all four
 * turns a quiet corner label into a paragraph. Duplicates collapse — a pair
 * from the same afternoon in the same city reads as one line, which is the
 * common case — and anything genuinely different is joined rather than
 * dropped, because silently captioning one photo with the other's location
 * would be worse than saying nothing.
 */
function PhotoCaption({ photos, t }: { photos: PhotoRef[]; t: TimeOpts }) {
  const unique = (values: (string | undefined)[]): string[] => [
    ...new Set(values.filter((v): v is string => Boolean(v))),
  ];

  const when = unique(photos.map((p) => (p.taken ? formatPhotoDate(p.taken, t) : undefined)));
  const place = unique(
    photos.map((p) => [p.city, p.country].filter(Boolean).join(', ') || undefined),
  );

  if (when.length === 0 && place.length === 0) return null;

  return (
    <div class="saver-caption">
      {when.length ? <span class="tnum">{when.join(' · ')}</span> : null}
      {when.length && place.length ? <span class="saver-dot">·</span> : null}
      {place.length ? <span class="truncate">{place.join(' · ')}</span> : null}
    </div>
  );
}
