import { Sheet, SheetSection, OptionRow } from '~/components/Sheet.tsx';
import { entity } from '~/state/entities.ts';
import { setEntityOption } from '~/state/actions.ts';
import { markActivity, openDeviceSource } from '~/state/ui.ts';

/**
 * The option picker for a device tile's share source.
 *
 * Mounted at the shell beside the other sheets, not inside the screen:
 * `.shell-main` is `position: relative; overflow: hidden`, so a sheet
 * rendered within a screen lays out against that box and ends up fighting
 * the nav instead of covering it.
 *
 * The options come from the entity's own `options` attribute — the connectors
 * this particular device actually has. Nothing to configure, and nothing to
 * go stale when a cable moves.
 */
export function DeviceSourceSheet() {
  const id = openDeviceSource.value;
  if (!id) return null;

  const state = entity(id).value;
  const close = (): void => {
    openDeviceSource.value = null;
    markActivity();
  };

  const raw = state?.a['options'];
  const options = Array.isArray(raw) ? raw.filter((o): o is string => typeof o === 'string') : [];
  const current = state && state.s !== 'unavailable' ? state.s : undefined;
  const name =
    typeof state?.a['friendly_name'] === 'string' ? (state.a['friendly_name'] as string) : 'Source';

  return (
    <Sheet title={name} subtitle={current ? `Currently ${current}` : undefined} onClose={close}>
      <SheetSection>
        {options.length > 0 ? (
          <div class="source-picker">
            <OptionRow
              options={options.map((o) => ({ value: o, label: o }))}
              value={current}
              ariaLabel="Share source"
              onSelect={(value) => {
                setEntityOption(id, value);
                close();
              }}
            />
          </div>
        ) : (
          <div class="sheet-hint">
            {state
              ? 'This device is not reporting any share sources.'
              : 'Waiting for Home Assistant.'}
          </div>
        )}
      </SheetSection>
    </Sheet>
  );
}
