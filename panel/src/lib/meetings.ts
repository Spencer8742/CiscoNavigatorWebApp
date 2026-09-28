import type { EntityState } from '@shared/protocol.ts';
import { bookingHasEnded, joinTargetOf as sharedJoinTargetOf } from '@shared/meetings.ts';
import { formatMeridiem, formatTime, type TimeOpts } from '~/lib/format.ts';

/**
 * A RoomOS device's bookings, as the Cisco RoomOS integration reports them
 * in the `meetings` attribute of `sensor.*_next_meeting`, and the rules for
 * which one Join belongs to. Shared by the device tile's list and the join
 * prompt, which must always agree on it.
 */

export interface Meeting {
  title: string;
  start_time?: string;
  /** Published by the integration alongside `start_time`; may be absent
      depending on which calendar service the device is paired with. */
  end_time?: string;
  organizer?: string;
  /**
   * NOT a statement about time. The integration sets this from whether the
   * booking carries a dialable callback number — a plain calendar block with
   * no video meeting is listed but not joinable. A meeting that finished
   * hours ago stays `joinable: true` for as long as the device lists it.
   */
  joinable?: boolean;
}


/**
 * How long before a meeting starts its Join offer appears.
 *
 * Five minutes: long enough to be in the room and ready, short enough that
 * the button on screen always means the meeting you are about to walk into.
 * A Join sitting there all morning is the thing that made it ignorable.
 */
export const JOIN_LEAD_MS = 5 * 60_000;

/** The meetings a device is reporting, newest parse of a live attribute. */
export function readMeetings(state: EntityState | null): Meeting[] {
  const raw = state?.a['meetings'];
  return Array.isArray(raw) ? (raw.filter((m) => m && typeof m === 'object') as Meeting[]) : [];
}

/**
 * Is this meeting close enough to start that Join should be offered?
 *
 * An unreadable or missing start time counts as due, for the same reason a
 * missing end time counts as not-over: a meeting we cannot place in time
 * should be joinable rather than silently un-joinable.
 */
export function isDue(m: Meeting, at: Date): boolean {
  if (!m.start_time) return true;
  const start = Date.parse(m.start_time);
  if (!Number.isFinite(start)) return true;
  return start - at.getTime() <= JOIN_LEAD_MS;
}

/** The booking `join_next_meeting` will dial right now; see shared/meetings.ts. */
export function joinTargetOf(meetings: Meeting[], at: Date): Meeting | undefined {
  return sharedJoinTargetOf(meetings, at.getTime());
}

/** Identity for "this exact booking", for remembering a dismissal. */
export function keyOf(m: Meeting): string {
  return `${m.start_time ?? ''}|${m.title}`;
}

/**
 * Has this booking already finished?
 *
 * Unknown when the calendar service did not give an end time, and unknown
 * means NOT over: hiding a meeting we cannot reason about would be worse than
 * showing one that has passed.
 */
export function isOver(m: Meeting, at: Date): boolean {
  return bookingHasEnded(m, at.getTime());
}


/**
 * An ISO start time as a wall clock, in the panel's configured zone.
 *
 * The meridiem is appended on a 12-hour clock, unlike everywhere else in the
 * app: the big Home clock can drop it because you know roughly what time it
 * is, but a LIST of bookings cannot — "5:00" against "5:00" is the difference
 * between a stand-up and dinner, and the list may run across noon.
 */
export function clockOf(iso: string | undefined, opts: TimeOpts): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const time = formatTime(d, opts);
  return opts.hour12 ? `${time} ${formatMeridiem(d, opts)}` : time;
}
