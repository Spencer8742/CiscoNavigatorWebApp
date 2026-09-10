import type { WeatherForecast, WeatherForecastDay } from '@shared/protocol.ts';

interface WeatherSource {
  entityId: string;
  temperatureUnit: string;
  timezone: string;
}

const CACHE_MS = 5 * 60_000;

/** One configured home source, with coalesced refreshes across panels. */
export class WeatherForecasts {
  #cached: { key: string; value: WeatherForecast; expires: number } | undefined;
  #pending: { key: string; promise: Promise<WeatherForecast> } | undefined;

  constructor(private request: (entityId: string) => Promise<unknown>, private now = Date.now) {}

  get(source: WeatherSource): Promise<WeatherForecast> {
    const now = this.now();
    const key = JSON.stringify([source.entityId, source.temperatureUnit, source.timezone, dateInZone(now, source.timezone)]);
    if (this.#cached?.key === key && this.#cached.expires > now) return Promise.resolve(this.#cached.value);
    if (this.#pending?.key === key) return this.#pending.promise;
    const promise = this.#load(source, now).then((value) => {
      this.#cached = { key, value, expires: now + CACHE_MS };
      return value;
    }).finally(() => {
      if (this.#pending?.promise === promise) this.#pending = undefined;
    });
    this.#pending = { key, promise };
    return promise;
  }

  async #load(source: WeatherSource, now: number): Promise<WeatherForecast> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([
        this.request(source.entityId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Weather provider did not respond')), 8000);
          timer.unref();
        }),
      ]);
      return normalizeForecast(response, source, now);
    } finally { clearTimeout(timer); }
  }
}

export function normalizeForecast(response: unknown, source: WeatherSource, now: number): WeatherForecast {
  const raw = record(record(response)?.[source.entityId])?.['forecast'];
  if (!Array.isArray(raw)) throw new Error('Daily forecast is not available from the configured weather provider');
  const today = dateInZone(now, source.timezone);
  const days: WeatherForecastDay[] = Array.from({ length: 3 }, (_, offset) => ({
    date: new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10),
    available: false, condition: null, high: null, low: null, rainChance: null,
  }));
  // Never turn absent temperatures or rain probabilities into a plausible zero.
  for (const entry of raw) {
    const item = record(entry);
    const datetime = item?.['datetime'];
    if (!item || typeof datetime !== 'string' || !Number.isFinite(Date.parse(datetime))) continue;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(datetime) ? datetime : dateInZone(Date.parse(datetime), source.timezone);
    const day = days.find((value) => value.date === date);
    if (!day || day.available) continue;
    const high = finite(item['temperature']);
    const low = finite(item['templow']);
    const condition = typeof item['condition'] === 'string' ? item['condition'].slice(0, 60) : null;
    const rain = finite(item['precipitation_probability']);
    if (high === null && low === null && !condition) continue;
    Object.assign(day, {
      available: true, condition, high, low,
      rainChance: rain !== null && rain >= 0 && rain <= 100 ? rain : null,
    });
  }
  if (!days.some((day) => day.available)) throw new Error('No current daily forecast is available');
  return { ...source, fetchedAt: new Date(now).toISOString(), days };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function dateInZone(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(timestamp);
  const part = (name: string): string => parts.find((value) => value.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
