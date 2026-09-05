import { useEffect, useState } from 'preact/hooks';
import { Empty } from '~/components/Empty.tsx';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Slider } from '~/components/Slider.tsx';
import { defaultPlayerId, speakers, type SpeakerInfo } from '~/state/selectors.ts';
import { queues } from '~/state/players.ts';
import { GroupSheet } from '~/components/GroupSheet.tsx';
import { SpeakerSheet } from '~/components/SpeakerSheet.tsx';
import { PlayerPicker } from '~/components/PlayerPicker.tsx';
import { Browse } from '~/components/Browse.tsx';
import { Queue } from '~/components/Queue.tsx';
import { Progress } from '~/components/Progress.tsx';
import { getToken } from '~/net/auth.ts';
import { health } from '~/state/ui.ts';
import * as act from '~/state/actions.ts';

/**
 * Now Playing.
 *
 * Everything on this screen comes from Sonos directly — the speaker list, what
 * is playing, the volume, the group and the queue. Nothing is read from Home
 * Assistant's `media_player` entities, which were only ever a flattened copy
 * of this with the interesting parts removed.
 *
 * The speakers push changes, so a track skipped from a phone or a group made
 * in the Sonos app appears here without the panel asking for anything.
 */
export function Media() {
  const [chosen, setChosen] = useState<string | null>(null);
  const [grouping, setGrouping] = useState(false);
  const [picking, setPicking] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [tuning, setTuning] = useState(false);

  const all = speakers.value;
  // Key by id rather than the array, which is a fresh object on every volume
  // tick and would restart the effect constantly.
  const known = all.map((s) => s.id).join(',');

  /* Drop a manual choice only when that speaker genuinely goes away. */
  useEffect(() => {
    if (chosen && !all.some((s) => s.id === chosen)) setChosen(null);
  }, [known, chosen]);

  if (all.length === 0) return <NoPlayers />;

  const activeId = chosen ?? defaultPlayerId.value;
  const player = all.find((s) => s.id === activeId);
  if (!player) return <NoPlayers />;

  const queue = queues.value.find((q) => q.id === player.queueId);

  return (
    <div class="screen screen-enter">
      <div class="player-select-bar">
        <Pressable
          class="player-select"
          onPress={() => setPicking(true)}
          ariaLabel="Choose a player"
        >
          <Icon name="speaker" size="1.2rem" weight={1.8} />
          <span class="player-select-name truncate">{player.name}</span>
          <Icon name="chevronDown" size="1rem" weight={2.2} />
        </Pressable>

        <Pressable class="browse-button" onPress={() => setBrowsing(true)} ariaLabel="Browse music">
          <Icon name="search" size="1.1rem" weight={1.9} />
          <span>Browse</span>
        </Pressable>

        {/* Bass, sleep timer, inputs — real but occasional, so one tap away
            rather than on the screen somebody uses while standing here. */}
        <Pressable
          class="browse-button p-sm"
          onPress={() => setTuning(true)}
          ariaLabel="Speaker settings"
        >
          <Icon name="settings" size="1.1rem" weight={1.9} />
        </Pressable>
      </div>

      {/* Where the sound is coming from, and the way into changing it. One
          control does both jobs, because "which rooms?" and "add a room" are
          the same thought. */}
      {player.canGroup ? (
        <Pressable class="group-bar" onPress={() => setGrouping(true)} ariaLabel="Group players">
          <Icon name="speaker" size="1.1rem" weight={1.8} />
          <span class="group-bar-label">Playing on</span>
          <span class="group-bar-rooms truncate">{describeGroup(player, all)}</span>
          <Icon name="next" size="1rem" weight={2} />
        </Pressable>
      ) : null}

      <div class="screen-body scroll">
        <NowPlaying player={player} />
      </div>

      {/* The queue gets its own entry rather than living inside Now Playing:
          it is a list you go into and act on, not a readout. */}
      {player.queueId ? (
        <Pressable
          class="queue-bar"
          onPress={() => setQueueOpen(true)}
          ariaLabel="Open the queue"
          disabled={!queue || queue.count === 0}
        >
          <Icon name="list" size="1.1rem" weight={1.9} />
          <span class="queue-bar-label">Queue</span>
          <span class="queue-bar-count">
            {!queue || queue.count === 0
              ? 'Empty'
              : queue.count === 1
                ? '1 track'
                : `${queue.count} tracks`}
          </span>
          <Icon name="next" size="1rem" weight={2} />
        </Pressable>
      ) : null}

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

      {browsing ? <Browse playerId={activeId} onClose={() => setBrowsing(false)} /> : null}

      {tuning ? (
        <SpeakerSheet
          player={player}
          grouped={player.members.length > 1}
          onClose={() => setTuning(false)}
        />
      ) : null}

      {queueOpen && player.queueId ? (
        <Queue
          playerId={player.id}
          queueId={player.queueId}
          onClose={() => setQueueOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * No speakers.
 *
 * Which has two very different causes, and saying which one is the whole
 * point: an unconfigured backend needs an environment variable, a rejected
 * token needs a new token, and both look identical as an empty screen.
 */
function NoPlayers() {
  const h = health.value;

  return (
    <div class="screen screen-enter">
      <div class="screen-head">
        <h1 class="screen-title">Media</h1>
      </div>
      <div class="screen-body">
        {h?.sonos === 'disabled' ? (
          <Empty icon="media" title="Sonos is not set up">
            Set <code>SONOS_HOST</code> to the IP address of any one Sonos speaker (for
            example <code>192.168.1.51</code>) and restart the container. The panel finds the
            rest of the household from there.
          </Empty>
        ) : h?.sonosError ? (
          <Empty icon="alert" title="Sonos could not be reached">
            {h.sonosError}
          </Empty>
        ) : h?.sonos === 'connected' ? (
          <Empty icon="media" title="No speakers yet">
            Sonos answered but reported no rooms. Check that UPnP is enabled in the Sonos
            app, under Settings, App Preferences, Privacy.
          </Empty>
        ) : (
          <Empty icon="media" title="Looking for Sonos…">
            Waiting for the speaker at <code>SONOS_HOST</code> to answer.
          </Empty>
        )}
      </div>
    </div>
  );
}

function NowPlaying({ player }: { player: SpeakerInfo }) {
  const media = player.media;
  const playing = player.state === 'playing';
  const off = !player.available || player.powered === false;
  const token = getToken();

  return (
    <div class="now-playing">
      <div class="np-art" data-empty={media?.art ? undefined : ''}>
        {media?.art ? (
          <img
            key={media.art}
            src={`${media.art}${token ? `&t=${encodeURIComponent(token)}` : ''}`}
            alt={media.title ?? 'Album artwork'}
            decoding="async"
          />
        ) : (
          <Icon name="media" size="4rem" weight={1.2} />
        )}
      </div>

      <div class="np-info">
        <div class="np-title truncate">
          {media?.title ?? (off ? 'Off' : 'Nothing playing')}
        </div>
        {media?.artist ? <div class="np-artist truncate">{media.artist}</div> : null}
        {media?.album ? <div class="np-album truncate">{media.album}</div> : null}

        {/* Position, extrapolated locally. The backend sends elapsed time
            with the moment it was measured, so the bar moves smoothly between
            updates instead of stepping. */}
        {media?.duration ? (
          <Progress
            elapsed={media.elapsed}
            elapsedAt={media.elapsedAt}
            duration={media.duration}
            running={playing}
            onSeek={(seconds) => act.seekTo(player.id, seconds)}
          />
        ) : null}

        <div class="np-transport">
          <Pressable
            class="np-button p-sm"
            onPress={() => act.mediaPrevious(player.id)}
            disabled={off}
            ariaLabel="Previous track"
          >
            <Icon name="prev" size="1.5rem" />
          </Pressable>

          <Pressable
            class="np-button np-play"
            onPress={() => act.mediaPlayPause(player.id)}
            disabled={off}
            ariaLabel={playing ? 'Pause' : 'Play'}
          >
            <Icon name={playing ? 'pause' : 'play'} size="1.9rem" />
          </Pressable>

          <Pressable
            class="np-button p-sm"
            onPress={() => act.mediaNext(player.id)}
            disabled={off}
            ariaLabel="Next track"
          >
            <Icon name="next" size="1.5rem" />
          </Pressable>

          {player.powered !== null ? (
            <Pressable
              class={off ? 'np-button p-sm' : 'np-button p-sm is-on'}
              onPress={() => act.setMediaPower(player.id, off)}
              ariaLabel={off ? 'Turn on' : 'Turn off'}
            >
              <Icon name="power" size="1.4rem" weight={2} />
            </Pressable>
          ) : null}
        </div>

        {player.volume !== null ? (
          <div class="np-volume">
            <Pressable
              class="np-mute p-sm"
              onPress={() => act.setMuted(player.id, !player.muted)}
              ariaPressed={player.muted}
              ariaLabel={player.muted ? 'Unmute' : 'Mute'}
            >
              <Icon name={player.muted ? 'mute' : 'volume'} size="1.3rem" />
            </Pressable>

            <Slider
              value={player.muted ? 0 : player.volume}
              ariaLabel="Volume"
              readout={`${player.muted ? 0 : player.volume}%`}
              onChange={(v, final) => act.setVolume(player.id, v, final)}
            />

            <Pressable
              class="np-step p-sm"
              onPress={() => act.nudgeVolume(player.id, -5)}
              ariaLabel="Volume down"
            >
              <Icon name="minus" size="1.2rem" weight={2.2} />
            </Pressable>
            <Pressable
              class="np-step p-sm"
              onPress={() => act.nudgeVolume(player.id, 5)}
              ariaLabel="Volume up"
            >
              <Icon name="plus" size="1.2rem" weight={2.2} />
            </Pressable>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "Living Room + Kitchen", or "3 rooms" once that gets too long to read at a
 * glance from across the room.
 */
function describeGroup(player: SpeakerInfo, all: SpeakerInfo[]): string {
  const ids = player.members.length > 0 ? player.members : [player.id];
  const names = ids.map((id) => all.find((s) => s.id === id)?.name ?? id);
  if (names.length === 1) return names[0] ?? '';
  if (names.length <= 2) return names.join(' + ');
  return `${names.length} rooms`;
}
