import { computed } from '@preact/signals';
import { entity } from '~/state/entities.ts';
import { players } from '~/state/players.ts';
import { homeConfig, mediaConfig, roomsById } from '~/config/index.ts';
import { activeRoom, prefs } from '~/state/ui.ts';
import { countsAsOn, describe, type EntityDescriptor } from '~/domains/registry.ts';
import type { MassMedia } from '@shared/protocol.ts';

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

/* ── Music Assistant speakers ─────────────────────────────────────────────
   Music Assistant is the source of truth for everything about music, and the
   panel now talks to it directly rather than reading `media_player` entities
   Home Assistant mirrored from it. That is what makes the queue editable and
   grouping exact: MA tells us which players a speaker CAN group with, which
   Home Assistant's media_player model has nowhere to put. */

export interface SpeakerInfo {
  id: string;
  name: string;
  /** MA's own player type: 'player' | 'stereo_pair' | 'group'. */
  kind: string;
  /** A permanent Music Assistant group rather than an ad-hoc join. */
  isGroup: boolean;
  state: string;
  available: boolean;
  /** 0-100, Music Assistant's own scale. Null when there is no volume. */
  volume: number | null;
  muted: boolean;
  canGroup: boolean;
  /** Everyone playing in sync with this player. Empty when ungrouped. */
  members: string[];
  /** Players this one is able to group with. */
  canGroupWith: string[];
  /** The leader this speaker follows, when it is a synced child. */
  syncedTo: string | null;
  /** Null when the player has no power control of its own. */
  powered: boolean | null;
  /** The queue driving it — needed by every queue command. */
  queueId: string | null;
  /** What is playing on it, straight from Music Assistant. */
  media: MassMedia | null;
}

/**
 * Every speaker Music Assistant knows about.
 *
 * `media.players` in `dashboard.yaml` is now only a rename: identity comes
 * from Music Assistant, so there is nothing to list and nothing to keep in
 * sync. Entries are matched by Music Assistant player id, falling back to a
 * case-insensitive name match so an existing config keeps working.
 */
export const speakers = computed<SpeakerInfo[]>(() => {
  const overrides = new Map<string, string>();
  for (const p of mediaConfig.value.players) {
    if (p.name) overrides.set(p.entity.toLowerCase(), p.name);
  }

  return players.value.map((p) => ({
    id: p.id,
    name: overrides.get(p.id.toLowerCase()) ?? overrides.get(p.name.toLowerCase()) ?? p.name,
    kind: p.type,
    isGroup: p.type === 'group',
    state: p.state,
    available: p.available,
    volume: p.volume,
    muted: p.muted,
    // A player with nothing it can group with cannot be grouped — that is
    // Music Assistant's own answer, not a guess from a feature bitmask.
    canGroup: p.canGroupWith.length > 0,
    members: p.members,
    canGroupWith: p.canGroupWith,
    syncedTo: p.syncedTo,
    powered: p.powered,
    queueId: p.queueId,
    media: p.media,
  }));
});

/**
 * The player the panel should show when the user has not picked one.
 *
 * `media.default: active` picks whatever is currently playing, which is almost
 * always what you want on a wall panel: you walked over because music is
 * playing, and it should already be showing rather than making you find which
 * of five speakers it is.
 */
export const defaultPlayerId = computed<string>(() => {
  const cfg = mediaConfig.value;
  const all = speakers.value;
  const first = all[0]?.id ?? '';

  if (cfg.default !== 'active') {
    const named = all.find(
      (s) => s.id === cfg.default || s.name.toLowerCase() === cfg.default.toLowerCase(),
    );
    return named?.id ?? first;
  }

  // A synced follower is playing the same thing as its leader; showing the
  // leader is what someone means by "what's playing".
  const playing = all.filter((s) => s.state === 'playing' && !s.syncedTo);
  if (playing[0]) return playing[0].id;

  for (const s of all) {
    if (s.state === 'playing') return s.id;
  }
  for (const s of all) {
    if (s.state === 'paused' || s.state === 'buffering') return s.id;
  }
  return first;
});

/** True when a speaker is actively producing sound. */
export const anythingPlaying = computed<boolean>(() =>
  speakers.value.some(
    (s) => s.state === 'playing' || s.state === 'paused' || s.state === 'buffering',
  ),
);

/** A one-line summary of whatever is playing, for the screensaver overlay. */
export const nowPlaying = computed<string | null>(() => {
  for (const s of speakers.value) {
    if (s.state !== 'playing' || !s.media?.title) continue;
    return s.media.artist ? `${s.media.title} — ${s.media.artist}` : s.media.title;
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
