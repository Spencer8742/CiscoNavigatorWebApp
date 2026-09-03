import { Sheet, SheetSection } from '~/components/Sheet.tsx';
import { Icon } from '~/components/Icon.tsx';
import { entity } from '~/state/entities.ts';
import { markActivity, openDeviceAlerts } from '~/state/ui.ts';

/**
 * What the device's active alerts actually are.
 *
 * The tile's footer has always shown a count — "4 alerts" — and a count with
 * no way to see the items is a notification that cannot be acted on. The
 * detail was already arriving: the integration puts up to ten of RoomOS's
 * `Status.Diagnostics.Message[]` entries in the sensor's `messages`
 * attribute, each with a level, a type and a description. Nothing was
 * reading them.
 *
 * These are the device's OWN diagnostics — camera pairing, touch panel
 * connection, certificates — not anything this panel decides. So the sheet
 * reports them and offers no action: there is nothing here it could fix.
 */
interface AlertMessage {
  level?: unknown;
  type?: unknown;
  description?: unknown;
}

export function DeviceAlertsSheet() {
  const id = openDeviceAlerts.value;
  if (!id) return null;

  const state = entity(id).value;
  const close = (): void => {
    openDeviceAlerts.value = null;
    markActivity();
  };

  const raw = state?.a['messages'];
  const messages: AlertMessage[] = Array.isArray(raw)
    ? (raw.filter((m) => m && typeof m === 'object') as AlertMessage[])
    : [];

  const count = Number(state?.s);

  return (
    <Sheet
      title="Device alerts"
      subtitle={Number.isFinite(count) ? `${count} active` : undefined}
      onClose={close}
    >
      <SheetSection>
        {messages.length > 0 ? (
          <div class="devalerts">
            {messages.map((m, i) => (
              <div class="devalerts-row" key={`${text(m.type)}-${i}`}>
                <Icon name="alert" size="1rem" weight={1.9} class="devalerts-icon" />
                <div class="devalerts-text">
                  <div class="devalerts-type">{text(m.type) || 'Alert'}</div>
                  {/* The description is the only part that says what to do
                      about it, so it wraps rather than truncating. */}
                  {text(m.description) ? (
                    <div class="devalerts-desc">{text(m.description)}</div>
                  ) : null}
                </div>
                {level(m.level) ? (
                  <span class="devalerts-level" data-level={level(m.level)}>
                    {level(m.level)}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div class="sheet-hint">
            {state
              ? 'The device reports no active alerts.'
              : 'Waiting for Home Assistant.'}
          </div>
        )}
        {/* RoomOS sends as many as it likes; the integration forwards ten.
            Saying so is better than silently showing a shorter list than the
            count above it. */}
        {Number.isFinite(count) && count > messages.length && messages.length > 0 ? (
          <div class="sheet-hint">
            Showing the first {messages.length} of {count}. The rest are on the device, under
            Settings → Issues and diagnostics.
          </div>
        ) : null}
      </SheetSection>
    </Sheet>
  );
}

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function level(v: unknown): string {
  return typeof v === 'string' && v ? v : '';
}
