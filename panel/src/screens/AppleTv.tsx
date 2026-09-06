import { useEffect, useState } from 'preact/hooks';
import { AppleTvRemote } from '~/components/AppleTvRemote.tsx';
import { Empty } from '~/components/Empty.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { appleTvs } from '~/state/controls.ts';
import { markActivity } from '~/state/ui.ts';

export function AppleTv() {
  const devices = appleTvs.value;
  const [selected, setSelected] = useState(devices[0]?.id ?? '');
  const active = devices.find((device) => device.id === selected) ?? devices[0] ?? null;

  useEffect(() => {
    if (active && active.id !== selected) setSelected(active.id);
  }, [active?.id, selected]);

  return (
    <div class="screen screen-enter">
      <div class="screen-head">
        <h1 class="screen-title">Apple TV</h1>
        {active ? <span class="screen-sub truncate">{active.name}</span> : null}
      </div>
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
        {active ? <AppleTvRemote tv={active} /> : (
          <Empty icon="tv" title="No Apple TVs configured">
            Add devices under <code>controls.appleTvs</code> in <code>dashboard.yaml</code>.
          </Empty>
        )}
      </div>
    </div>
  );
}
