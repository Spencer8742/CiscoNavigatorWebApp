import { Icon } from '~/components/Icon.tsx';

const BRANDS: Array<[RegExp, string]> = [
  [/youtube\s*tv|youtubetv/i, 'youtubetv'],
  [/youtube\s*music|youtubemusic/i, 'youtubemusic'],
  [/youtube/i, 'youtube'],
  [/apple\s*music|tvmusic/i, 'applemusic'],
  [/podcasts?|applepodcasts/i, 'applepodcasts'],
  [/apple\s*tv|tvwatchlist/i, 'appletv'],
  [/paramount/i, 'paramountplus'],
  [/crunchyroll/i, 'crunchyroll'],
  [/netflix/i, 'netflix'],
  [/(^|[.\s])max($|[.\s])|hbomax/i, 'max'],
  [/spotify/i, 'spotify'],
  [/twitch/i, 'twitch'],
  [/vimeo/i, 'vimeo'],
  [/plex/i, 'plex'],
];

export function AppleTvServiceLogo({ name, bundleId }: { name: string; bundleId: string }) {
  const value = `${name} ${bundleId}`;
  const brand = BRANDS.find(([pattern]) => pattern.test(value))?.[1];
  if (!brand) return <Icon name="grid" size="3rem" />;
  return <img class="apple-tv-service-logo" src={`/app-logos/${brand}.svg`} alt="" aria-hidden="true" />;
}
