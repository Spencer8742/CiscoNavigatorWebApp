import { useEffect, useState } from 'preact/hooks';
import { RemoteButton } from '~/components/AppleTvRemote.tsx';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Progress } from '~/components/Progress.tsx';
import { Slider } from '~/components/Slider.tsx';
import { getToken } from '~/net/auth.ts';
import { iinaCommand } from '~/net/socket.ts';
import { markActivity } from '~/state/ui.ts';
import type { IinaCommand, IinaState } from '@shared/protocol.ts';

/**
 * IINA on a Mac, as a card on the Apple TV screen.
 *
 * What it shows is read from mpv every few seconds while something plays;
 * opening the card asks for a reading straight away, so it is not blank
 * until the next one. Volume is IINA's own, not the Mac's: it is the player
 * being driven here, and the Mac may be playing something else as well.
 */
export function IinaRemote({ player }: { player: IinaState }) {
  useEffect(() => {
    iinaCommand(player.id, 'status');
  }, [player.id]);

  const send = (op: IinaCommand, value?: number) => {
    iinaCommand(player.id, op, value);
    markActivity();
  };
  const active = player.active;
  const volume = Math.round(player.volume ?? 100);
  const token = getToken();
  // A poster that will not load falls back to the icon rather than a broken
  // image; a different poster deserves a fresh try.
  const [artFailed, setArtFailed] = useState(false);
  useEffect(() => setArtFailed(false), [player.art]);
  const art = active && player.art && !artFailed ? player.art : null;

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
            {active ? null : <span>Play something from the Plex page on this Mac.</span>}
            {active && player.duration && player.duration > 0 ? (
              <Progress
                elapsed={player.position}
                elapsedAt={player.positionAt}
                duration={player.duration}
                running={!player.paused}
                onSeek={(seconds) => send('seek', seconds)}
              />
            ) : null}
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
            </div>
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
                readout={player.muted ? 'Muted' : `${volume}%`}
                ariaLabel={`${player.name} IINA volume`}
                disabled={!active}
                // Each change is a login on the Mac, so only where the finger
                // stops is sent, not every step on the way.
                onChange={(value, final) => {
                  if (final) send('volume', value);
                }}
              />
            </div>
          </div>
        </div>
      </div>
      {player.error ? <p class="apple-tv-error">{player.error}</p> : null}
    </section>
  );
}
