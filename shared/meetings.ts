/**
 * Which RoomOS booking `join_next_meeting` dials.
 *
 * The button takes no argument: the Cisco RoomOS integration picks the
 * booking (`next_joinable_booking`), and the panel's Join badge and prompt,
 * and the backend's refresh when that booking ends, can only honestly act on
 * the one it will dial. So the rule lives here once, for both, and mirrors the
 * integration (0.6.1+):
 *
 *  - only bookings with a dial-in number (`joinable`) that have not ended
 *    count — the device keeps finished bookings in its list all day;
 *  - of those, the earliest, unless a later one starts within
 *    `JOIN_HANDOVER_MS`, in which case the latest such one: with meetings back
 *    to back, the one about to start is the one worth joining.
 *
 * A booking with no readable end time is treated as not ended, and one with
 * no readable start time never takes over — both as the integration does.
 */

export interface BookingTimes {
  start_time?: string | null;
  end_time?: string | null;
  joinable?: boolean | null;
}

/** Must match `JOIN_HANDOVER` in the integration's api.py. */
export const JOIN_HANDOVER_MS = 3 * 60_000;

export function bookingHasEnded(m: BookingTimes, atMs: number): boolean {
  const end = m.end_time ? Date.parse(m.end_time) : NaN;
  return Number.isFinite(end) && end <= atMs;
}

export function joinTargetOf<T extends BookingTimes>(bookings: readonly T[], atMs: number): T | undefined {
  const current = bookings.filter((m) => m.joinable && !bookingHasEnded(m, atMs));
  const handover = atMs + JOIN_HANDOVER_MS;
  const starting = current.filter((m) => {
    const start = m.start_time ? Date.parse(m.start_time) : NaN;
    return Number.isFinite(start) && start <= handover;
  });
  return starting[starting.length - 1] ?? current[0];
}
