import { useEffect, useState } from 'preact/hooks';
import { immichConfig, timeOpts } from '~/config/index.ts';
import { Empty } from '~/components/Empty.tsx';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { fetchGrid, photoUrl } from '~/media/photos.ts';
import { thumbHashCss } from '~/lib/thumbhash.ts';
import { formatPhotoDate } from '~/lib/format.ts';
import { screensaverActive, markActivity, immichError } from '~/state/ui.ts';
import type { PhotoRef } from '@shared/protocol.ts';

/**
 * Photos — a grid of the same playlist the screensaver draws from, plus a
 * full-screen viewer.
 *
 * Deliberately modest. The panel is a control surface, not a photo manager:
 * there is no album browser, no search, no infinite scroll, because none of
 * those are things you do standing at a wall. What it is for is "show me
 * what's in the rotation" and "start the slideshow now".
 *
 * Every tile is a `grid`-sized thumbnail (~250 px). The viewer uses `full`
 * (~1440 px). Nothing here can request an original — see
 * `server/src/immich/images.ts`.
 */
export function Photos() {
  const cfg = immichConfig.value;
  const [photos, setPhotos] = useState<PhotoRef[] | null>(null);
  const [viewing, setViewing] = useState<PhotoRef | null>(null);

  useEffect(() => {
    if (!cfg.enabled) return;
    let cancelled = false;
    void fetchGrid(48).then((result) => {
      if (!cancelled) setPhotos(result);
    });
    return () => {
      cancelled = true;
    };
  }, [cfg.enabled, cfg.sources]);

  if (!cfg.enabled) {
    return (
      <div class="screen screen-enter">
        <div class="screen-head">
          <h1 class="screen-title">Photos</h1>
        </div>
        <div class="screen-body">
          <Empty icon="photos" title="Immich is not enabled">
            Set <code>immich.enabled: true</code> in <code>dashboard.yaml</code>, and
            provide <code>IMMICH_URL</code> and <code>IMMICH_API_KEY</code> in the
            server's environment.
          </Empty>
        </div>
      </div>
    );
  }

  return (
    <div class="screen screen-enter">
      <div class="screen-head">
        <h1 class="screen-title">Photos</h1>
        <Pressable
          class="photos-play"
          onPress={() => {
            markActivity();
            // Start the slideshow on demand rather than waiting to go idle.
            screensaverActive.value = true;
          }}
          ariaLabel="Start slideshow"
        >
          <Icon name="play" size="1.1rem" />
          <span>Slideshow</span>
        </Pressable>
      </div>

      <div class="screen-body scroll">
        {photos === null ? (
          <div class="photos-loading">
            <span class="spinner" />
          </div>
        ) : photos.length === 0 ? (
          immichError.value ? (
            // The backend knows exactly what went wrong. Saying "check your
            // config" when the server could say "API key rejected" or
            // "cannot reach http://…" is a wasted opportunity — nobody is
            // going to read container logs to interpret a wall panel.
            <Empty icon="alert" title="Immich could not be queried">
              {immichError.value}
            </Empty>
          ) : (
            <Empty icon="photos" title="No photos returned">
              Immich answered, but no photos matched. Check{' '}
              <code>immich.sources</code> in <code>dashboard.yaml</code> —
              with <code>imagesOnly: true</code> a library of only videos
              matches nothing.
            </Empty>
          )
        ) : (
          <div class="photo-grid">
            {photos.map((photo) => (
              <Pressable
                key={photo.id}
                as="div"
                class="photo-tile p-lg"
                onPress={() => setViewing(photo)}
                ariaLabel="Photo"
                // The average colour holds the tile's place before the
                // thumbnail arrives, so the grid never flashes as a lattice
                // of empty boxes while scrolling.
                style={{ background: thumbHashCss(photo.th) }}
              >
                <img src={photoUrl(photo.id, 'grid')} alt="" loading="lazy" decoding="async" />
              </Pressable>
            ))}
          </div>
        )}
      </div>

      {viewing ? <Viewer photo={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}

function Viewer({ photo, onClose }: { photo: PhotoRef; onClose: () => void }) {
  const t = timeOpts.value;
  const place = [photo.city, photo.country].filter(Boolean).join(', ');
  const when = photo.taken ? formatPhotoDate(photo.taken, t) : '';

  return (
    <div class="viewer" onPointerDown={onClose} style={{ background: thumbHashCss(photo.th) }}>
      <img
        src={photoUrl(photo.id, 'full')}
        alt=""
        decoding="async"
        style={{ objectFit: photo.h > photo.w ? 'contain' : 'contain' }}
      />
      {when || place ? (
        <div class="viewer-caption">
          {when ? <span class="tnum">{when}</span> : null}
          {when && place ? <span class="saver-dot">·</span> : null}
          {place ? <span>{place}</span> : null}
        </div>
      ) : null}
      <Pressable class="viewer-close p-sm" onPress={onClose} ariaLabel="Close">
        <Icon name="close" size="1.4rem" weight={2} />
      </Pressable>
    </div>
  );
}
