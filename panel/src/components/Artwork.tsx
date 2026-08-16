import { useEffect, useState } from 'preact/hooks';
import { Icon } from '~/components/Icon.tsx';
import { getToken } from '~/net/auth.ts';

/**
 * Cover art, with a glyph when there is none — or when it fails to load.
 *
 * The fallback is the point. Artwork comes from whatever provider Music
 * Assistant pulled it from, and a browser's broken-image icon on a wall panel
 * reads as "this app is broken" rather than "this album has no cover". Every
 * place that draws a cover therefore shares this one component, so the
 * fallback cannot be forgotten in one of them.
 *
 * `loading="lazy"` matters more here than anywhere else in the app: a page is
 * sixty covers, and decoding sixty images at once on this hardware is a
 * visible stall on a screen the user is trying to scroll.
 */
export function Artwork({
  src,
  icon = 'media',
  alt = '',
}: {
  /** Already-proxied path on this origin, or null. */
  src: string | null | undefined;
  icon?: string;
  alt?: string;
}) {
  const [failed, setFailed] = useState(false);
  const token = getToken();

  // A new cover deserves a fresh attempt; without this a single failure
  // would poison the slot for every track that scrolls through it.
  useEffect(() => setFailed(false), [src]);

  if (!src || failed) {
    return (
      <div class="browse-cover is-empty">
        <Icon name={icon} size="1.3rem" weight={1.6} />
      </div>
    );
  }

  return (
    <div class="browse-cover">
      <img
        src={`${src}${token ? `&t=${encodeURIComponent(token)}` : ''}`}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
