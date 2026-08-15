import { mediaConfig } from '~/config/index.ts';
import { Empty } from '~/components/Empty.tsx';

/**
 * Media — the Now Playing interface.
 *
 * Built in phase 5. Deliberately a dedicated screen rather than an entity
 * card: artwork-led, large transport controls, and a player switcher, closer
 * to a car head unit than to a Home Assistant media card.
 */
export function Media() {
  const cfg = mediaConfig.value;

  return (
    <div class="screen screen-enter">
      <div class="screen-head">
        <h1 class="screen-title">Media</h1>
      </div>
      <div class="screen-body">
        {cfg.players.length === 0 ? (
          <Empty icon="media" title="No media players configured">
            Add a <code>media:</code> section to <code>config/dashboard.yaml</code>{' '}
            listing your <code>media_player</code> entities.
          </Empty>
        ) : (
          <Empty icon="media" title="Now Playing arrives in phase 5">
            {cfg.players.length}{' '}
            {cfg.players.length === 1 ? 'player is' : 'players are'} configured and
            will appear here once Home Assistant connectivity and the entity
            controls are in place.
          </Empty>
        )}
      </div>
    </div>
  );
}
