import { Sheet } from '~/components/Sheet.tsx';
import { controlFor } from '~/domains/controls.tsx';
import { describe, friendlyName } from '~/domains/registry.ts';
import { entity } from '~/state/entities.ts';
import { openEntity } from '~/state/ui.ts';
import { domainOf } from '~/lib/format.ts';
import { config } from '~/config/index.ts';

/**
 * The detail sheet for whichever entity is open.
 *
 * Mounted once at the shell level and driven by the `openEntity` signal, so
 * any screen can open a sheet by writing one value — no prop drilling, no
 * per-screen modal state, and only one sheet can ever be open.
 */
export function EntitySheet() {
  const id = openEntity.value;
  if (!id) return null;

  const state = entity(id).value;
  const close = () => {
    openEntity.value = null;
  };

  // The display name from dashboard.yaml wins here too, so the sheet title
  // matches the tile that opened it.
  const name = configuredName(id) ?? friendlyName(state, id);

  if (!state) {
    return (
      <Sheet title={name} subtitle={id} onClose={close}>
        <div class="sheet-hint">
          This entity is not currently reported by Home Assistant. Check the
          entity ID in dashboard.yaml.
        </div>
      </Sheet>
    );
  }

  const described = describe(state, id, name);
  const Control = controlFor(domainOf(id));

  return (
    <Sheet title={name} subtitle={described.value} onClose={close}>
      {described.unavailable ? (
        <div class="sheet-hint">
          Unavailable — Home Assistant cannot reach this device right now.
        </div>
      ) : (
        <Control state={state} id={id} />
      )}
    </Sheet>
  );
}

/**
 * Find a display-name override for this entity anywhere in the config.
 *
 * Scans rather than indexes: the config has tens of entries, this runs once
 * per sheet open, and a lookup map would need invalidating on every config
 * reload for no measurable gain.
 */
function configuredName(id: string): string | undefined {
  const cfg = config.value;

  for (const room of cfg.rooms) {
    const ref = room.entities.find((e) => e.entity === id);
    if (ref?.name) return ref.name;
  }
  for (const ref of cfg.home.favorites) {
    if (ref.entity === id && ref.name) return ref.name;
  }
  for (const ref of cfg.home.scenes) {
    if (ref.entity === id && ref.name) return ref.name;
  }
  for (const item of cfg.home.status) {
    if (item.entity === id && item.label) return item.label;
  }
  for (const p of cfg.media.players) {
    if (p.entity === id && p.name) return p.name;
  }
  return undefined;
}
