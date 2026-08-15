import { immichConfig } from '~/config/index.ts';
import { Empty } from '~/components/Empty.tsx';

/**
 * Photos — the Immich gallery, and the source of the screensaver slideshow.
 *
 * Built in phases 6-7. Every image on this screen is served through the
 * backend's /img proxy at an explicitly chosen thumbnail size; there is no
 * code path that can request an Immich original (docs/ARCHITECTURE.md §7).
 */
export function Photos() {
  const cfg = immichConfig.value;

  return (
    <div class="screen screen-enter">
      <div class="screen-head">
        <h1 class="screen-title">Photos</h1>
      </div>
      <div class="screen-body">
        {!cfg.enabled ? (
          <Empty icon="photos" title="Immich is not enabled">
            Set <code>immich.enabled: true</code> in{' '}
            <code>config/dashboard.yaml</code>, and provide{' '}
            <code>IMMICH_URL</code> and <code>IMMICH_API_KEY</code> in the
            server's environment.
          </Empty>
        ) : (
          <Empty icon="photos" title="Gallery arrives in phase 6">
            {cfg.sources.length}{' '}
            {cfg.sources.length === 1 ? 'source is' : 'sources are'} configured.
          </Empty>
        )}
      </div>
    </div>
  );
}
