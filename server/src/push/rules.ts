import { logger } from '~/lib/log.ts';
import type { DashboardConfig, NotificationsConfig } from '@shared/config.ts';
import type { EntityState, PushMessage } from '@shared/protocol.ts';

const log = logger('notify');

/** How often the clock-driven rules look. A meeting warning is never later than this. */
const TICK_MS = 30_000;

/** A meeting warned about is remembered this long, so a restart cannot repeat it. */
const MEETING_MEMORY_MS = 24 * 60 * 60_000;

interface Deps {
  getConfig: () => DashboardConfig;
  /** Any entity's state, allow-listed or not. See HaStore.peek. */
  peek: (entityId: string) => EntityState | null;
  send: (message: PushMessage, target: { panels: string[]; urgent: boolean }) => Promise<unknown>;
  now?: () => number;
}

/**
 * The notifications the backend sends on its own: `notifications:` in
 * dashboard.yaml.
 *
 * Two rules, both read off state the backend already holds — no Home
 * Assistant automation to write, and nothing on the panel:
 *
 *  - **meetings**: a few minutes before each booking on a RoomOS device
 *    tile's meeting list, tapping through to the page that tile is on, where
 *    Join already is.
 *  - **away**: when the last person leaves, one notification listing anything
 *    still open or unlocked; and while the house stays empty, one for each
 *    watched thing that opens or unlocks.
 *
 * State changes are judged against the last *known* state. `unavailable` and
 * `unknown` say nothing about a door, so a lock that drops off the network
 * and comes back still locked is not news, and the first state seen after a
 * restart is a baseline rather than a change.
 */
export class NotificationRules {
  readonly #deps: Deps;
  readonly #now: () => number;
  #timer: ReturnType<typeof setInterval> | undefined;

  /** Null until presence has been read once. */
  #away: boolean | null = null;
  /** When the house became empty, until the departure check has run. */
  #leftAt: number | null = null;
  /** Last known open/unlocked-ness of each watched entity. */
  #insecure = new Map<string, boolean>();
  /** Meetings already warned about → when they start. */
  #warned = new Map<string, number>();

  constructor(deps: Deps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.check(), TICK_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Re-evaluate every rule. Called on each Home Assistant event and on a timer. */
  check(): void {
    const cfg = this.#deps.getConfig().notifications;
    try {
      if (cfg.away) this.#checkAway(cfg, cfg.away);
      if (cfg.meetings) this.#checkMeetings(cfg, cfg.meetings);
    } catch (err) {
      log.error('Notification rules failed:', err);
    }
  }

  /* ── Away ─────────────────────────────────────────────────────────────── */

  #checkAway(cfg: NotificationsConfig, away: NonNullable<NotificationsConfig['away']>): void {
    const now = this.#now();
    const empty = isAway(this.#deps.peek(away.presence));

    if (empty !== null && empty !== this.#away) {
      // The first reading is a baseline: a restart while everyone is out
      // must not announce that they have just left.
      if (this.#away !== null) this.#leftAt = empty ? now : null;
      this.#away = empty;
    }

    // What changed since last time, for every watched entity.
    const opened: string[] = [];
    for (const id of away.watch) {
      const state = this.#deps.peek(id);
      const insecure = isInsecure(state);
      if (insecure === null) continue;
      const before = this.#insecure.get(id);
      this.#insecure.set(id, insecure);
      if (before === false && insecure) opened.push(id);
    }

    if (!this.#away) return;

    // Leaving: wait out the grace period, then list what is still open.
    if (this.#leftAt !== null) {
      if (now - this.#leftAt < away.afterSeconds * 1000) return;
      this.#leftAt = null;
      const open = away.watch.filter((id) => this.#insecure.get(id) === true);
      if (open.length > 0) {
        this.#send(cfg, away, {
          title: 'Everyone has left',
          body: open.map((id) => describe(id, this.#deps.peek(id))).join(' · '),
          category: 'away',
          tag: 'away-left',
        });
      }
      return;
    }

    for (const id of opened) {
      const state = this.#deps.peek(id);
      this.#send(cfg, away, {
        title: `${nameOf(id, state)} ${stateWord(id, state)}`,
        body: 'Nobody is home.',
        category: 'away',
        tag: `away-${id}`,
      });
    }
  }

  /* ── Meetings ─────────────────────────────────────────────────────────── */

  #checkMeetings(cfg: NotificationsConfig, meetings: NonNullable<NotificationsConfig['meetings']>): void {
    const now = this.#now();
    const lead = meetings.leadMinutes * 60_000;

    for (const [key, start] of this.#warned) {
      if (start < now - MEETING_MEMORY_MS) this.#warned.delete(key);
    }

    for (const page of this.#deps.getConfig().controls.pages) {
      for (const item of page.items) {
        if (item.type !== 'device' || !item.entities.meetings) continue;
        if (meetings.devices.length > 0 && !meetings.devices.includes(item.id)) continue;

        const raw = this.#deps.peek(item.entities.meetings)?.a['meetings'];
        if (!Array.isArray(raw)) continue;

        for (const booking of raw as Booking[]) {
          const start = typeof booking?.start_time === 'string' ? Date.parse(booking.start_time) : NaN;
          // Only inside the warning window: a booking already under way is
          // not "about to start", and one that starts in an hour is not yet.
          if (!Number.isFinite(start) || now < start - lead || now >= start) continue;

          const title = typeof booking.title === 'string' && booking.title.trim() ? booking.title.trim() : 'Meeting';
          const key = `${item.id}|${booking.start_time}|${title}`;
          if (this.#warned.has(key)) continue;
          this.#warned.set(key, start);

          const minutes = Math.max(1, Math.round((start - now) / 60_000));
          const organizer = typeof booking.organizer === 'string' && booking.organizer.trim() ? ` · ${booking.organizer.trim()}` : '';
          this.#send(cfg, meetings, {
            title: `${title} in ${minutes} min`,
            body: `${item.name}${organizer}${booking.joinable ? ' — tap to join from the panel' : ''}`,
            category: 'meetings',
            tag: `meeting-${item.id}`,
            url: `/?go=${encodeURIComponent(`controls:${page.id}`)}`,
          });
        }
      }
    }
  }

  /* ── Sending ──────────────────────────────────────────────────────────── */

  #send(cfg: NotificationsConfig, rule: { to: string[]; urgent: boolean }, message: PushMessage): void {
    if (!rule.urgent && cfg.quiet && inQuietHours(cfg.quiet, this.#deps.getConfig().ui.timezone, this.#now())) {
      log.info(`Quiet hours — not sending "${message.title}"`);
      return;
    }
    void Promise.resolve(this.#deps.send(message, { panels: rule.to, urgent: rule.urgent })).catch((err: unknown) => {
      log.warn(`Could not send "${message.title}":`, err);
    });
  }
}

interface Booking {
  title?: unknown;
  start_time?: unknown;
  organizer?: unknown;
  joinable?: unknown;
}

/** True when the presence entity says the house is empty; null when it cannot say. */
export function isAway(state: EntityState | null): boolean | null {
  if (!state || state.s === 'unavailable' || state.s === 'unknown') return null;
  const domain = state.id.split('.')[0];
  if (domain === 'zone') {
    const people = Number(state.s);
    return Number.isFinite(people) ? people === 0 : null;
  }
  if (domain === 'alarm_control_panel') return state.s === 'armed_away' || state.s === 'armed_vacation';
  return state.s !== 'home' && state.s !== 'on';
}

/** True when a watched entity is open or unlocked; null when its state says nothing. */
export function isInsecure(state: EntityState | null): boolean | null {
  if (!state || state.s === 'unavailable' || state.s === 'unknown') return null;
  const domain = state.id.split('.')[0];
  if (domain === 'lock') return state.s !== 'locked' && state.s !== 'locking';
  if (domain === 'cover') return state.s === 'open' || state.s === 'opening';
  return state.s === 'on' || state.s === 'open';
}

function nameOf(id: string, state: EntityState | null): string {
  const name = state?.a['friendly_name'];
  return typeof name === 'string' && name.trim() ? name.trim() : id;
}

/** "unlocked", "open", "wet" — what this kind of thing being insecure is called. */
function stateWord(id: string, state: EntityState | null): string {
  const domain = id.split('.')[0];
  if (domain === 'lock') return state?.s === 'jammed' ? 'is jammed' : 'unlocked';
  const cls = state?.a['device_class'];
  if (cls === 'moisture') return 'is wet';
  if (cls === 'motion' || cls === 'occupancy') return 'detected motion';
  return 'opened';
}

function describe(id: string, state: EntityState | null): string {
  const domain = id.split('.')[0];
  const word = domain === 'lock' ? (state?.s === 'jammed' ? 'jammed' : 'unlocked')
    : state?.a['device_class'] === 'moisture' ? 'wet'
    : 'open';
  return `${nameOf(id, state)} is ${word}`;
}

/** Whether `at` falls inside `from`–`until` on the household's clock. */
export function inQuietHours(quiet: { from: string; until: string }, timezone: string, at: number): boolean {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  }
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  const here = hour * 60 + minute;
  const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const from = toMinutes(quiet.from);
  const until = toMinutes(quiet.until);
  return from <= until ? here >= from && here < until : here >= from || here < until;
}
