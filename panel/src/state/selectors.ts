import { computed } from '@preact/signals';
import { entity, maPlayerIds } from '~/state/entities.ts';
import { homeConfig, mediaConfig, roomsById } from '~/config/index.ts';
import { activeRoom, prefs } from '~/state/ui.ts';
import { countsAsOn, describe, friendlyName, type EntityDescriptor } from '~/domains/registry.ts';
import {
  canGroup,
  groupMembers,
  MA_PLAYER_TYPE_ATTR,
} from '@shared/protocol.ts';

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
  homeConfig.value.favorites.map((ref) => ({
    ...describe(entity(ref.entity).value, ref.entity, ref.name),
    id: ref.entity,
  })),
);

/** Scene and script buttons on the Home screen. */
export const sceneButtons = computed<DescribedEntity[]>(() =>
  homeConfig.value.scenes.map((ref) => ({
    ...describe(entity(ref.entity).value, ref.entity, ref.name),
    id: ref.entity,
  })),
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
  return room.entities.map((ref) => ({
    ...describe(entity(ref.entity).value, ref.entity, ref.name),
    id: ref.entity,
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
    for (const ref of room.entities) {
      if (!countsAsOn(ref.entity)) continue;
      const state = entity(ref.entity).value;
      if (!state) continue;
      if (describe(state, ref.entity).active) n += 1;
    }
    out.set(id, n);
  }
  return out;
});

/**
 * A one-line summary of whatever is playing, for the screensaver overlay.
 *
 * Reads only the configured media players, so a house full of Chromecasts
 * that are not on the dashboard cannot wake this computed.
 */
/* ── Music Assistant speakers ─────────────────────────────────────────────
   Music Assistant is the source of truth. Everything below reads its own
   attributes off the entities Home Assistant already streams us — there is no
   second connection, no grouping state of our own, and a group made from any
   other dashboard shows up here without the panel asking for anything. */

export interface SpeakerInfo {
  id: string;
  name: string;
  /** MA's own player type: 'player' | 'stereo_pair' | 'group'. */
  kind: string;
  /** A permanent Music Assistant group rather than an ad-hoc join. */
  isGroup: boolean;
  state: string;
  available: boolean;
  /** 0..1, or null when the player has no volume control. */
  volume: number | null;
  muted: boolean;
  canGroup: boolean;
  /** Everyone playing in sync with this player, itself included. */
  members: string[];
}

/**
 * Every speaker the panel can reach: configured players plus, when discovery
 * is on, everything Music Assistant exposes.
 *
 * Configured entries come first and in the order they were written, because
 * someone who bothered to list them meant that order. Discovered speakers
 * follow, alphabetically by name.
 */
export const speakers = computed<SpeakerInfo[]>(() => {
  const cfg = mediaConfig.value;
  const describeOne = (id: string, nameOverride?: string): SpeakerInfo | null => {
    const s = entity(id).value;
    if (!s) return null;
    const type = s.a[MA_PLAYER_TYPE_ATTR];
    return {
      id,
      name: nameOverride ?? friendlyName(s, id),
      kind: typeof type === 'string' ? type : 'player',
      isGroup: type === 'group',
      state: s.s,
      available: s.s !== 'unavailable' && s.s !== 'unknown',
      volume: typeof s.a['volume_level'] === 'number' ? s.a['volume_level'] : null,
      muted: s.a['is_volume_muted'] === true,
      canGroup: canGroup(s),
      members: groupMembers(s),
    };
  };

  const out: SpeakerInfo[] = [];
  const seen = new Set<string>();

  for (const p of cfg.players) {
    const info = describeOne(p.entity, p.name);
    if (info) {
      out.push(info);
      seen.add(p.entity);
    }
  }

  if (cfg.discoverMusicAssistant) {
    const found: SpeakerInfo[] = [];
    for (const id of maPlayerIds.value) {
      if (seen.has(id)) continue;
      const info = describeOne(id);
      if (info) found.push(info);
    }
    found.sort((a, b) => a.name.localeCompare(b.name));
    out.push(...found);
  }

  return out;
});

/**
 * The player the panel should show when the user has not picked one.
 *
 * `media.default: active` picks whatever is currently playing, which is almost
 * always what you want on a wall panel: you walked over because music is
 * playing, and it should already be showing rather than making you find which
 * of five speakers it is.
 *
 * Reads `speakers` rather than `media.players`, which matters for the setup
 * this app actually encourages: with Music Assistant discovery on and nothing
 * listed in `dashboard.yaml`, there ARE no configured players, and keying off
 * the config alone left the Media screen empty — showing "player not found"
 * next to a house full of speakers the panel could see perfectly well.
 *
 * Shared so the Home card and the Media screen never disagree about which
 * player is "the" one.
 */
export const defaultPlayerId = computed<string>(() => {
  const cfg = mediaConfig.value;
  const all = speakers.value;
  const first = all[0]?.id ?? '';

  if (cfg.default !== 'active') {
    return all.some((s) => s.id === cfg.default) ? cfg.default : first;
  }

  for (const s of all) {
    if (s.state === 'playing') return s.id;
  }
  for (const s of all) {
    if (s.state === 'paused' || s.state === 'buffering') return s.id;
  }
  return first;
});

/** True when a player is actively producing sound. */
export const anythingPlaying = computed<boolean>(() =>
  speakers.value.some(
    (s) => s.state === 'playing' || s.state === 'paused' || s.state === 'buffering',
  ),
);

/**
 * A one-line summary of whatever is playing, for the screensaver overlay.
 */
export const nowPlaying = computed<string | null>(() => {
  for (const speaker of speakers.value) {
    if (speaker.state !== 'playing') continue;
    const state = entity(speaker.id).value;
    if (!state) continue;
    const title = typeof state.a['media_title'] === 'string' ? state.a['media_title'] : null;
    if (!title) continue;
    const artist = typeof state.a['media_artist'] === 'string' ? state.a['media_artist'] : null;
    return artist ? `${title} — ${artist}` : title;
  }
  return null;
});

/** Speakers that are ad-hoc joinable, i.e. not permanent MA groups. */
export const joinableSpeakers = computed<SpeakerInfo[]>(() =>
  speakers.value.filter((s) => !s.isGroup && s.canGroup),
);

/** Permanent Music Assistant groups, offered as one-tap shortcuts. */
export const speakerGroups = computed<SpeakerInfo[]>(() =>
  speakers.value.filter((s) => s.isGroup),
);

export interface SpeakerSection {
  name: string;
  players: SpeakerInfo[];
}

/**
 * The player list as arranged on this panel: sections, order, hidden.
 *
 * The layout is deliberately sparse — a speaker nobody has filed appears in
 * the first section automatically. That means discovering a new speaker
 * requires no write at all, and someone who never opens the editor still gets
 * a sensible list rather than an empty one.
 */
export const speakerSections = computed<SpeakerSection[]>(() => {
  const all = speakers.value;
  const layout = prefs.value.players;
  const names = mediaConfig.value.sections;
  const byId = new Map(all.map((s) => [s.id, s]));

  const hidden = new Set(layout.hidden);
  const placed = new Set<string>();
  const out: SpeakerSection[] = [];

  for (const name of names) {
    const ids = layout.sections[name] ?? [];
    const players: SpeakerInfo[] = [];
    for (const id of ids) {
      if (hidden.has(id)) continue;
      const s = byId.get(id);
      // A speaker that has gone away leaves its entry behind harmlessly; it
      // simply stops rendering until it comes back.
      if (s) {
        players.push(s);
        placed.add(id);
      }
    }
    out.push({ name, players });
  }

  // Anything unfiled goes in the first section, keeping the discovery order.
  const first = out[0];
  if (first) {
    for (const s of all) {
      if (placed.has(s.id) || hidden.has(s.id)) continue;
      first.players.push(s);
    }
  }

  return out.filter((section) => section.players.length > 0);
});

/** Speakers the user has chosen not to see. Only the editor shows these. */
export const hiddenSpeakers = computed<SpeakerInfo[]>(() => {
  const hidden = new Set(prefs.value.players.hidden);
  return speakers.value.filter((s) => hidden.has(s.id));
});
