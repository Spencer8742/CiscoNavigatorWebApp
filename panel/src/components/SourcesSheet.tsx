import { Sheet, SheetSection, OptionRow } from '~/components/Sheet.tsx';
import { entity } from '~/state/entities.ts';
import { selectControlSource } from '~/net/socket.ts';
import { controlPages } from '~/config/index.ts';
import { markActivity, openSources } from '~/state/ui.ts';
import type { ControlSources } from '@shared/config.ts';

/**
 * The input picker for a `sources:` control key.
 *
 * One sheet for the whole app, driven by the `openSources` signal, exactly as
 * the entity sheet is — so only one can ever be open, and so it is mounted at
 * the shell rather than inside a screen (`.shell-main` is
 * `position: relative; overflow: hidden`, which a sheet mounted inside it
 * lays out against instead of the viewport).
 *
 * The list is the device's own `source_list`. Selecting sends the control
 * item's id and the chosen value; the backend resolves the entity and issues
 * select_source. The panel never composes the service call.
 */
export function SourcesSheet() {
  const itemId = openSources.value;
  if (!itemId) return null;

  const item = findSourcesItem(itemId);
  const close = (): void => {
    openSources.value = null;
    markActivity();
  };

  // The config changed out from under an open sheet — a hot reload that
  // deleted this key. Closing is the honest response to a control that no
  // longer exists.
  if (!item) {
    close();
    return null;
  }

  const state = entity(item.entity).value;
  const current = typeof state?.a['source'] === 'string' ? (state.a['source'] as string) : undefined;

  /*
   * A curated list wins over the device's, and does not depend on the device
   * answering — which is the point: source_list is usually empty while a TV
   * is off, and off is exactly when you reach for the input picker.
   */
  const reported = state?.a['source_list'];
  const options =
    item.inputs.length > 0
      ? item.inputs.map((i) => ({ value: i.source, label: i.name ?? i.source }))
      : Array.isArray(reported)
        ? reported
            .filter((s): s is string => typeof s === 'string')
            .map((s) => ({ value: s, label: s }))
        : [];

  // Say "Currently Laptop", not "Currently HDMI 2". Renaming an input and
  // then reporting it by its cable name undoes the rename in the one place
  // the two sit side by side.
  const currentLabel = current
    ? (options.find((o) => o.value === current)?.label ?? current)
    : undefined;

  return (
    <Sheet
      title={item.name}
      subtitle={currentLabel ? `Currently ${currentLabel}` : undefined}
      onClose={close}
    >
      <SheetSection>
        {options.length > 0 ? (
          /* Bigger targets than the shared option row: a short, curated list
             has the room, and this is pressed mid-call at arm's length. The
             class scopes it so hvac modes and the rest are untouched. */
          <div class="source-picker">
            <OptionRow
              options={options}
              value={current}
              ariaLabel="Input"
              onSelect={(value) => {
                selectControlSource(item.id, value);
                close();
              }}
            />
          </div>
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

function findSourcesItem(id: string): ControlSources | null {
  for (const page of controlPages.value) {
    for (const item of page.items) {
      if (item.type === 'sources' && item.id === id) return item;
    }
  }
  return null;
}
