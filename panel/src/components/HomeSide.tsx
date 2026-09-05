import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { anythingPlaying, defaultPlayerId, speakers } from '~/state/selectors.ts';
import { fetchGrid, photoUrl } from '~/media/photos.ts';
import { thumbHashCss } from '~/lib/thumbhash.ts';
import { getToken } from '~/net/auth.ts';
import { immichConfig, mediaConfig } from '~/config/index.ts';
import { prefs, route, screensaverActive, markActivity } from '~/state/ui.ts';
import * as act from '~/state/actions.ts';
import type { PhotoRef } from '@shared/protocol.ts';

/**
 * The card beside Favorites on the Home screen.
 *
 * A wall panel with three favourites and a 16:9 screen has a lot of nothing
 * on it. This fills that with the two things worth glancing at: what is
 * playing, and a photo.
 *
 * Which one shows is a preference (Settings → Home screen). When `media` is
 * chosen and nothing is playing it falls through to the photo rather than
 * rendering an empty box — leaving a hole would defeat the point of the card
 * existing.
 */
export function HomeSide() {
  const wantsMedia = prefs.value.homeSide === 'media';
  // Speakers come from Sonos now, so "do we have any" is a question
  // about what MA reported rather than about what dashboard.yaml listed.
  const hasPlayers = speakers.value.length > 0;
  const photosOn = immichConfig.value.enabled;

  if (wantsMedia && hasPlayers && anythingPlaying.value) return <NowPlayingCard />;
  if (photosOn) return <PhotoCard />;
  // Nothing configured to show: render nothing at all rather than an empty
  // frame, so the favourites simply use the full width.
  if (wantsMedia && hasPlayers) return <NowPlayingCard />;
  return null;
}

/** Artwork, title, and transport — the parts you use without walking closer. */
function NowPlayingCard() {
  const id = defaultPlayerId.value;
  const player = speakers.value.find((s) => s.id === id);
  if (!player) return null;

  const media = player.media;
  const title = media?.title ?? player.name;
  const artist = media?.artist ?? '';
  const playing = player.state === 'playing';
  const token = getToken();
  // Already proxied by the backend — the panel never holds a speaker's
  // address. See server/src/http/media-art.ts.
  const art = media?.art ? `${media.art}${token ? `&t=${encodeURIComponent(token)}` : ''}` : null;

  return (
    <section class="side-card" aria-label="Now playing">
      <div class="side-head">
        <h2 class="section-title">Now Playing</h2>
        <Pressable
          class="side-more p-sm"
          onPress={() => {
            route.value = 'media';
            markActivity();
          }}
          ariaLabel="Open media"
        >
          <Icon name="next" size="1rem" weight={2} />
        </Pressable>
      </div>

      <div class="np-body">
        <div class="np-art">
          {art ? (
            <img src={art} alt="" decoding="async" />
          ) : (
            <div class="np-art-empty">
              <Icon name="media" size="2rem" weight={1.4} />
            </div>
          )}
        </div>

        <div class="np-meta">
          <div class="np-title truncate">{title}</div>
          {artist ? <div class="np-artist truncate">{artist}</div> : null}
        </div>

        <div class="np-transport">
          <Pressable class="np-btn p-md" onPress={() => act.mediaPrevious(id)} ariaLabel="Previous">
            <Icon name="prev" size="1.4rem" />
          </Pressable>
          <Pressable
            class="np-btn np-btn-primary p-md"
            onPress={() => act.mediaPlayPause(id)}
            ariaLabel={playing ? 'Pause' : 'Play'}
          >
            <Icon name={playing ? 'pause' : 'play'} size="1.6rem" />
          </Pressable>
          <Pressable class="np-btn p-md" onPress={() => act.mediaNext(id)} ariaLabel="Next">
            <Icon name="next" size="1.4rem" />
          </Pressable>
        </div>
      </div>
    </section>
  );
}


/**
 * How many photos to pull per request.
 *
 * Not one at a time. Each request consumes from the backend's shared
 * playlist, so asking every 15 seconds would churn it — and make the
 * screensaver refill far more often than it needs to. A dozen at a time turns
 * that into one request every few minutes.
 */
const PEEK_BATCH = 12;
/** The floor for a non-zero interval. Below this it is a flicker, not a card. */
const MIN_ROTATE_SECONDS = 5;

/**
 * A photo from the rotation, changed on a timer. Tapping it starts the
 * slideshow.
 *
 * Two stacked layers crossfaded on opacity, the same approach as the
 * screensaver and for the same reason: only `opacity` animates, so the
 * transition is a compositor operation rather than a repaint
 * (docs/ROOMOS.md §2). The incoming photo is revealed only after
 * `img.decode()` resolves, so a fade never starts on a half-drawn frame.
 */
function PhotoCard() {
  const cfg = immichConfig.value;
  const rotateMs =
    cfg.homeCardSeconds > 0 ? Math.max(MIN_ROTATE_SECONDS, cfg.homeCardSeconds) * 1000 : 0;

  const [layers, setLayers] = useState<(PhotoRef | null)[]>([null, null]);
  const [front, setFront] = useState(0);
  // The timer callback needs the current front index without re-running the
  // effect on every change, which would restart the rotation each time.
  const frontRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let queue: PhotoRef[] = [];
    /** Decoded bitmaps we are holding. Never more than the two on screen. */
    const held: HTMLImageElement[] = [];

    const drop = (img: HTMLImageElement | undefined): void => {
      if (!img) return;
      // Clearing src as well as dropping the reference — without it the
      // browser's image cache can keep the decoded frame alive.
      img.src = '';
      img.removeAttribute('src');
    };

    const show = async (): Promise<void> => {
      if (queue.length === 0) queue = await fetchGrid(PEEK_BATCH);
      if (cancelled) return;

      const ref = queue.shift();
      if (!ref) return; // Immich has nothing; the next tick tries again.

      const img = new Image();
      img.decoding = 'async';
      img.src = photoUrl(ref.id, 'grid');
      try {
        await img.decode();
      } catch {
        return; // One unreadable photo skips, it does not stop the rotation.
      }
      if (cancelled) {
        drop(img);
        return;
      }

      held.push(img);
      while (held.length > 2) drop(held.shift());

      const back = frontRef.current === 0 ? 1 : 0;
      setLayers((prev) => (back === 0 ? [ref, prev[1] ?? null] : [prev[0] ?? null, ref]));
      frontRef.current = back;
      setFront(back);
    };

    const tick = async (): Promise<void> => {
      await show();
      if (cancelled || rotateMs === 0) return;
      timer = setTimeout(() => void tick(), rotateMs);
    };
    void tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      // Leaving Home hands the memory back. The dashboard and the slideshow
      // both want it more than a card nobody is looking at.
      while (held.length) drop(held.shift());
    };
  }, [rotateMs, cfg.sources, cfg.enabled]);

  const current = layers[front] ?? null;

  return (
    <section class="side-card" aria-label="Photos">
      <div class="side-head">
        <h2 class="section-title">Photos</h2>
      </div>

      <Pressable
        as="div"
        class="photo-peek"
        onPress={() => {
          markActivity();
          screensaverActive.value = true;
        }}
        ariaLabel="Start slideshow"
        // The average colour holds the space before the first image decodes,
        // so the card never appears as an empty hole on a cold start.
        style={{ background: thumbHashCss(current?.th) }}
      >
        {[0, 1].map((i) => {
          const ref = layers[i];
          return ref ? (
            <img
              key={i}
              class="peek-layer"
              data-front={i === front ? '' : undefined}
              src={photoUrl(ref.id, 'grid')}
              alt=""
              decoding="async"
            />
          ) : null;
        })}
        <div class="photo-peek-label">
          <Icon name="play" size="1rem" />
          <span>Slideshow</span>
        </div>
      </Pressable>
    </section>
  );
}
