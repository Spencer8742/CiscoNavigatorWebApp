import { useEffect, useState } from 'preact/hooks';
import { config, ui } from '~/config/index.ts';
import { health, linkStatus, prefs, socketState } from '~/state/ui.ts';
import { Pressable } from '~/components/Pressable.tsx';
import { setPref } from '~/net/socket.ts';
import type { PanelPrefs } from '@shared/protocol.ts';
import { entityCount } from '~/state/entities.ts';
import { speakers } from '~/state/selectors.ts';
import { formatRelative } from '~/lib/format.ts';
import { deviceInfo } from '~/lib/device.ts';

/**
 * Settings — read-only diagnostics.
 *
 * There is intentionally nothing to edit here. Cisco's own documentation is
 * blunt about the RoomOS soft keyboard: it has no numeric, date or colour
 * modes and "does not encourage a lot of text input" (docs/ROOMOS.md §6).
 * Configuration therefore lives in `config/dashboard.yaml` on the server,
 * where it can be edited properly and version-controlled.
 *
 * What this screen IS for: answering "why isn't it working?" while standing
 * in front of the panel. The viewport readout in particular is the fastest
 * way to confirm the CSS dimensions RoomOS actually hands us — a figure Cisco
 * does not publish for the Navigator, which is why the whole layout is fluid.
 */
export function Settings() {
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio,
  }));

  useEffect(() => {
    const onResize = () =>
      setViewport({
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio,
      });
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const cfg = config.value;
  const h = health.value;
  const dev = deviceInfo();

  return (
    <div class="screen screen-enter">
      <div class="screen-head">
        <h1 class="screen-title">Settings</h1>
        <span class="screen-sub">{__APP_VERSION__}</span>
      </div>

      <div class="screen-body scroll">
        <div class="section-head">
          <h2 class="section-title">Home screen</h2>
        </div>
        <div class="rows">
          <div class="rows-row">
            <span class="rows-key">Side card</span>
            <div class="segmented" role="group" aria-label="Home side card">
              <SegItem value="media" label="Now Playing" />
              <SegItem value="photos" label="Photos" />
            </div>
          </div>
        </div>
        <p class="settings-note">
          What fills the space beside Favorites. <strong>Now Playing</strong> shows
          the photo instead whenever nothing is playing, so the panel never has a
          hole in it. Stored on the server, because RoomOS clears the browser's
          storage nightly.
        </p>

        <div class="section-head">
          <h2 class="section-title">Connection</h2>
        </div>
        <div class="rows">
          <Row k="Panel → backend" v={socketState.value} tone={tone(socketState.value)} />
          <Row k="Backend → Home Assistant" v={h?.ha ?? '—'} tone={tone(h?.ha)} />
          <Row k="Backend → Immich" v={h?.immich ?? '—'} tone={tone(h?.immich)} />
          <Row
            k="Backend → Music Assistant"
            v={h?.mass ?? '—'}
            tone={h?.mass === 'disabled' ? undefined : tone(h?.mass)}
          />
          {/* The specific reason, when there is one. A missing MASS_TOKEN and
              an unreachable server both read as "disconnected" otherwise, and
              only one of them is fixed by restarting anything. */}
          {/* `danger`, not `bad`: the stylesheet defines ok / warn / danger,
              so the previous value styled nothing at all. */}
          {h?.massError ? <Row k="Music Assistant says" v={h.massError} tone="danger" /> : null}
          <Row
            k="Backend → Sonos"
            v={h?.sonos ?? '—'}
            tone={h?.sonos === 'disabled' ? undefined : tone(h?.sonos)}
          />
          {/* Same reasoning as the Music Assistant line above: a wrong
              address, a network that blocks discovery and UPnP switched off
              in the Sonos app all read as "disconnected", and each needs
              something different done about it. */}
          {/* Live or polled is the difference between a panel that keeps up
              with the house and one that lags behind it, and the cause is
              always deployment rather than anything on this screen. */}
          {h?.sonos === 'connected' ? (
            <Row
              k="Sonos updates"
              v={h.sonosUpdates === 'live' ? 'live' : 'polling'}
              tone={h.sonosUpdates === 'live' ? 'ok' : 'warn'}
            />
          ) : null}
          {h?.sonosError ? <Row k="Sonos says" v={h.sonosError} tone="danger" /> : null}
          <Row k="Overall" v={linkStatus.value} tone={tone(linkStatus.value)} />
          <Row
            k="Last HA message"
            v={h?.haLastMessage ? formatRelative(Date.parse(h.haLastMessage)) : '—'}
          />
          <Row k="Backend uptime" v={h ? formatUptime(h.uptime) : '—'} />
          <Row k="Backend version" v={h?.version ?? '—'} />
        </div>

        <div class="section-head">
          <h2 class="section-title">Dashboard</h2>
        </div>
        <div class="rows">
          <Row k="Title" v={cfg.ui.title} />
          <Row k="Rooms" v={String(cfg.rooms.length)} />
          <Row k="Favorites" v={String(cfg.home.favorites.length)} />
          <Row k="Scenes" v={String(cfg.home.scenes.length)} />
          <Row k="Speakers" v={String(speakers.value.length)} />
          <Row k="Live entities" v={String(entityCount())} />
          <Row k="Immich" v={cfg.immich.enabled ? 'enabled' : 'disabled'} />
          <Row k="Idle timeout" v={secs(cfg.idle.timeoutSeconds)} />
          <Row k="Return home after" v={secs(cfg.idle.returnHomeSeconds)} />
        </div>

        <div class="section-head">
          <h2 class="section-title">Display</h2>
        </div>
        <div class="rows">
          {/*
            The important one. docs/ROOMOS.md §7: Cisco publishes 1920x1080 for
            room displays but nothing for the Navigator, so the layout is fully
            fluid. This shows what the device actually reports.
          */}
          <Row k="Viewport (CSS px)" v={`${viewport.w} × ${viewport.h}`} />
          <Row k="Device pixel ratio" v={viewport.dpr.toFixed(2)} />
          <Row k="Root font size" v={rootFontSize()} />
          <Row k="Navigation" v={ui.value.navPosition} />
          <Row k="Blur effects" v={ui.value.blur ? 'on' : 'off'} />
          <Row k="Motion scale" v={String(ui.value.motion)} />
        </div>

        <div class="section-head">
          <h2 class="section-title">Device</h2>
        </div>
        <div class="rows">
          <Row k="RoomOS" v={dev.isRoomOS ? 'yes' : 'no'} tone={dev.isRoomOS ? 'ok' : undefined} />
          <Row k="Model" v={dev.model ?? '—'} />
          <Row k="Chromium" v={dev.chromeVersion ?? '—'} tone={chromeTone(dev.chromeVersion)} />
          <Row k="JSXAPI available" v={dev.hasXapi ? 'yes' : 'no'} />
          <Row k="Touch points" v={String(navigator.maxTouchPoints || 0)} />
          <Row k="Language" v={navigator.language} />
        </div>

        <div class="section-head">
          <h2 class="section-title">User agent</h2>
        </div>
        <div class="rows">
          <div class="rows-row settings-ua">{navigator.userAgent}</div>
        </div>

        <p class="settings-note">
          Configuration is edited in <code>config/dashboard.yaml</code> on the
          server and hot-reloads here. See <code>docs/DEPLOYMENT.md</code> for
          on-device debugging with remote Chrome DevTools.
        </p>
      </div>
    </div>
  );
}

/**
 * One option in the side-card picker.
 *
 * This screen is otherwise deliberately read-only — the RoomOS soft keyboard
 * has no numeric, date or colour modes and Cisco's own guidance is that it
 * "does not encourage a lot of text input" (docs/ROOMOS.md §6). A two-way
 * choice made by tapping is the one kind of setting that belongs on the
 * device rather than in the YAML.
 */
function SegItem({ value, label }: { value: PanelPrefs['homeSide']; label: string }) {
  const active = prefs.value.homeSide === value;
  return (
    <Pressable
      class={active ? 'seg-item is-active' : 'seg-item'}
      onPress={() => setPref('homeSide', value)}
      ariaPressed={active}
      ariaLabel={label}
    >
      {label}
    </Pressable>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div class="rows-row">
      <span class="rows-key">{k}</span>
      <span class="rows-val" data-tone={tone}>
        {v}
      </span>
    </div>
  );
}

function tone(state: string | undefined): string | undefined {
  if (state === 'connected') return 'ok';
  if (state === 'connecting') return 'warn';
  if (state === 'disconnected') return 'danger';
  return undefined;
}

/** Flags a device older than our build target, which would explain oddities. */
function chromeTone(version: string | null): string | undefined {
  if (!version) return undefined;
  const major = Number.parseInt(version, 10);
  if (!Number.isFinite(major)) return undefined;
  return major < 102 ? 'warn' : 'ok';
}

function rootFontSize(): string {
  return getComputedStyle(document.documentElement).fontSize;
}

function secs(n: number): string {
  if (n <= 0) return 'disabled';
  if (n < 60) return `${n} s`;
  const m = Math.floor(n / 60);
  const s = n % 60;
  return s === 0 ? `${m} min` : `${m} min ${s} s`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
