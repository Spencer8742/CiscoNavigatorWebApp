import { THEME_DAY_HOURS, type PanelPrefs } from '@shared/protocol.ts';

export type Theme = 'light' | 'dark';

/**
 * The theme a preference means right now.
 *
 * `auto` is decided by the hour on the panel's configured clock rather than
 * the device's own: a RoomOS device left on UTC would otherwise turn light
 * at 2am in California.
 */
export function resolveTheme(pref: PanelPrefs['theme'], at: Date, timezone: string): Theme {
  if (pref === 'light' || pref === 'dark') return pref;
  const hour = hourIn(at, timezone);
  return hour >= THEME_DAY_HOURS.from && hour < THEME_DAY_HOURS.until ? 'light' : 'dark';
}

function hourIn(at: Date, timezone: string): number {
  try {
    const part = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hourCycle: 'h23',
      timeZone: timezone,
    })
      .formatToParts(at)
      .find((p) => p.type === 'hour');
    const hour = Number(part?.value);
    if (Number.isFinite(hour)) return hour % 24;
  } catch {
    // An unknown zone name: fall through to the device's own clock.
  }
  return at.getHours();
}
