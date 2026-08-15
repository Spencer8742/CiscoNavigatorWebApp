/**
 * Formatting helpers.
 *
 * Intl.* formatter construction is expensive and this runs on a CPU that is
 * deprioritised behind a video pipeline, so every formatter is memoised.
 * Rebuilding a DateTimeFormat once per second for a ticking clock is exactly
 * the kind of quiet waste that shows up as jank on this hardware.
 */

const dtCache = new Map<string, Intl.DateTimeFormat>();
const numCache = new Map<string, Intl.NumberFormat>();

function dtf(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = locale + '|' + JSON.stringify(opts);
  let f = dtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    dtCache.set(key, f);
  }
  return f;
}

function nf(locale: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = locale + '|' + JSON.stringify(opts);
  let f = numCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, opts);
    numCache.set(key, f);
  }
  return f;
}

export interface TimeOpts {
  locale: string;
  timezone: string;
  hour12: boolean;
}

/** "14:32" or "2:32" — no seconds; a wall clock that ticks is noise. */
export function formatTime(d: Date, { locale, timezone, hour12 }: TimeOpts): string {
  return dtf(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12,
    timeZone: timezone,
  }).format(d);
}

/** "PM" — rendered small next to a 12h clock, omitted for 24h. */
export function formatMeridiem(d: Date, { locale, timezone }: TimeOpts): string {
  const parts = dtf(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone,
  }).formatToParts(d);
  return parts.find((p) => p.type === 'dayPeriod')?.value ?? '';
}

/** "Friday, 15 August" */
export function formatDate(d: Date, { locale, timezone }: TimeOpts): string {
  return dtf(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: timezone,
  }).format(d);
}

/** "Aug 2024" — for the photo overlay. */
export function formatPhotoDate(iso: string, { locale, timezone }: TimeOpts): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return dtf(locale, { month: 'short', year: 'numeric', timeZone: timezone }).format(d);
}

/** Temperature with the unit the entity reported. Always one decimal or none. */
export function formatTemp(value: number, unit: string, locale: string): string {
  const decimals = Math.abs(value) < 100 ? 1 : 0;
  return (
    nf(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(
      value,
    ) + unit
  );
}

export function formatNumber(value: number, locale: string, decimals = 0): string {
  return nf(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/**
 * Up to `maxDecimals`, with trailing zeros dropped.
 *
 * This is the right default for readouts: 20.4 stays "20.4" but a thermostat
 * target of 22 reads "22", not "22.0". Doing it through Intl rather than
 * string-trimming keeps it correct in locales where the decimal separator is
 * a comma.
 */
export function formatDecimal(value: number, locale: string, maxDecimals = 1): string {
  return nf(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  }).format(value);
}

/** Seconds → "3:07" / "1:02:07". Used for media position. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0
    ? `${h}:${mm}:${String(sec).padStart(2, '0')}`
    : `${mm}:${String(sec).padStart(2, '0')}`;
}

/** "just now" / "4 min ago" / "2 h ago" / "3 d ago" */
export function formatRelative(epochMs: number, now = Date.now()): string {
  const delta = Math.max(0, now - epochMs);
  const mins = Math.floor(delta / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/**
 * "light.living_room_ceiling" -> "Living Room Ceiling".
 *
 * Only a fallback: Home Assistant's `friendly_name` attribute wins whenever
 * it is present, which is nearly always.
 */
export function humanizeEntityId(entityId: string): string {
  const objectId = entityId.slice(entityId.indexOf('.') + 1);
  return objectId
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function domainOf(entityId: string): string {
  const i = entityId.indexOf('.');
  return i === -1 ? '' : entityId.slice(0, i);
}
