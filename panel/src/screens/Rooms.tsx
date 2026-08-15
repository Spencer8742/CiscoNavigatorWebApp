import { rooms } from '~/config/index.ts';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Empty } from '~/components/Empty.tsx';
import { activeRoom, markActivity } from '~/state/ui.ts';

/**
 * Rooms.
 *
 * Phase 1 renders the room list from dashboard.yaml. Tapping a room sets
 * `activeRoom`; the drill-down that reads it lands in phase 4 along with the
 * domain control registry.
 */
export function Rooms() {
  const list = rooms.value;

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
            {list.map((room) => (
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
                <div class="room-card-icon">
                  <Icon name={room.icon} size="1.75rem" weight={1.6} />
                </div>
                <div class="room-card-body">
                  <div class="room-card-name truncate">{room.name}</div>
                  <div class="room-card-meta">
                    {room.entities.length}{' '}
                    {room.entities.length === 1 ? 'device' : 'devices'}
                  </div>
                </div>
                <Icon name="chevronRight" size="1.25rem" class="room-card-chev" />
              </Pressable>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
