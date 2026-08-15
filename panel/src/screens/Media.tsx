import { useEffect, useState } from 'preact/hooks';
import { mediaConfig } from '~/config/index.ts';
import { entity } from '~/state/entities.ts';
import { Empty } from '~/components/Empty.tsx';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Slider } from '~/components/Slider.tsx';
import { OptionRow } from '~/components/Sheet.tsx';
import { attrNumber, attrString, friendlyName } from '~/domains/registry.ts';
import { defaultPlayerId, speakers } from '~/state/selectors.ts';
import { GroupSheet } from '~/components/GroupSheet.tsx';
import { PlayerPicker } from '~/components/PlayerPicker.tsx';
import { canGroup, groupMembers } from '@shared/protocol.ts';
import { getToken } from '~/net/auth.ts';
import * as act from '~/state/actions.ts';
import type { EntityState } from '@shared/protocol.ts';

/**
 * Now Playing.
 *
 * Deliberately not an entity card. Artwork-led, transport controls sized for
 * a finger from across the room, and the player switcher as a first-class
 * element — closer to a car head unit than to a Home Assistant media card,
 * which is what the brief asked for.
 *
 * Everything on this screen is driven by the media_player entity's signal, so
 * a change made on the speaker itself, on a phone, or by a voice assistant
 * appears here without the panel asking for anything.
 */

export function Media() {
  const cfg = mediaConfig.value;
  const [chosen, setChosen] = useState<string | null>(null);
  const [grouping, setGrouping] = useState(false);
  const [picking, setPicking] = useState(false);

  // Reset the manual choice if the configured players change under us.
  const all = speakers.value;
  // Key by id rather than the array, which is a fresh object every time a
  // speaker's volume or state changes.
  const known = all.map((s) => s.id).join(',');

  /*
   * Drop a manual choice only when that speaker genuinely goes away.
   *
   * This used to check `cfg.players`, which was correct until speakers were
   * discovered rather than configured: picking a discovered one then set
   * `chosen` and this effect immediately cleared it again, snapping the
   * screen back to the default player. From the front that looks like a tap
   * that flashes and does nothing.
   */
  useEffect(() => {
    if (chosen && !all.some((s) => s.id === chosen)) setChosen(null);
  }, [known, chosen]);

  if (all.length === 0) {
    return (
      <div class="screen screen-enter">
        <div class="screen-head">
          <h1 class="screen-title">Media</h1>
        </div>
        <div class="screen-body">
          <Empty icon="media" title="No media players found">
            Music Assistant players are discovered automatically. If you are not
            running it, add a <code>media:</code> section to{' '}
            <code>config/dashboard.yaml</code> listing your{' '}
            <code>media_player</code> entities.
          </Empty>
        </div>
      </div>
    );
  }

  const activeId = chosen ?? defaultPlayerId.value;
  const state = entity(activeId).value;
  // Group membership comes from Music Assistant, so this reflects a group
  // made anywhere — this panel, a Home Assistant dashboard, or the MA app.
  const members = groupMembers(state);
  const grouped = members.length > 1;

  return (
    <div class="screen screen-enter">
      {/* One control, not a row of chips. Twenty-seven speakers wrapped onto
          three rows and pushed the actual media player off the screen — and
          it got worse the more speakers you owned. */}
      <div class="player-select-bar">
        <Pressable
          class="player-select"
          onPress={() => setPicking(true)}
          ariaLabel="Choose a player"
        >
          <Icon name="speaker" size="1.2rem" weight={1.8} />
          <span class="player-select-name truncate">
            {all.find((s) => s.id === activeId)?.name ?? friendlyName(state, activeId)}
          </span>
          <Icon name="chevronDown" size="1rem" weight={2.2} />
        </Pressable>
      </div>

      {/* Where the sound is coming from, and the way into changing it. One
          control does both jobs, because "which rooms?" and "add a room" are
          the same thought. */}
      {canGroup(state) ? (
        <Pressable class="group-bar" onPress={() => setGrouping(true)} ariaLabel="Group players">
          <Icon name="speaker" size="1.1rem" weight={1.8} />
          <span class="group-bar-label">Playing on</span>
          <span class="group-bar-rooms truncate">{describeGroup(members, activeId)}</span>
          <Icon name="next" size="1rem" weight={2} />
        </Pressable>
      ) : null}

      <div class="screen-body scroll">
        {state ? <NowPlaying id={activeId} state={state} /> : <MissingPlayer id={activeId} />}
      </div>

      {picking ? (
        <PlayerPicker
          activeId={activeId}
          onSelect={(id) => setChosen(id)}
          onClose={() => setPicking(false)}
        />
      ) : null}

      {grouping ? (
        <GroupSheet
          leader={activeId}
          onSelect={(id) => setChosen(id)}
          onClose={() => setGrouping(false)}
        />
      ) : null}
    </div>
  );
}


function MissingPlayer({ id }: { id: string }) {
  return (
    <Empty icon="speaker" title="Player not found">
      Home Assistant is not reporting <code>{id}</code>. Check the entity ID in{' '}
      <code>dashboard.yaml</code>.
    </Empty>
  );
}

function NowPlaying({ id, state }: { id: string; state: EntityState }) {
  const off = state.s === 'off' || state.s === 'standby' || state.s === 'unavailable';
  const idle = state.s === 'idle';
  const playing = state.s === 'playing';

  const title = attrString(state, 'media_title');
  const artist = attrString(state, 'media_artist');
  const album = attrString(state, 'media_album_name');
  const picture = attrString(state, 'entity_picture');
  const source = attrString(state, 'source');
  const sources = sourceList(state);
  const volume = attrNumber(state, 'volume_level');
  const muted = state.a['is_volume_muted'] === true;

  const supportsPower = hasFeature(state, MediaFeature.TURN_ON | MediaFeature.TURN_OFF);

  return (
    <div class="now-playing">
      <div class="np-art" data-empty={picture ? undefined : ''}>
        {picture ? (
          <Artwork path={picture} alt={title ?? 'Album artwork'} />
        ) : (
          <Icon name="media" size="4rem" weight={1.2} />
        )}
      </div>

      <div class="np-info">
        <div class="np-title truncate">
          {title ?? (off ? 'Off' : idle ? 'Nothing playing' : friendlyName(state, id))}
        </div>
        {artist ? <div class="np-artist truncate">{artist}</div> : null}
        {album ? <div class="np-album truncate">{album}</div> : null}

        <div class="np-transport">
          <Pressable
            class="np-button p-sm"
            onPress={() => act.mediaPrevious(id)}
            disabled={off}
            ariaLabel="Previous track"
          >
            <Icon name="prev" size="1.5rem" />
          </Pressable>

          <Pressable
            class="np-button np-play"
            onPress={() => act.mediaPlayPause(id)}
            disabled={off}
            ariaLabel={playing ? 'Pause' : 'Play'}
          >
            <Icon name={playing ? 'pause' : 'play'} size="1.9rem" />
          </Pressable>

          <Pressable
            class="np-button p-sm"
            onPress={() => act.mediaNext(id)}
            disabled={off}
            ariaLabel="Next track"
          >
            <Icon name="next" size="1.5rem" />
          </Pressable>

          {supportsPower ? (
            <Pressable
              class={off ? 'np-button p-sm' : 'np-button p-sm is-on'}
              onPress={() => act.setMediaPower(id, off)}
              ariaLabel={off ? 'Turn on' : 'Turn off'}
            >
              <Icon name="power" size="1.4rem" weight={2} />
            </Pressable>
          ) : null}
        </div>

        {volume !== undefined ? (
          <div class="np-volume">
            <Pressable
              class="np-mute p-sm"
              onPress={() => act.setMuted(id, !muted)}
              ariaPressed={muted}
              ariaLabel={muted ? 'Unmute' : 'Mute'}
            >
              <Icon name={muted ? 'mute' : 'volume'} size="1.3rem" />
            </Pressable>

            <Slider
              value={muted ? 0 : Math.round(volume * 100)}
              ariaLabel="Volume"
              readout={`${Math.round((muted ? 0 : volume) * 100)}%`}
              onChange={(v, final) => act.setVolume(id, v / 100, final)}
            />

            <Pressable
              class="np-step p-sm"
              onPress={() => act.nudgeVolume(id, -mediaConfig.value.volumeStep)}
              ariaLabel="Volume down"
            >
              <Icon name="minus" size="1.2rem" weight={2.2} />
            </Pressable>
            <Pressable
              class="np-step p-sm"
              onPress={() => act.nudgeVolume(id, mediaConfig.value.volumeStep)}
              ariaLabel="Volume up"
            >
              <Icon name="plus" size="1.2rem" weight={2.2} />
            </Pressable>
          </div>
        ) : null}

        {sources.length > 0 ? (
          <div class="np-sources">
            <div class="sheet-section-label">Source</div>
            <OptionRow
              options={sources.map((s) => ({ value: s, label: s }))}
              value={source}
              onSelect={(v) => act.selectSource(id, v)}
              ariaLabel="Source"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Album art, fetched through the backend.
 *
 * Home Assistant's `entity_picture` is a relative path that usually needs the
 * HA bearer token, which the panel does not have — so it goes through
 * `/img/ha`. The token rides in the query string because browsers do not
 * attach Authorization headers to `<img src>`.
 *
 * `key` on the img forces a fresh element per track: reusing one and swapping
 * `src` leaves the previous artwork on screen during the fetch, which looks
 * like the panel is showing the wrong track.
 */
function Artwork({ path, alt }: { path: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const token = getToken();

  useEffect(() => setFailed(false), [path]);

  if (failed) return <Icon name="media" size="4rem" weight={1.2} />;

  const src = `/img/ha?p=${encodeURIComponent(path)}${token ? `&t=${encodeURIComponent(token)}` : ''}`;

  return (
    <img
      key={path}
      src={src}
      alt={alt}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

function sourceList(state: EntityState): string[] {
  const v = state.a['source_list'];
  if (!Array.isArray(v)) return [];
  // A receiver can report 40 inputs; a wall panel showing 40 chips is
  // unusable. The first dozen covers anything anyone selects by hand.
  return v.filter((x): x is string => typeof x === 'string').slice(0, 12);
}

/** Home Assistant's `supported_features` bitmask, the bits we care about. */
const MediaFeature = {
  TURN_ON: 128,
  TURN_OFF: 256,
} as const;

function hasFeature(state: EntityState, mask: number): boolean {
  const features = attrNumber(state, 'supported_features');
  if (features === undefined) return false;
  return (features & mask) !== 0;
}

/**
 * "Living Room + Kitchen", or "3 rooms" once that gets too long to read at a
 * glance from across the room.
 */
function describeGroup(members: string[], activeId: string): string {
  const ids = members.length > 0 ? members : [activeId];
  const names = ids.map((id) => friendlyName(entity(id).value, id));
  if (names.length === 1) return names[0] ?? '';
  if (names.length <= 2) return names.join(' + ');
  return `${names.length} rooms`;
}
