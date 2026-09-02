import { Sheet, SheetSection, OptionRow } from '~/components/Sheet.tsx';
import { entity } from '~/state/entities.ts';
import { selectOption } from '~/state/actions.ts';
import { markActivity, openSources } from '~/state/ui.ts';

/**
 * The input picker itself.
 *
 * One sheet for the screen, driven by the `openSources` signal, exactly as
 * the entity sheet is — so only one can ever be open.
 */
export function SourcesSheet() {
  const id = openSources.value;
  if (!id) return null;

  const state = entity(id).value;
  const close = (): void => {
    openSources.value = null;
    markActivity();
  };

  const list = state?.a['source_list'];
  const sources = Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [];
  const current = typeof state?.a['source'] === 'string' ? (state.a['source'] as string) : undefined;
  const name = typeof state?.a['friendly_name'] === 'string' ? state.a['friendly_name'] : 'Input';

  return (
    <Sheet title={name} subtitle={current ? `Currently ${current}` : undefined} onClose={close}>
      <SheetSection>
        {sources.length > 0 ? (
          <OptionRow
            options={sources.map((s) => ({ value: s, label: s }))}
            value={current}
            ariaLabel="Input"
            onSelect={(value) => {
              selectOption(id, value);
              close();
            }}
          />
        ) : (
          /* An empty list is not the same as a broken panel, and on a kiosk
             the difference has to be written down or nobody can tell. */
          <div class="sheet-hint">
            {state
              ? 'Home Assistant is not reporting any inputs for this device. It usually publishes them only while the device is on.'
              : 'Waiting for Home Assistant.'}
          </div>
        )}
      </SheetSection>
    </Sheet>
  );
}
