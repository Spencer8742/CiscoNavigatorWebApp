import { computed } from '@preact/signals';
import { entity } from '~/state/entities.ts';
import { homeConfig, roomsById } from '~/config/index.ts';
import { activeRoom } from '~/state/ui.ts';
import { countsAsOn, describe, type EntityDescriptor } from '~/domains/registry.ts';

/**
 * Derived views over the entity store.
 *
 * Everything here is a `computed`, which matters for the same reason the
 * per-entity signals do: a computed only recalculates when a signal it
 * actually read has changed. `houseAlerts` reads the four entities named in
 * `home.alerts`, so the other two hundred entities in the house can change
 * all day without it running once.
 *
 * The rule this file follows: screens should never reach into the entity
 * store and filter. If a screen needs a list, it belongs here, where the
 * dependency tracking is precise.
 */

export interface DescribedEntity extends EntityDescriptor {
  id: string;
}

/** Status readouts for the Home screen strip. */
export const statusItems = computed<(DescribedEntity & { label: string })[]>(() =>
  homeConfig.value.status.map((item) => {
    const state = entity(item.entity).value;
    const described = describe(state, item.entity);
    return {
      ...described,
      id: item.entity,
      // The configured label wins: "Indoor" is more useful on a small tile
      // than "Living Room Temperature Sensor".
      label: item.label ?? described.name,
    };
  }),
);

/**
 * Active house alerts.
 *
 * An alert fires when an entity is in the state the config named. Unavailable
 * entities never fire: "the door might be unlocked, we can't tell" is not
 * something to put a red banner on, and a Home Assistant restart would
 * otherwise light up every alert at once.
 */
export const houseAlerts = computed<{ entity: string; label: string }[]>(() => {
  const out: { entity: string; label: string }[] = [];
  for (const rule of homeConfig.value.alerts) {
    const state = entity(rule.entity).value;
    if (!state || state.s === 'unavailable' || state.s === 'unknown') continue;
    if (state.s === rule.when) out.push({ entity: rule.entity, label: rule.label });
  }
  return out;
});

/** Favourite tiles on the Home screen. */
export const favorites = computed<DescribedEntity[]>(() =>
  homeConfig.value.favorites.map((id) => ({ ...describe(entity(id).value, id), id })),
);

/** Scene and script buttons on the Home screen. */
export const sceneButtons = computed<DescribedEntity[]>(() =>
  homeConfig.value.scenes.map((id) => ({ ...describe(entity(id).value, id), id })),
);

/** The weather entity, if one is configured. */
export const weather = computed<DescribedEntity | null>(() => {
  const id = homeConfig.value.weather;
  if (!id) return null;
  return { ...describe(entity(id).value, id), id };
});

/** Entities of the room currently drilled into. */
export const activeRoomEntities = computed<DescribedEntity[]>(() => {
  const id = activeRoom.value;
  if (!id) return [];
  const room = roomsById.value.get(id);
  if (!room) return [];
  return room.entities.map((entityId) => ({
    ...describe(entity(entityId).value, entityId),
    id: entityId,
  }));
});

export const activeRoomName = computed<string>(() => {
  const id = activeRoom.value;
  if (!id) return 'Rooms';
  return roomsById.value.get(id)?.name ?? 'Room';
});

/**
 * How many devices in each room are switched on.
 *
 * Shown on the room list so "is anything still running upstairs?" is
 * answerable without opening every room. Counts only domains where "on" means
 * consuming power — see `countsAsOn`.
 */
export const roomActivity = computed<Map<string, number>>(() => {
  const out = new Map<string, number>();
  for (const [id, room] of roomsById.value) {
    let n = 0;
    for (const entityId of room.entities) {
      if (!countsAsOn(entityId)) continue;
      const state = entity(entityId).value;
      if (!state) continue;
      if (describe(state, entityId).active) n += 1;
    }
    out.set(id, n);
  }
  return out;
});
