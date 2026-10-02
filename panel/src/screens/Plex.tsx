import { PlexBrowser } from '~/components/PlexBrowser.tsx';
import { appleTvs, selectedAppleTv } from '~/state/controls.ts';

/**
 * Plex, as its own destination.
 *
 * "Play on" offers first whatever was last picked on the Apple TV screen — an
 * Apple TV or an IINA Mac — or the first Apple TV when nobody has picked yet.
 * `preferred` is a Plex target id.
 */
export function Plex() {
  const selected = selectedAppleTv.value ?? appleTvs.value[0]?.id ?? null;
  const preferred = selected === null ? null
    : selected.startsWith('iina:') ? `mac:${selected.slice(5)}` : `atv:${selected}`;
  return (
    <div class="screen screen-enter">
      <div class="screen-head">
        <h1 class="screen-title">Plex</h1>
      </div>
      <div class="screen-body scroll">
        <PlexBrowser preferred={preferred} />
      </div>
    </div>
  );
}
