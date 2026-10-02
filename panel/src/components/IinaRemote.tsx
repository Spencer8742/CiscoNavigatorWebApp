import { useEffect, useState } from 'preact/hooks';
import { RemoteButton } from '~/components/AppleTvRemote.tsx';
import { Artwork } from '~/components/Artwork.tsx';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Progress } from '~/components/Progress.tsx';
import { OptionRow, Sheet, SheetSection } from '~/components/Sheet.tsx';
import { Slider } from '~/components/Slider.tsx';
import { getToken } from '~/net/auth.ts';
import { iinaCommand, plex } from '~/net/socket.ts';
import { health, markActivity, showToast } from '~/state/ui.ts';
import type { IinaCommand, IinaState, IinaTrack, PlexItem } from '@shared/protocol.ts';

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
/** How many Continue Watching posters the idle card offers. */
const CONTINUE_MAX = 6;

type Picker = 'sub' | 'audio' | 'speed' | 'screen' | null;

/**
 * IINA on a Mac, as a card on the Apple TV screen.
 *
 * What it shows is read from mpv every few seconds while something plays;
 * opening the card asks for a reading straight away, so it is not blank
 * until the next one. There are two volumes: IINA's own, and the Mac's —
 * the second is the one to reach for when the Mac is playing through
 * speakers, and is missing when the Mac's output has none (HDMI to a TV).
 */
export function IinaRemote({ player }: { player: IinaState }) {
  useEffect(() => {
    iinaCommand(player.id, 'status');
  }, [player.id]);

  const send = (op: IinaCommand, value?: number) => {
    iinaCommand(player.id, op, value);
    markActivity();
  };
  const [picker, setPicker] = useState<Picker>(null);
  const active = player.active;
  const volume = Math.round(player.volume ?? 100);
  const token = getToken();
  // A poster that will not load falls back to the icon rather than a broken
  // image; a different poster deserves a fresh try.
  const [artFailed, setArtFailed] = useState(false);
  useEffect(() => setArtFailed(false), [player.art]);
  const art = active && player.art && !artFailed ? player.art : null;

  const subs = player.tracks.filter((track) => track.type === 'sub');
  const audio = player.tracks.filter((track) => track.type === 'audio');
  const chosen = (tracks: IinaTrack[]) => tracks.find((track) => track.selected)?.label;

  return (
    <section class="apple-tv-card">
      <header class="apple-tv-head">
        <div class="apple-tv-identity">
          <span class="apple-tv-logo"><Icon name="desktop" size="1.5rem" /></span>
          <div>
            <h2>{player.name}</h2>
            <span class="apple-tv-status" data-live={active ? '' : undefined}>
              {active ? (player.paused ? 'Paused in IINA' : 'Playing in IINA') : 'IINA · nothing playing'}
            </span>
          </div>
        </div>
      </header>

      <div class="apple-tv-content iina-content" data-remote="closed" onPointerDown={markActivity}>
        <div class="apple-tv-media">
          <div class="apple-tv-art" data-empty={art ? undefined : ''}>
            {art ? (
              <img
                src={`${art}${token ? `&t=${encodeURIComponent(token)}` : ''}`}
                alt=""
                onError={() => setArtFailed(true)}
              />
            ) : <Icon name={active && !player.paused ? 'play' : 'desktop'} size="3rem" />}
          </div>
          <div class="apple-tv-now">
            <span class="apple-tv-app">IINA</span>
            <strong>{active ? player.title ?? 'Playing' : 'Nothing playing'}</strong>
            {active ? null : <span>Play something from the Plex page on this Mac, or pick up below.</span>}
            {active && player.duration && player.duration > 0 ? (
              <Progress
                elapsed={player.position}
                elapsedAt={player.positionAt}
                duration={player.duration}
                running={!player.paused}
                onSeek={(seconds) => send('seek', seconds)}
              />
            ) : null}

            {active && (player.skip || player.next) ? (
              <div class="iina-skip-row">
                {player.skip ? (
                  <Pressable class="iina-skip" onPress={() => send('skip')}>
                    {player.skip.kind === 'intro' ? 'Skip Intro' : 'Skip Credits'}
                    <Icon name="forward" size="1.1rem" />
                  </Pressable>
                ) : null}
                {player.next ? (
                  <Pressable class="iina-next" onPress={() => send('next')} ariaLabel={`Play next: ${player.next.title}`}>
                    <Artwork src={player.next.art} icon="tv" />
                    <span class="iina-next-text">
                      <span class="iina-next-label">Up next</span>
                      <span class="truncate">{player.next.title}</span>
                    </span>
                    <Icon name="play" size="1.2rem" />
                  </Pressable>
                ) : null}
              </div>
            ) : null}

            {/* Buttons and pickers on the left, both volumes beside them;
                the row wraps, so a narrow card stacks them as before. */}
            <div class="iina-controls">
              <div class="iina-buttons">
                {active ? (
                <div class="apple-tv-transport">
                  <RemoteButton icon="rewind" label="Back 10 seconds" onPress={() => send('seek_back')} />
                  <RemoteButton
                    icon={active && !player.paused ? 'pause' : 'play'}
                    label={active && !player.paused ? 'Pause' : 'Play'}
                    primary
                    onPress={() => send('play_pause')}
                  />
                  <RemoteButton icon="forward" label="Forward 30 seconds" onPress={() => send('seek_forward')} />
                  <RemoteButton icon="stop" label="Stop" onPress={() => send('stop')} />
                  <RemoteButton
                    icon={player.fullscreen ? 'collapse' : 'expand'}
                    label={player.fullscreen ? 'Leave full screen' : 'Full screen'}
                    onPress={() => send('fullscreen')}
                  />
                </div>
                ) : null}

                {active ? (
                  <div class="iina-pickers">
                    {subs.length ? (
                      <Pressable class="iina-pick" onPress={() => setPicker('sub')} ariaLabel="Subtitles">
                        <span class="iina-pick-label">Subtitles</span>
                        <span class="truncate">{chosen(subs) ?? 'Off'}</span>
                      </Pressable>
                    ) : null}
                    {audio.length > 1 ? (
                      <Pressable class="iina-pick" onPress={() => setPicker('audio')} ariaLabel="Audio track">
                        <span class="iina-pick-label">Audio</span>
                        <span class="truncate">{chosen(audio) ?? 'Off'}</span>
                      </Pressable>
                    ) : null}
                    <Pressable class="iina-pick" onPress={() => setPicker('speed')} ariaLabel="Playback speed">
                      <span class="iina-pick-label">Speed</span>
                      <span>{speedLabel(player.speed)}</span>
                    </Pressable>
                    {player.screens.length ? (
                      <Pressable class="iina-pick" onPress={() => setPicker('screen')} ariaLabel="Send to a display">
                        <span class="iina-pick-label">Display</span>
                        <span>Move…</span>
                      </Pressable>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <div class="iina-volumes">
                {active ? (
                <div class="iina-volume">
                  <Pressable
                    class="apple-tv-key"
                    onPress={() => send('mute')}
                    ariaLabel={player.muted ? 'Unmute IINA' : 'Mute IINA'}
                    ariaPressed={player.muted}
                  >
                    <Icon name={player.muted ? 'mute' : 'volume'} size="1.35rem" />
                  </Pressable>
                  <Slider
                    value={volume}
                    min={0}
                    max={100}
                    step={1}
                    icon={<span class="iina-volume-label">IINA</span>}
                    readout={player.muted ? 'Muted' : `${volume}%`}
                    ariaLabel={`${player.name} IINA volume`}
                    // Each change is a login on the Mac, so only where the finger
                    // stops is sent, not every step on the way.
                    onChange={(value, final) => {
                      if (final) send('volume', value);
                    }}
                  />
                </div>
                ) : null}
                {player.systemVolume !== null ? (
                  <div class="iina-volume">
                    <Pressable
                      class="apple-tv-key"
                      onPress={() => send('system_mute')}
                      ariaLabel={player.systemMuted ? `Unmute ${player.name}` : `Mute ${player.name}`}
                      ariaPressed={player.systemMuted}
                    >
                      <Icon name={player.systemMuted ? 'mute' : 'speaker'} size="1.35rem" />
                    </Pressable>
                    <Slider
                      value={Math.round(player.systemVolume)}
                      min={0}
                      max={100}
                      step={1}
                      icon={<span class="iina-volume-label">Mac</span>}
                      readout={player.systemMuted ? 'Muted' : `${Math.round(player.systemVolume)}%`}
                      ariaLabel={`${player.name} volume`}
                      onChange={(value, final) => {
                        if (final) send('system_volume', value);
                      }}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
        {!active ? <ContinueWatching mac={player.id} /> : null}
      </div>
      {player.error ? <p class="apple-tv-error">{player.error}</p> : null}

      {picker ? (
        <PickerSheet
          player={player}
          picker={picker}
          subs={subs}
          audio={audio}
          onPick={(op, value) => {
            send(op, value);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </section>
  );
}

function PickerSheet({ player, picker, subs, audio, onPick, onClose }: {
  player: IinaState;
  picker: Exclude<Picker, null>;
  subs: IinaTrack[];
  audio: IinaTrack[];
  onPick: (op: IinaCommand, value: number) => void;
  onClose: () => void;
}) {
  const tracks = (list: IinaTrack[]) => list.map((track) => ({ value: String(track.id), label: track.label }));
  const selected = (list: IinaTrack[]) => String(list.find((track) => track.selected)?.id ?? -1);
  const title = picker === 'sub' ? 'Subtitles' : picker === 'audio' ? 'Audio' : picker === 'speed' ? 'Speed' : 'Display';
  return (
    <Sheet title={title} subtitle={player.title ?? player.name} onClose={onClose}>
      <SheetSection>
        {picker === 'sub' ? (
          <OptionRow
            ariaLabel="Subtitles"
            options={[{ value: '-1', label: 'Off' }, ...tracks(subs)]}
            value={selected(subs)}
            onSelect={(value) => onPick('sid', Number(value))}
          />
        ) : picker === 'audio' ? (
          <OptionRow
            ariaLabel="Audio track"
            options={tracks(audio)}
            value={selected(audio)}
            onSelect={(value) => onPick('aid', Number(value))}
          />
        ) : picker === 'speed' ? (
          <OptionRow
            ariaLabel="Playback speed"
            options={SPEEDS.map((speed) => ({ value: String(speed), label: speedLabel(speed) }))}
            value={String(player.speed)}
            onSelect={(value) => onPick('speed', Number(value))}
          />
        ) : (
          <>
            <OptionRow
              ariaLabel="Send to a display"
              options={player.screens.map((name, index) => ({ value: String(index), label: name, icon: 'desktop' }))}
              value={undefined}
              onSelect={(value) => onPick('screen', Number(value))}
            />
            <p class="sheet-hint">IINA moves to that display and goes full screen.</p>
          </>
        )}
      </SheetSection>
    </Sheet>
  );
}

/**
 * Plex's Continue Watching, on an idle card: the shortest way from "nothing
 * playing" to the thing you were watching. Only when Plex is set up.
 */
function ContinueWatching({ mac }: { mac: string }) {
  const [items, setItems] = useState<PlexItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const plexOn = health.value?.plex === true;

  useEffect(() => {
    if (!plexOn) return;
    let stale = false;
    plex({ kind: 'home' })
      .then((result) => {
        if (stale || result.kind !== 'home') return;
        const deck = result.sections.find((section) => section.title === 'Continue Watching');
        setItems((deck?.items ?? []).filter((item) => item.playable).slice(0, CONTINUE_MAX));
      })
      .catch(() => {
        if (!stale) setItems([]);
      });
    return () => {
      stale = true;
    };
  }, [plexOn, mac]);

  if (!plexOn || !items?.length) return null;
  return (
    <div class="iina-continue">
      <span class="apple-tv-app">Continue Watching</span>
      <div class="iina-continue-row">
        {items.map((item) => (
          <Pressable
            key={item.id}
            class="iina-continue-item"
            disabled={busy !== null}
            ariaLabel={`Play ${item.title} on this Mac`}
            onPress={() => {
              setBusy(item.id);
              markActivity();
              plex({ kind: 'play', id: item.id, target: `mac:${mac}`, resume: true })
                .catch((error: unknown) => showToast(error instanceof Error ? error.message : 'Could not start playback', 'error'))
                .finally(() => setBusy(null));
            }}
          >
            <Artwork src={item.art} icon="tv" />
            {busy === item.id ? <span class="spinner iina-continue-spinner" /> : null}
            <span class="iina-continue-title truncate">{item.title}</span>
            {item.subtitle ? <span class="iina-continue-sub truncate">{item.subtitle}</span> : null}
          </Pressable>
        ))}
      </div>
    </div>
  );
}

function speedLabel(speed: number): string {
  return `${speed}×`;
}
