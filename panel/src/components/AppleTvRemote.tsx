import { useState } from 'preact/hooks';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Progress } from '~/components/Progress.tsx';
import { appleTvCommand, pairAppleTv } from '~/net/socket.ts';
import { markActivity } from '~/state/ui.ts';
import type { AppleTvCommand, AppleTvState } from '@shared/protocol.ts';

export function AppleTvRemote({ tv }: { tv: AppleTvState }) {
  const [pin, setPin] = useState('');
  const send = (op: AppleTvCommand) => {
    appleTvCommand(tv.id, op);
    markActivity();
  };
  const status = tv.pairing === 'pin' ? 'Enter PIN from TV' : tv.reachable ?
    (tv.power === 'off' ? 'Off' : 'Connected') : 'Unavailable';

  return (
    <section class="apple-tv-card">
      <header class="apple-tv-head">
        <div class="apple-tv-identity">
          <span class="apple-tv-logo"><Icon name="tv" size="1.5rem" /></span>
          <div>
            <h2>{tv.name}</h2>
            <span class="apple-tv-status" data-live={tv.reachable ? '' : undefined}>{status}</span>
          </div>
        </div>
        <Pressable
          class="apple-tv-power"
          tone={tv.power === 'on' ? 'accent' : undefined}
          onPress={() => send(tv.power === 'on' ? 'power_off' : 'power_on')}
          ariaLabel={tv.power === 'on' ? `Turn off ${tv.name}` : `Turn on ${tv.name}`}
        ><Icon name="power" size="1.35rem" /></Pressable>
      </header>

      {!tv.paired || tv.pairing === 'pin' || tv.pairing === 'starting' || tv.pairing === 'error' ? (
        <Pairing tv={tv} pin={pin} setPin={setPin} />
      ) : null}

      <div class="apple-tv-content">
        <div class="apple-tv-now">
          <span class="apple-tv-app">{tv.app ?? (tv.mediaType === 'unknown' ? 'Apple TV' : tv.mediaType)}</span>
          <strong>{tv.title ?? (tv.power === 'off' ? 'Apple TV is off' : 'Nothing playing')}</strong>
          <span>{tv.artist ?? tv.album ?? 'Use the remote to choose something to watch.'}</span>
          {tv.duration && tv.duration > 0 ? (
            <Progress
              elapsed={tv.elapsed}
              elapsedAt={tv.elapsedAt}
              duration={tv.duration}
              running={tv.playback === 'playing'}
            />
          ) : null}
          <div class="apple-tv-transport">
            <RemoteButton icon="chevronLeft" label="Previous" onPress={() => send('previous')} />
            <RemoteButton
              icon={tv.playback === 'playing' ? 'pause' : 'play'}
              label={tv.playback === 'playing' ? 'Pause' : 'Play'}
              primary
              onPress={() => send('play_pause')}
            />
            <RemoteButton icon="next" label="Next" onPress={() => send('next')} />
          </div>
        </div>

        <div class="apple-tv-remote" aria-label={`${tv.name} remote`}>
          <div class="apple-tv-pad">
            <RemoteButton icon="chevronUp" label="Up" onPress={() => send('up')} class="atv-up" />
            <RemoteButton icon="chevronLeft" label="Left" onPress={() => send('left')} class="atv-left" />
            <Pressable class="atv-select" onPress={() => send('select')} ariaLabel="Select">OK</Pressable>
            <RemoteButton icon="chevronRight" label="Right" onPress={() => send('right')} class="atv-right" />
            <RemoteButton icon="chevronDown" label="Down" onPress={() => send('down')} class="atv-down" />
          </div>
          <div class="apple-tv-keys">
            <Pressable onPress={() => send('menu')} ariaLabel="Back">Back</Pressable>
            <Pressable onPress={() => send('home')} ariaLabel="Home"><Icon name="home" size="1.2rem" /> Home</Pressable>
            <Pressable onPress={() => send('volume_down')} ariaLabel="Volume down"><Icon name="volumeDown" size="1.2rem" /></Pressable>
            <Pressable onPress={() => send('volume_up')} ariaLabel="Volume up"><Icon name="volumeUp" size="1.2rem" /></Pressable>
          </div>
        </div>
      </div>
      {tv.error && !tv.reachable ? <p class="apple-tv-error">{tv.error}</p> : null}
    </section>
  );
}

function Pairing({ tv, pin, setPin }: {
  tv: AppleTvState;
  pin: string;
  setPin: (value: string) => void;
}) {
  if (tv.pairing !== 'pin') {
    return (
      <div class="apple-tv-pair">
        <span>{tv.pairing === 'starting' ? 'Starting secure pairing…' : 'Pair once to enable the remote.'}</span>
        <Pressable disabled={tv.pairing === 'starting'} onPress={() => pairAppleTv(tv.id, 'begin')} ariaLabel={`Pair ${tv.name}`}>
          Pair Apple TV
        </Pressable>
      </div>
    );
  }
  return (
    <div class="apple-tv-pair">
      <label for={`atv-pin-${tv.id}`}>PIN shown on the Apple TV</label>
      <input
        id={`atv-pin-${tv.id}`}
        value={pin}
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={6}
        placeholder="0000"
        onInput={(event) => setPin(event.currentTarget.value.replace(/\D/g, '').slice(0, 6))}
      />
      <Pressable disabled={pin.length < 4} onPress={() => pairAppleTv(tv.id, 'pin', pin)} ariaLabel="Finish pairing">Connect</Pressable>
      <Pressable onPress={() => pairAppleTv(tv.id, 'cancel')} ariaLabel="Cancel pairing">Cancel</Pressable>
    </div>
  );
}

function RemoteButton({ icon, label, onPress, primary = false, class: cls = '' }: {
  icon: string;
  label: string;
  onPress: () => void;
  primary?: boolean;
  class?: string;
}) {
  return (
    <Pressable class={`apple-tv-key ${primary ? 'is-primary' : ''} ${cls}`} onPress={onPress} ariaLabel={label}>
      <Icon name={icon} size="1.35rem" />
    </Pressable>
  );
}
