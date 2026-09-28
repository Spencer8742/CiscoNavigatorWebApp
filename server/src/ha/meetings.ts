import { logger } from '~/lib/log.ts';
import type { DashboardConfig, DeviceEntities } from '@shared/config.ts';
import type { EntityState } from '@shared/protocol.ts';
import { joinTargetOf } from '@shared/meetings.ts';

const log = logger('meetings');

/** Refreshes land on the half hour: :00 and :30. */
const SLOT_MS = 30 * 60_000;

/**
 * Two triggers for one device inside this window are one refresh. A hang-up
 * that lands at 10:00 would otherwise press the button twice in a second.
 */
const DEBOUNCE_MS = 5_000;

/** setTimeout's ceiling; a later end time is re-armed when it fires. */
const MAX_TIMER_MS = 2 **31 - 1;

interface Deps {
  getConfig: () => DashboardConfig;
  /** Current state of an entity, or null when unknown. */
  getState: (entityId: string) => EntityState | null;
  /** Press a `button.*` entity in Home Assistant. */
  press: (entityId: string) => Promise<unknown>;
  now?: () => number;
}

/**
 * Keeps each RoomOS device's meeting list current without a refresh key.
 *
 * The device does not re-read its calendar on its own often enough to trust:
 * a booking that has finished holds the `join_next_meeting` button until
 * something asks the device to look again. That used to be a key on the tile,
 * which put the job on whoever happened to notice. Instead the backend presses
 * `refresh_meetings` at the moments the list is most likely to have moved on:
 *
 *  - when a call starts (a meeting was just joined — from the panel or the
 *    device itself),
 *  - when a call ends (somebody hung up; the meeting they were in is done),
 *  - when the booking `join_next_meeting` points at has ended, so Join
 *    moves on to the next meeting instead of dialling one that is over,
 *  - and at the top and bottom of every hour, which is where bookings start
 *    and end.
 *
 * It lives here rather than in the panel because there may be several panels
 * and one device: each one pressing on its own clock would hit the codec once
 * per panel, and a panel asleep or unplugged would press nothing at all.
 */
export class MeetingRefresher {
  readonly #deps: Deps;
  readonly #now: () => number;
  /** Last settled `inCall` state per in-call entity: 'on' or 'off'. */
  readonly #calls = new Map<string, 'on' | 'off'>();
  /** When each refresh button was last pressed, for the debounce. */
  readonly #pressedAt = new Map<string, number>();
  /** A timer per refresh button, set for when its Join target ends. */
  readonly #endTimers = new Map<string, { key: string; timer: ReturnType<typeof setTimeout> }>();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: Deps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /** Begin the half-hourly schedule. */
  start(): void {
    this.#schedule();
  }

  stop(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const { timer } of this.#endTimers.values()) clearTimeout(timer);
    this.#endTimers.clear();
  }

  /**
   * Look for calls that have started or ended. Called after every entity
   * event; cheap, since it reads one entity per configured device.
   *
   * The first state seen for a device is recorded, not acted on: a backend
   * starting up mid-call has not seen anybody join anything. Nor are
   * `unavailable`/`unknown` transitions — a codec dropping off the network is
   * not a hang-up, and coming back is not a join.
   */
  check(): void {
    for (const e of this.#devices()) {
      if (!e.inCall || !e.refreshMeetings) continue;
      const state = this.#deps.getState(e.inCall)?.s;
      if (state !== 'on' && state !== 'off') continue;

      const prev = this.#calls.get(e.inCall);
      this.#calls.set(e.inCall, state);
      if (prev === undefined || prev === state) continue;

      this.#refresh(e.refreshMeetings, state === 'on' ? 'call started' : 'call ended');
    }

    for (const e of this.#devices()) this.#watchJoinTarget(e);
  }

  /**
   * Refresh when the booking Join would dial has finished.
   *
   * The integration points `join_next_meeting` at its own choice of booking
   * (shared/meetings.ts), so Join moves on by itself. Re-reading the calendar at that moment as well picks up anything
   * that changed during the meeting — a booking added, moved or cancelled —
   * rather than waiting for the next half hour.
   *
   * A timer per device, set for its Join target's end and replaced whenever
   * the target changes. Firing presses once; the target it re-arms for is the
   * next booking, so a device that keeps listing the finished one is not
   * pressed again.
   */
  #watchJoinTarget(e: DeviceEntities): void {
    const button = e.refreshMeetings!;
    const at = this.#now();
    const target = e.meetings ? joinTarget(this.#deps.getState(e.meetings), at) : null;
    const end = target?.end_time ? Date.parse(target.end_time) : NaN;
    const armed = this.#endTimers.get(button);

    if (!target || !Number.isFinite(end)) {
      if (armed) clearTimeout(armed.timer);
      this.#endTimers.delete(button);
      return;
    }

    const key = `${target.start_time ?? ''}|${target.title ?? ''}|${target.end_time}`;
    if (armed?.key === key) return;
    if (armed) clearTimeout(armed.timer);

    const wait = end - at;
    const timer = setTimeout(() => {
      this.#endTimers.delete(button);
      // A far-off end is reached in steps of MAX_TIMER_MS; only the real end
      // is worth a press.
      if (this.#now() >= end) this.#refresh(button, 'join target ended');
      this.check();
    }, Math.min(wait, MAX_TIMER_MS));
    timer.unref?.();
    this.#endTimers.set(button, { key, timer });
  }

  /** Every device tile's entities, one per refresh button. */
  #devices(): DeviceEntities[] {
    const seen = new Set<string>();
    const out: DeviceEntities[] = [];
    for (const page of this.#deps.getConfig().controls.pages) {
      for (const item of page.items) {
        if (item.type !== 'device' || !item.entities.refreshMeetings) continue;
        // The same device on two pages is still one device.
        if (seen.has(item.entities.refreshMeetings)) continue;
        seen.add(item.entities.refreshMeetings);
        out.push(item.entities);
      }
    }
    return out;
  }

  #refresh(button: string, why: string): void {
    const at = this.#now();
    const last = this.#pressedAt.get(button);
    if (last !== undefined && at - last < DEBOUNCE_MS) return;
    this.#pressedAt.set(button, at);

    log.info(`Refreshing meetings (${why}): ${button}`);
    this.#deps.press(button).catch((err: unknown) => {
      log.warn(`Meeting refresh failed for ${button}: ${err instanceof Error ? err.message : err}`);
    });
  }

  /**
   * Arm the next :00 or :30.
   *
   * Epoch half hours are wall-clock half hours in every zone whose offset is
   * a whole or half hour, which is all but a handful. Re-armed after each
   * firing rather than on an interval, so a slow timer or a sleeping host
   * cannot drift it off the boundary.
   */
  #schedule(): void {
    const at = this.#now();
    const next = Math.floor(at / SLOT_MS) * SLOT_MS + SLOT_MS;
    this.#timer = setTimeout(() => {
      for (const e of this.#devices()) this.#refresh(e.refreshMeetings!, 'half hour');
      this.#schedule();
    }, next - at);
    this.#timer.unref?.();
  }
}

interface Booking {
  title?: string;
  start_time?: string;
  end_time?: string;
  joinable?: boolean;
}

/** The booking `join_next_meeting` dials; see shared/meetings.ts. */
function joinTarget(state: EntityState | null, at: number): Booking | null {
  const raw = state?.a['meetings'];
  if (!Array.isArray(raw)) return null;
  const bookings = raw.filter((m): m is Booking => !!m && typeof m === 'object');
  return joinTargetOf(bookings, at) ?? null;
}
