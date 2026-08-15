import { rooms } from '~/config/index.ts';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Empty } from '~/components/Empty.tsx';
import { EntityTile } from '~/components/EntityTile.tsx';
import { activeRoom, markActivity } from '~/state/ui.ts';
import { activeRoomEntities, activeRoomName, roomActivity } from '~/state/selectors.ts';

/**
 * Rooms — a list that drills into one room.
 *
 * Two views in one screen rather than two routes: the drill-down is a
 * property of the Rooms screen, not a separate destination, so the nav rail
 * never disagrees with what is on screen and tapping "Rooms" again always
 * gets you back to the list.
 */
export function Rooms() {
  return activeRoom.value ? <RoomDetail /> : <RoomList />;
}

function RoomList() {
  const list = rooms.value;
  const activity = roomActivity.value;

  return (
    <div class="screen screen-enter">
      <div class="screen-head">
        <h1 class="screen-title">Rooms</h1>
        {list.length > 0 ? (
          <span class="screen-sub">
            {list.length} {list.length === 1 ? 'room' : 'rooms'}
          </span>
        ) : null}
      </div>

      <div class="screen-body scroll">
        {list.length === 0 ? (
          <Empty icon="rooms" title="No rooms configured">
            Add a <code>rooms:</code> section to <code>config/dashboard.yaml</code>.
            Each room lists the Home Assistant entities it contains; the controls
            shown adapt automatically to each entity's domain.
          </Empty>
        ) : (
          <div class="room-grid">
            {list.map((room) => {
              const on = activity.get(room.id) ?? 0;
              return (
                <Pressable
                  key={room.id}
                  as="div"
                  class="room-card p-lg"
                  onPress={() => {
                    activeRoom.value = room.id;
                    markActivity();
                  }}
                  ariaLabel={room.name}
                >
                  <div class="room-card-icon" data-active={on > 0 ? '' : undefined}>
                    <Icon name={room.icon} size="1.75rem" weight={1.6} />
                  </div>
                  <div class="room-card-body">
                    <div class="room-card-name truncate">{room.name}</div>
                    <div class="room-card-meta">
                      {/* "3 on" is the question people actually have about a
                          room they are not standing in. */}
                      {on > 0
                        ? `${on} on`
                        : `${room.entities.length} ${room.entities.length === 1 ? 'device' : 'devices'}`}
                    </div>
                  </div>
                  <Icon name="chevronRight" size="1.25rem" class="room-card-chev" />
                </Pressable>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function RoomDetail() {
  const items = activeRoomEntities.value;

  return (
    <div class="screen screen-enter">
      <div class="screen-head">
        <Pressable
          class="back-button p-sm"
          onPress={() => {
            activeRoom.value = null;
            markActivity();
          }}
          ariaLabel="Back to rooms"
        >
          <Icon name="chevronLeft" size="1.5rem" weight={2} />
        </Pressable>
        <h1 class="screen-title">{activeRoomName.value}</h1>
        <span class="screen-sub">
          {items.length} {items.length === 1 ? 'device' : 'devices'}
        </span>
      </div>

      <div class="screen-body scroll">
        {items.length === 0 ? (
          <Empty icon="rooms" title="This room has no entities">
            Add entity IDs under this room in <code>config/dashboard.yaml</code>.
          </Empty>
        ) : (
          <div class="tile-grid">
            {items.map((item) => (
              <EntityTile key={item.id} item={item} size="lg" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
