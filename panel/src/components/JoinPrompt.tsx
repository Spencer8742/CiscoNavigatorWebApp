import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { entity } from '~/state/entities.ts';
import { pressButton } from '~/state/actions.ts';
import { dismissedJoin, markActivity, prefs } from '~/state/ui.ts';
import { controlPages, timeOpts } from '~/config/index.ts';
import { now } from '~/state/clock.ts';
import type { TimeOpts } from '~/lib/format.ts';
import {
  clockOf,
  isDue,
  joinTargetOf,
  keyOf,
  readMeetings,
  type Meeting,
} from '~/lib/meetings.ts';
import type { DeviceEntities } from '@shared/config.ts';

/**
 * The five-minutes-to-go prompt.
 *
 * A badge on a row in a list is easy to walk past. This is the same offer
 * made unmissable, for the one moment it matters: somebody is at the desk and
 * a meeting is about to start.
 *
 * It takes itself away rather than needing to be managed. Four things close
 * it, and only one of them is the dismiss button:
 *
 *  - the meeting starts being joined (`inCall` goes on),
 *  - the meeting ends,
 *  - the device stops offering it as the joinable one,
 *  - or somebody says not now.
 *
 * The same honesty rule as the row badge applies: `join_next_meeting` takes
 * no argument, so this only ever names the booking that button will dial
 * (see `joinTargetOf`).
 */
export function JoinPrompt({
  entities: e,
  global,
}: {
  entities: DeviceEntities;
  /** Drawn over every screen, the screensaver included. See `MeetingAlerts`. */
  global?: boolean;
}) {
  const meetings = readMeetings(e.meetings ? entity(e.meetings).value : null);
  const inCall = e.inCall ? entity(e.inCall).value : null;
  const dismissed = dismissedJoin.value;
  const at = now.value;
  const t = timeOpts.value;

  if (!e.join || inCall?.s === 'on') return null;

  const target = joinTargetOf(meetings, at);
  if (!target || !isDue(target, at)) return null;
  if (dismissed === keyOf(target)) return null;

  return (
    <div class="joinprompt" data-global={global ? '' : undefined}>
      <div class="joinprompt-card">
        <div class="joinprompt-when">
          <Icon name="clock" size="1rem" weight={1.9} />
          <span>{startsIn(target, at, t)}</span>
        </div>

        <div class="joinprompt-title">{target.title}</div>
        {target.organizer ? (
          <div class="joinprompt-org truncate">{target.organizer}</div>
        ) : null}

        <div class="joinprompt-actions">
          <Pressable
            class="joinprompt-join"
            tone="ok"
            onPress={() => {
              pressButton(e.join!);
              // Waved away as well as joined: the device takes a moment to
              // report the call, and the prompt should not sit there through
              // it looking as though the press did nothing.
              dismissedJoin.value = keyOf(target);
              markActivity();
            }}
            ariaLabel={`Join ${target.title}`}
          >
            <Icon name="camera" size="1.25rem" weight={1.8} />
            <span>Join</span>
          </Pressable>

          <Pressable
            class="joinprompt-later"
            onPress={() => {
              dismissedJoin.value = keyOf(target);
              markActivity();
            }}
            ariaLabel="Dismiss"
          >
            <span>Not now</span>
          </Pressable>
        </div>
      </div>
    </div>
  );
}

/** "Starts in 4 min" / "Started 10:30 AM" — never a bare countdown to zero. */
function startsIn(m: Meeting, at: Date, t: TimeOpts): string {
  const start = m.start_time ? Date.parse(m.start_time) : NaN;
  if (!Number.isFinite(start)) return 'Starting now';

  const mins = Math.round((start - at.getTime()) / 60_000);
  if (mins > 1) return `Starts in ${mins} min`;
  if (mins >= 0) return 'Starts now';
  // Already running. The clock is more use than "3 minutes ago" for somebody
  // working out whether they are the one holding it up.
  return `Started ${clockOf(m.start_time, t)}`;
}

/**
 * The join prompt for every device, over whatever is on screen.
 *
 * Off by default (`meetingPromptEverywhere`): normally the prompt belongs to
 * its device's page, and a panel on the Lights page or showing photos is not
 * the place for it. Turned on, a meeting about to start breaks through the
 * screensaver and every other screen — for a panel that IS the meeting
 * room's, where missing the start is the thing to prevent.
 *
 * Mounted once at the app root. Each device appears once however many pages
 * carry its tile.
 */
export function MeetingAlerts() {
  if (!prefs.value.meetingPromptEverywhere) return null;
  const seen = new Set<string>();
  const devices: DeviceEntities[] = [];
  for (const page of controlPages.value) {
    for (const item of page.items) {
      if (item.type !== 'device' || !item.entities.join || !item.entities.meetings) continue;
      if (seen.has(item.entities.join)) continue;
      seen.add(item.entities.join);
      devices.push(item.entities);
    }
  }
  return (
    <>
      {devices.map((e) => (
        <JoinPrompt key={e.join} entities={e} global />
      ))}
    </>
  );
}
