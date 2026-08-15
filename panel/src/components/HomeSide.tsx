import { useEffect, useState } from 'preact/hooks';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { entity } from '~/state/entities.ts';
import { anythingPlaying, defaultPlayerId } from '~/state/selectors.ts';
import { attrString, friendlyName } from '~/domains/registry.ts';
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
  const hasPlayers = mediaConfig.value.players.length > 0;
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
  const state = entity(id).value;
  if (!state) return null;

  const title = attrString(state, 'media_title') ?? friendlyName(state, id);
  const artist = attrString(state, 'media_artist') ?? attrString(state, 'app_name') ?? '';
  const playing = state.s === 'playing';

  const picture = attrString(state, 'entity_picture');
  const token = getToken();
  // Artwork is proxied: Home Assistant's media URLs are relative to HA and
  // need its credentials, which the panel does not have.
  const art = picture
    ? `/img/ha?u=${encodeURIComponent(picture)}${token ? `&t=${encodeURIComponent(token)}` : ''}`
    : null;

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

/** A photo from the rotation. Tapping it starts the slideshow. */
function PhotoCard() {
  const [photo, setPhoto] = useState<PhotoRef | null>(null);

  useEffect(() => {
    let cancelled = false;
    // One photo, not a batch: this is a peek, and the slideshow keeps its own
    // queue. Asking for more would pull images nobody is going to look at.
    void fetchGrid(1).then((batch) => {
      if (!cancelled) setPhoto(batch[0] ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
        // The average colour holds the space before the image decodes, so the
        // card never appears as an empty hole on a cold start.
        style={{ background: thumbHashCss(photo?.th) }}
      >
        {photo ? (
          <img src={photoUrl(photo.id, 'grid')} alt="" decoding="async" loading="lazy" />
        ) : null}
        <div class="photo-peek-label">
          <Icon name="play" size="1rem" />
          <span>Slideshow</span>
        </div>
      </Pressable>
    </section>
  );
}
