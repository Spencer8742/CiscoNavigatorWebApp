import { timeOpts, ui, homeConfig } from '~/config/index.ts';
import { now } from '~/state/clock.ts';
import { formatDate, formatMeridiem, formatTime } from '~/lib/format.ts';
import { Empty } from '~/components/Empty.tsx';
import { Icon } from '~/components/Icon.tsx';
import { EntityTile } from '~/components/EntityTile.tsx';
import { favorites, houseAlerts, sceneButtons, statusItems, weather } from '~/state/selectors.ts';
import { openEntity, markActivity } from '~/state/ui.ts';
import { Pressable } from '~/components/Pressable.tsx';
import { activate } from '~/state/actions.ts';
import { HomeSide } from '~/components/HomeSide.tsx';

/**
 * Home — the panel's resting face.
 *
 * Read from across a room, so the hierarchy is deliberate: the clock is the
 * only large element, alerts interrupt it when something needs attention, and
 * everything else is quiet until touched.
 *
 * Interactive controls arrive in the next phase. Tiles here already show live
 * state and open a detail sheet on tap.
 */
export function Home() {
  const t = timeOpts.value;
  const d = now.value;
  const cfg = homeConfig.value;

  const alerts = houseAlerts.value;
  const status = statusItems.value;
  const favs = favorites.value;
  const scenes = sceneButtons.value;
  const wx = weather.value;

  const configured =
    cfg.favorites.length > 0 ||
    cfg.scenes.length > 0 ||
    cfg.status.length > 0 ||
    cfg.alerts.length > 0;

  return (
    <div class="screen screen-enter">
      <div class="home-hero">
        <div class="home-hero-main">
          <div class="home-time tnum">
            {formatTime(d, t)}
            {ui.value.clock === '12h' ? (
              <span class="home-meridiem">{formatMeridiem(d, t)}</span>
            ) : null}
          </div>
          <div class="home-date">{formatDate(d, t)}</div>
        </div>

        {wx && !wx.unavailable ? (
          <div class="home-weather">
            <Icon name={wx.icon} size="2rem" weight={1.5} />
            <div class="home-weather-temp tnum">{wx.value}</div>
          </div>
        ) : null}
      </div>

      <div class="screen-body home-body scroll">
        {!configured ? (
          <Empty icon="settings" title="No dashboard configured yet">
            Copy <code>config/dashboard.example.yaml</code> to{' '}
            <code>config/dashboard.yaml</code> and list the entities you want here.
            The file is watched, so saving it updates this screen without a reload.
          </Empty>
        ) : null}

        {/* Alerts come first and only exist when something is wrong, so the
            screen is calm by default and impossible to ignore when it isn't. */}
        {alerts.length > 0 ? (
          <div class="alerts">
            {alerts.map((alert) => (
              <div class="alert" key={alert.entity}>
                <Icon name="alert" size="1.125rem" />
                <span class="truncate">{alert.label}</span>
              </div>
            ))}
          </div>
        ) : null}

        {status.length > 0 ? (
          <div class="status-strip">
            {status.map((item) => (
              <div class="status-item" key={item.id} data-unavailable={item.unavailable ? '' : undefined}>
                <div class="status-label truncate">{item.label}</div>
                <div class="status-value tnum truncate" data-tone={item.tone}>
                  {item.value}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {/* Two columns on a wide panel: controls on the left, a glanceable
            card on the right. A Navigator is 16:9 with only a handful of
            favourites on it, so a single stacked column left most of the
            screen empty. Falls back to one column when narrow. */}
        <div class="home-split">
          <div class="home-col">
            {favs.length > 0 ? (
              <>
                <div class="section-head">
                  <h2 class="section-title">Favorites</h2>
                </div>
                <div class={favs.length <= 4 ? 'tile-grid tile-grid-roomy' : 'tile-grid'}>
                  {favs.map((item) => (
                    <EntityTile key={item.id} item={item} size="lg" />
                  ))}
                </div>
              </>
            ) : null}

            {scenes.length > 0 ? (
              <>
                <div class="section-head">
                  <h2 class="section-title">Scenes</h2>
                </div>
                <div class="scene-row">
                  {scenes.map((item) => (
                    <Pressable
                      key={item.id}
                      class="scene-chip"
                      onPress={() => activate(item.id)}
                      onLongPress={() => {
                        openEntity.value = item.id;
                        markActivity();
                      }}
                      ariaLabel={item.name}
                      disabled={item.unavailable}
                    >
                      <Icon name={item.icon} size="1.25rem" weight={1.7} />
                      <span class="truncate">{item.name}</span>
                    </Pressable>
                  ))}
                </div>
              </>
            ) : null}
          </div>

          <HomeSide />
        </div>
      </div>
    </div>
  );
}
