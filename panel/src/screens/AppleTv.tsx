import { useEffect } from 'preact/hooks';
import { AppleTvRemote } from '~/components/AppleTvRemote.tsx';
import { Empty } from '~/components/Empty.tsx';
import { IinaRemote } from '~/components/IinaRemote.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { appleTvs, iinaPlayers, selectedAppleTv } from '~/state/controls.ts';
import { markActivity } from '~/state/ui.ts';

/**
 * The Apple TVs, and IINA on any Mac marked `iina: true` beside them — the
 * other place Plex plays. A Mac is selected as `iina:<id>`, so one switcher
 * and one remembered choice cover both.
 */
export function AppleTv() {
  const devices = appleTvs.value;
  const macs = iinaPlayers.value;
  const entries = [
    ...devices.map((tv) => ({ key: tv.id, name: tv.name, live: tv.reachable })),
    ...macs.map((mac) => ({ key: `iina:${mac.id}`, name: mac.name, live: mac.active })),
  ];
  const selected = selectedAppleTv.value;
  const activeKey = entries.find((entry) => entry.key === selected)?.key ?? entries[0]?.key ?? null;
  const tv = devices.find((device) => device.id === activeKey) ?? null;
  const mac = activeKey?.startsWith('iina:') ? macs.find((item) => `iina:${item.id}` === activeKey) ?? null : null;

  useEffect(() => {
    if (activeKey && activeKey !== selected) selectedAppleTv.value = activeKey;
  }, [activeKey, selected]);

  return (
    <div class="screen screen-enter">
      <div class="screen-head">
        <h1 class="screen-title">Apple TV</h1>
        {tv ?? mac ? <span class="screen-sub truncate">{(tv ?? mac)?.name}</span> : null}
      </div>
      {entries.length > 1 ? (
        <div class="apple-tv-switcher" role="tablist" aria-label="Apple TVs and Macs">
          {entries.map((entry) => (
            <Pressable
              key={entry.key}
              class={entry.key === activeKey ? 'apple-tv-switch is-active' : 'apple-tv-switch'}
              onPress={() => { selectedAppleTv.value = entry.key; markActivity(); }}
              ariaLabel={entry.name}
              ariaPressed={entry.key === activeKey}
            >
              <span class="status-dot" data-state={entry.live ? 'connected' : 'disconnected'} />
              <span class="truncate">{entry.name}</span>
            </Pressable>
          ))}
        </div>
      ) : null}
      <div class="screen-body scroll">
        {tv ? <AppleTvRemote tv={tv} /> : mac ? <IinaRemote player={mac} /> : (
          <Empty icon="tv" title="No Apple TVs configured">
            Add devices under <code>controls.appleTvs</code> in <code>dashboard.yaml</code>, or a Mac
            under <code>controls.ssh</code> with <code>iina: true</code>.
          </Empty>
        )}
      </div>
    </div>
  );
}
