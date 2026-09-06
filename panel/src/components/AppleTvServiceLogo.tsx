import type { SimpleIcon } from 'simple-icons';
import {
  siApplemusic,
  siApplepodcasts,
  siAppletv,
  siCrunchyroll,
  siMax,
  siNetflix,
  siParamountplus,
  siPlex,
  siSpotify,
  siTwitch,
  siVimeo,
  siYoutube,
  siYoutubemusic,
  siYoutubetv,
} from 'simple-icons';
import { Icon } from '~/components/Icon.tsx';

const BRANDS: Array<[RegExp, SimpleIcon]> = [
  [/youtube\s*tv|youtubetv/i, siYoutubetv],
  [/youtube\s*music|youtubemusic/i, siYoutubemusic],
  [/youtube/i, siYoutube],
  [/apple\s*music|tvmusic/i, siApplemusic],
  [/podcasts?|applepodcasts/i, siApplepodcasts],
  [/apple\s*tv|tvwatchlist/i, siAppletv],
  [/paramount/i, siParamountplus],
  [/crunchyroll/i, siCrunchyroll],
  [/netflix/i, siNetflix],
  [/(^|[.\s])max($|[.\s])|hbomax/i, siMax],
  [/spotify/i, siSpotify],
  [/twitch/i, siTwitch],
  [/vimeo/i, siVimeo],
  [/plex/i, siPlex],
];

export function AppleTvServiceLogo({ name, bundleId }: { name: string; bundleId: string }) {
  const value = `${name} ${bundleId}`;
  const brand = BRANDS.find(([pattern]) => pattern.test(value))?.[1];
  if (!brand) return <Icon name="grid" size="3rem" />;

  // Black brand marks disappear on the dashboard surface. White preserves
  // the official silhouette while every other service keeps its brand color.
  const color = brand.hex === '000000' ? '#ffffff' : `#${brand.hex}`;
  return (
    <svg
      class="apple-tv-service-logo"
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ color }}
    >
      <path fill="currentColor" d={brand.path} />
    </svg>
  );
}
