import { Icon } from '~/components/Icon.tsx';
import { connectionProblem, socketState } from '~/state/ui.ts';
import { deviceInfo } from '~/lib/device.ts';

/**
 * Shown instead of the boot spinner when the panel has never managed to
 * connect and we have worked out why.
 *
 * Written for someone standing in front of a wall-mounted Navigator with no
 * address bar, no console and no laptop. That means:
 *
 *  - say what is wrong in a sentence, not a stack trace
 *  - give exactly one action to take, in a form that can be typed
 *  - keep retrying in the background and disappear the moment it works,
 *    so no one has to power-cycle anything
 */
export function ConnectionHelp() {
  const problem = connectionProblem.value;
  if (!problem) return null;

  const dev = deviceInfo();

  return (
    <div class="screen help">
      <div class="help-body">
        <div class="help-icon" data-kind={problem.kind}>
          <Icon
            name={problem.kind === 'unauthorized' ? 'lock' : 'linkOff'}
            size="2.25rem"
            weight={1.5}
          />
        </div>

        <h1 class="help-title">{problem.title}</h1>
        <p class="help-detail">{problem.detail}</p>

        {/* The fix is the point of this screen, so it gets the emphasis. */}
        <div class="help-fix">{problem.fix}</div>

        <div class="help-foot">
          <span class="status-dot" data-state={socketState.value} />
          <span>
            Still retrying — this screen disappears on its own once the panel
            connects.
          </span>
        </div>

        <div class="help-meta">
          {window.location.host} · {dev.isRoomOS ? (dev.model ?? 'RoomOS') : 'browser'} ·{' '}
          {__APP_VERSION__}
        </div>
      </div>
    </div>
  );
}
