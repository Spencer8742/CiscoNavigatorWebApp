import { useEffect, useState } from 'preact/hooks';
import { AppleTvRemote } from '~/components/AppleTvRemote.tsx';
import { Empty } from '~/components/Empty.tsx';
import { PlexBrowser } from '~/components/PlexBrowser.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { appleTvs } from '~/state/controls.ts';
import { health, markActivity } from '~/state/ui.ts';

type View = 'remote' | 'plex';

export function AppleTv() {
  const devices = appleTvs.value;
  const [selected, setSelected] = useState(devices[0]?.id ?? '');
  const [view, setView] = useState<View>('remote');
  const active = devices.find((device) => device.id === selected) ?? devices[0] ?? null;
  // Plex is a tab only when the backend has a server to browse. Configured,
  // not reachable: a Plex that is down says so inside the tab.
  const plexEnabled = health.value?.plex === true;
  const current: View = plexEnabled ? view : 'remote';

  useEffect(() => {
    if (active && active.id !== selected) setSelected(active.id);
  }, [active?.id, selected]);

  return (
    <div class="screen screen-enter">
      <div class="screen-head">
        <h1 class="screen-title">Apple TV</h1>
        {active && current === 'remote' ? <span class="screen-sub truncate">{active.name}</span> : null}
        {plexEnabled ? (
          <div class="segmented apple-tv-views" role="tablist" aria-label="Apple TV views">
            {(['remote', 'plex'] as const).map((id) => (
              <Pressable
                key={id}
                class={id === current ? 'seg-item is-active' : 'seg-item'}
                onPress={() => { setView(id); markActivity(); }}
                ariaLabel={id === 'remote' ? 'Remote' : 'Plex'}
                ariaPressed={id === current}
              >
                {id === 'remote' ? 'Remote' : 'Plex'}
              </Pressable>
            ))}
          </div>
        ) : null}
      </div>
      {/* The switcher stays on the Plex tab too: which Apple TV is selected
          is the one "Play on" offers first. */}
      {devices.length > 1 ? (
        <div class="apple-tv-switcher" role="tablist" aria-label="Apple TVs">
          {devices.map((device) => (
            <Pressable
              key={device.id}
              class={device.id === active?.id ? 'apple-tv-switch is-active' : 'apple-tv-switch'}
              onPress={() => { setSelected(device.id); markActivity(); }}
              ariaLabel={device.name}
              ariaPressed={device.id === active?.id}
            >
              <span class="status-dot" data-state={device.reachable ? 'connected' : 'disconnected'} />
              <span class="truncate">{device.name}</span>
            </Pressable>
          ))}
        </div>
      ) : null}
      <div class="screen-body scroll">
        {current === 'plex' ? (
          <PlexBrowser preferred={active?.id ?? null} />
        ) : active ? <AppleTvRemote tv={active} /> : (
          <Empty icon="tv" title="No Apple TVs configured">
            Add devices under <code>controls.appleTvs</code> in <code>dashboard.yaml</code>.
          </Empty>
        )}
      </div>
    </div>
  );
}
