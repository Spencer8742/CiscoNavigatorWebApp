import { PlexBrowser } from '~/components/PlexBrowser.tsx';
import { appleTvs, selectedAppleTv } from '~/state/controls.ts';

/**
 * Plex, as its own destination.
 *
 * "Play on" still offers an Apple TV first: the one last picked on the Apple
 * TV screen, or the first configured one when nobody has picked yet.
 */
export function Plex() {
  const preferred = selectedAppleTv.value ?? appleTvs.value[0]?.id ?? null;
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
