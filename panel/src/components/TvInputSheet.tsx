import { Sheet, SheetSection, OptionRow } from '~/components/Sheet.tsx';
import { controlPages } from '~/config/index.ts';
import { selectTvInput } from '~/net/socket.ts';
import { markActivity, openTvInput } from '~/state/ui.ts';
import type { ControlTvInput } from '@shared/config.ts';

/**
 * The input picker for a television driven directly, rather than through a
 * Home Assistant `media_player`.
 *
 * The options come from the config rather than from the device, and that is
 * the point: a curated list is an assertion about what is plugged into which
 * socket, so the picker still works while the TV is off — which is exactly
 * when you are choosing what to look at and exactly when a set cannot be
 * asked what it has.
 *
 * No current-input highlight for the same reason. webOS will say which input
 * is live, but only while it is on, and a picker that shows a selection half
 * the time is worse than one that never claims to.
 */
export function TvInputSheet() {
  const id = openTvInput.value;
  if (!id) return null;

  const item = findItem(id);
  const close = (): void => {
    openTvInput.value = null;
    markActivity();
  };

  const options = (item?.inputs ?? []).map((i) => ({
    value: i.source,
    label: i.name ?? i.source,
  }));

  return (
    <Sheet title={item?.name ?? 'Input'} onClose={close}>
      <SheetSection>
        {options.length > 0 ? (
          <div class="source-picker">
            <OptionRow
              options={options}
              // No current input: webOS only reports one while it is on, and
              // a picker that shows a selection half the time is worse than
              // one that never claims to.
              value={undefined}
              ariaLabel="TV input"
              onSelect={(value) => {
                selectTvInput(id, value);
                close();
              }}
            />
          </div>
        ) : (
          <div class="sheet-hint">
            No inputs configured for this TV. Add an <code>inputs:</code> list to it under{' '}
            <code>controls.tvs</code> in <code>dashboard.yaml</code>.
          </div>
        )}
      </SheetSection>
    </Sheet>
  );
}

function findItem(id: string): ControlTvInput | undefined {
  for (const page of controlPages.value) {
    for (const item of page.items) {
      if (item.id === id && item.type === 'tvInput') return item;
    }
  }
  return undefined;
}
