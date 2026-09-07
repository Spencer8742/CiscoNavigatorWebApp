import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Progress } from '~/components/Progress.tsx';
import { appleTvCommand, appleTvSwipe, launchAppleTvApp, pairAppleTv } from '~/net/socket.ts';
import { markActivity } from '~/state/ui.ts';
import { getToken } from '~/net/auth.ts';
import { controlsConfig } from '~/config/index.ts';
import { AppleTvServiceLogo } from '~/components/AppleTvServiceLogo.tsx';
import type { AppleTvCommand, AppleTvState } from '@shared/protocol.ts';

/**
 * How long the remote sits untouched before it folds away.
 *
 * Long enough to read what is on screen and press again without it closing
 * under your hand; short enough that the artwork is back by the time anyone
 * looks at the panel again.
 */
const REMOTE_IDLE_MS = 30_000;

export function AppleTvRemote({ tv }: { tv: AppleTvState }) {
  const [pin, setPin] = useState('');

  /*
   * The remote and the artwork share one row and always have -- this never
   * stacks them, at any width. What gives on a narrow screen is the SPLIT:
   * an open remote takes the space it needs and the artwork shrinks to a
   * thumbnail, and closing the remote hands it all back.
   */
  const [remoteOpen, setRemoteOpen] = useState(true);
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const keepOpen = () => {
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(() => setRemoteOpen(false), REMOTE_IDLE_MS);
  };

  useEffect(() => {
    if (!remoteOpen) return;
    keepOpen();
    return () => {
      if (idle.current) clearTimeout(idle.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteOpen]);

  // A different Apple TV is a fresh start: you switched to it in order to use
  // it, so it should not hand you a folded remote left over from the last one.
  useEffect(() => setRemoteOpen(true), [tv.id]);
  const token = getToken();
  const shortcuts = controlsConfig.value.appleTvs.find((device) => device.id === tv.id)?.shortcuts ?? [];
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

      <div class="apple-tv-content" data-remote={remoteOpen ? 'open' : 'closed'}>
        <div class="apple-tv-media">
          <div class="apple-tv-art" data-empty={tv.artwork ? undefined : ''}>
            {tv.artwork ? (
              <img src={`${tv.artwork}${token ? `&t=${encodeURIComponent(token)}` : ''}`} alt="" />
            ) : <Icon name={tv.mediaType === 'music' ? 'media' : 'tv'} size="3rem" />}
          </div>
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
        </div>

        {remoteOpen ? (
        /* One handler on the container rather than one per control: a swipe,
           a key and an app shortcut are all "still using it", and hanging the
           reset off the container cannot miss a control added later. */
        <div class="apple-tv-remote" aria-label={`${tv.name} remote`} onPointerDown={keepOpen}>
          <SwipePad tv={tv} send={send} />
          <div class="apple-tv-keys">
            <Pressable onPress={() => send('menu')} ariaLabel="Back">Back</Pressable>
            <Pressable onPress={() => send('home')} ariaLabel="Home"><Icon name="home" size="1.2rem" /> Home</Pressable>
            <Pressable onPress={() => send('volume_down')} ariaLabel="Volume down"><Icon name="volumeDown" size="1.2rem" /></Pressable>
            <Pressable onPress={() => send('volume_up')} ariaLabel="Volume up"><Icon name="volumeUp" size="1.2rem" /></Pressable>
          </div>
          {shortcuts.length ? (
            <div class="apple-tv-shortcuts" aria-label={`${tv.name} app shortcuts`}>
              {shortcuts.map((shortcut) => (
                <Pressable
                  key={shortcut.bundleId}
                  class="apple-tv-shortcut"
                  onPress={() => { launchAppleTvApp(tv.id, shortcut.bundleId); markActivity(); }}
                  ariaLabel={`Open ${shortcut.name}`}
                >
                  <AppleTvServiceLogo name={shortcut.name} bundleId={shortcut.bundleId} />
                </Pressable>
              ))}
            </div>
          ) : null}
        </div>
        ) : (
          <Pressable
            class="apple-tv-remote-open"
            onPress={() => {
              setRemoteOpen(true);
              markActivity();
            }}
            ariaLabel={`Show ${tv.name} remote`}
          >
            <Icon name="expand" size="1.4rem" />
          </Pressable>
        )}
      </div>
      {tv.error && !tv.reachable ? <p class="apple-tv-error">{tv.error}</p> : null}
    </section>
  );
}

interface DragGesture {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  startedAt: number;
}

function SwipePad({ tv, send }: { tv: AppleTvState; send: (op: AppleTvCommand) => void }) {
  const [drag, setDrag] = useState<DragGesture | null>(null);
  const point = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.round(Math.max(0, Math.min(1000, ((event.clientX - rect.left) / rect.width) * 1000))),
      y: Math.round(Math.max(0, Math.min(1000, ((event.clientY - rect.top) / rect.height) * 1000))),
    };
  };
  const finish = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const end = point(event);
    const distance = Math.hypot(end.x - drag.startX, end.y - drag.startY);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDrag(null);
    if (distance < 80) {
      send('select');
      return;
    }
    appleTvSwipe(tv.id, {
      startX: drag.startX,
      startY: drag.startY,
      endX: end.x,
      endY: end.y,
      durationMs: Math.max(100, Math.min(2000, Math.round(performance.now() - drag.startedAt))),
    });
    markActivity();
  };
  const keyboard = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
    const commands: Record<string, AppleTvCommand> = {
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
      Enter: 'select', ' ': 'select',
    };
    const command = commands[event.key];
    if (!command) return;
    event.preventDefault();
    send(command);
  };
  const x = drag ? drag.currentX / 10 : 50;
  const y = drag ? drag.currentY / 10 : 50;

  return (
    <div class="apple-tv-touch-wrap">
      <div
        class="apple-tv-touchpad"
        role="button"
        tabIndex={0}
        aria-label="Swipe to navigate, tap to select"
        data-dragging={drag ? '' : undefined}
        onKeyDown={keyboard}
        onPointerDown={(event) => {
          if (!event.isPrimary) return;
          const start = point(event);
          event.currentTarget.setPointerCapture(event.pointerId);
          setDrag({
            pointerId: event.pointerId,
            startX: start.x,
            startY: start.y,
            currentX: start.x,
            currentY: start.y,
            startedAt: performance.now(),
          });
          markActivity();
        }}
        onPointerMove={(event) => {
          if (!drag || event.pointerId !== drag.pointerId) return;
          const current = point(event);
          setDrag({ ...drag, currentX: current.x, currentY: current.y });
        }}
        onPointerUp={finish}
        onPointerCancel={() => setDrag(null)}
      >
        <span class="apple-tv-touch-glow" style={{ left: `${x}%`, top: `${y}%` }} />
        <span class="apple-tv-touch-mark"><Icon name="tv" size="2rem" /></span>
      </div>
      <span class="apple-tv-touch-hint">Swipe to navigate · Tap to select</span>
    </div>
  );
}

function Pairing({ tv, pin, setPin }: {
  tv: AppleTvState;
  pin: string;
  setPin: (value: string) => void;
}) {
  if (tv.pairing !== 'pin') {
    const target = tv.pairingTarget === 'media' ? 'media access' : 'remote control';
    return (
      <div class="apple-tv-pair">
        <span>{tv.pairing === 'starting' ? `Starting secure ${target} pairing…` : `Pair ${target} to finish setup.`}</span>
        <Pressable disabled={tv.pairing === 'starting'} onPress={() => pairAppleTv(tv.id, 'begin')} ariaLabel={`Pair ${tv.name}`}>
          Pair {tv.pairingTarget === 'media' ? 'Media Access' : 'Apple TV'}
        </Pressable>
      </div>
    );
  }
  return (
    <div class="apple-tv-pair">
      <label for={`atv-pin-${tv.id}`}>Enter the PIN shown on the Apple TV for {tv.pairingTarget ?? 'secure access'}</label>
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
