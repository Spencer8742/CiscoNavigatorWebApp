import { Icon } from '~/components/Icon.tsx';
import { toast } from '~/state/ui.ts';

/**
 * The single transient message slot.
 *
 * Deliberately not a queue and never modal. A control panel that stacks
 * dismissible dialogs is a panel that eventually shows a dialog nobody
 * dismisses — and on a kiosk device there is no way for a user to escape one.
 * Errors here are informational; the UI behind them stays fully usable.
 */
export function Toast() {
  const t = toast.value;
  if (!t) return null;

  return (
    <div class="toast" data-kind={t.kind} role="status" aria-live="polite" key={t.id}>
      {t.kind === 'error' ? <Icon name="alert" size="1.125rem" /> : null}
      <span class="truncate">{t.message}</span>
    </div>
  );
}
