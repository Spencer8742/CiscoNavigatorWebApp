import { Pressable } from '~/components/Pressable.tsx';
import {
  disablePush,
  enablePush,
  pushBusy,
  pushCategories,
  pushStatus,
  sendTestPush,
  setPushCategory,
} from '~/net/push.ts';
import { showToast } from '~/state/ui.ts';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_INFO,
  type NotificationCategory,
} from '@shared/protocol.ts';

/**
 * Settings → Notifications.
 *
 * Absent on RoomOS: a wall panel is the screen, not something to notify. On
 * every other device it says plainly what this device can do, because the
 * reasons notifications cannot work — Safari rather than the home screen,
 * http rather than https, a refusal in system settings — each need something
 * different done, and none of them are fixed from here.
 *
 * One switch per entry in NOTIFICATION_CATEGORIES, drawn from the list, so a
 * new kind of notification gets its switch without this file changing.
 */
export function NotificationSettings() {
  const status = pushStatus.value;
  if (status === 'unsupported') return null;
  const busy = pushBusy.value;

  const run = async (action: () => Promise<string | null>, done?: string): Promise<void> => {
    const error = await action();
    if (error) showToast(error, 'error');
    else if (done) showToast(done);
  };

  return (
    <>
      <div class="section-head">
        <h2 class="section-title">Notifications</h2>
      </div>

      {status === 'on' ? (
        <>
          <div class="settings-page-grid" role="group" aria-label="Notification categories">
            {NOTIFICATION_CATEGORIES.map((category) => (
              <CategoryToggle key={category} category={category} busy={busy} />
            ))}
          </div>
          <div class="settings-actions">
            <Pressable
              class="settings-action"
              onPress={() => void run(sendTestPush, 'Test notification sent')}
              disabled={busy}
              ariaLabel="Send a test notification to this device"
            >
              Send a test
            </Pressable>
            <Pressable
              class="settings-action"
              onPress={() => void run(disablePush)}
              disabled={busy}
              ariaLabel="Turn off notifications on this device"
            >
              Turn off
            </Pressable>
          </div>
          <p class="settings-note">
            {NOTIFICATION_CATEGORIES.map((c) => (
              <span key={c}>
                <strong>{NOTIFICATION_CATEGORY_INFO[c].label}</strong>:{' '}
                {NOTIFICATION_CATEGORY_INFO[c].description}{' '}
              </span>
            ))}
            These choices are for this device only.
          </p>
        </>
      ) : status === 'off' ? (
        <>
          <div class="settings-actions">
            {/* A plain button, not a Pressable: Safari shows the permission
                prompt only from a click, and Pressable acts on pointerup. */}
            <button
              type="button"
              class="settings-action is-urgent"
              disabled={busy}
              onClick={() => void run(enablePush, 'Notifications are on')}
            >
              Turn on notifications
            </button>
          </div>
          <p class="settings-note">
            Lets the panel tell this device about things while the app is closed.
            Your device will ask for permission first.
          </p>
        </>
      ) : (
        <p class="settings-note">{EXPLAIN[status]}</p>
      )}
    </>
  );
}

const EXPLAIN: Record<'needs-install' | 'insecure' | 'denied' | 'unavailable', string> = {
  'needs-install':
    'On iPhone and iPad, notifications need the panel on your Home Screen. In Safari, tap Share, then Add to Home Screen, and open it from the new icon.',
  insecure:
    'Notifications need the panel served over HTTPS with a certificate this device trusts. See docs/DEPLOYMENT.md §2.',
  denied:
    'Notifications are blocked for this app. Allow them in this device’s settings (on iOS: Settings → Notifications → Home), then come back here.',
  unavailable:
    'The server could not set up notifications. Its log says why — usually a VAPID key in .env that does not match itself.',
};

function CategoryToggle({ category, busy }: { category: NotificationCategory; busy: boolean }) {
  const active = pushCategories.value.includes(category);
  const { label } = NOTIFICATION_CATEGORY_INFO[category];
  return (
    <Pressable
      class={active ? 'settings-page is-active' : 'settings-page'}
      onPress={() => {
        void setPushCategory(category, !active).then((error) => {
          if (error) showToast(error, 'error');
        });
      }}
      disabled={busy}
      ariaPressed={active}
      ariaLabel={`${label} notifications ${active ? 'on' : 'off'}`}
    >
      <span>{label}</span>
      <span class="settings-page-state">{active ? 'On' : 'Off'}</span>
    </Pressable>
  );
}
