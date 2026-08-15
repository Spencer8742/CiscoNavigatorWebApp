import { timeOpts, ui, homeConfig } from '~/config/index.ts';
import { now } from '~/state/clock.ts';
import { formatDate, formatMeridiem, formatTime } from '~/lib/format.ts';
import { Empty } from '~/components/Empty.tsx';

/**
 * Home.
 *
 * Phase 1 renders the hero (clock, date) and honest empty states for the
 * sections that need Home Assistant. Favourites, scenes, status readouts and
 * alerts arrive in phases 3-4 and slot into the placeholders below without
 * changing this layout.
 */
export function Home() {
  const t = timeOpts.value;
  const d = now.value;
  const cfg = homeConfig.value;
  const hasAnything =
    cfg.favorites.length > 0 || cfg.scenes.length > 0 || cfg.status.length > 0;

  return (
    <div class="screen screen-enter">
      <div class="home-hero">
        <div class="home-time tnum">
          {formatTime(d, t)}
          {ui.value.clock === '12h' ? (
            <span class="home-meridiem">{formatMeridiem(d, t)}</span>
          ) : null}
        </div>
        <div class="home-date">{formatDate(d, t)}</div>
      </div>

      <div class="screen-body scroll">
        {hasAnything ? (
          <Empty icon="link" title="Waiting for Home Assistant">
            Your dashboard is configured with {cfg.favorites.length} favourites and{' '}
            {cfg.scenes.length} scenes. Live entity state arrives in phase 2 — the
            connection dot in the navigation shows the current link status.
          </Empty>
        ) : (
          <Empty icon="settings" title="No dashboard configured yet">
            Copy <code>config/dashboard.example.yaml</code> to{' '}
            <code>config/dashboard.yaml</code> and list the entities you want here.
            The file is watched, so saving it updates this screen without a reload.
          </Empty>
        )}
      </div>
    </div>
  );
}
