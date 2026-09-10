import { authHeaders } from '~/net/auth.ts';
import type { WeatherForecast } from '@shared/protocol.ts';

/** Only attach the configured HOME forecast to local weather questions. */
export function isHomeWeatherRequest(text: string): boolean {
  const words = text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(play|song|album|movie|define|definition|meaning|yesterday|historical)\b/.test(words)) return false;
  if (!/\b(weather|forecast)\b|\b(?:will|is|going to)\b.*\b(rain|snow|raining|snowing)\b|\b(?:temperature|hot|cold|warm)\b.*\boutside\b|\bumbrella\b/.test(words)) return false;
  // Strip local/time qualifiers before checking for an explicitly different place.
  const local = words.replace(/\b(?:in|for|at|near|around) (?:the )?(?:next (?:three|3|two|2|few) days|next week|weekend|week|morning|afternoon|evening|night|today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|home|here|my (?:home|house|area|location)|this (?:morning|afternoon|evening|week|weekend))\b/g, '');
  return !/\b(?:in|near|around|at)\b(?! the forecast\b)|\b(?:forecast|weather) for\b/.test(local);
}

export async function fetchHomeForecast(signal: AbortSignal): Promise<WeatherForecast> {
  const response = await fetch('/api/weather/forecast', { headers: authHeaders(), signal });
  if (!response.ok) {
    if (response.status === 404) throw new Error('Forecast needs a backend update');
    if (response.status === 401) throw new Error('Reconnect this panel to load the forecast');
    throw new Error('Home forecast is unavailable');
  }
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Forecast needs a backend update');
  const result = await response.json() as WeatherForecast;
  if (!Array.isArray(result.days) || result.days.length !== 3 || typeof result.temperatureUnit !== 'string')
    throw new Error('Home forecast is unavailable');
  return result;
}

export function forecastCondition(condition: string | null): { label: string; icon: string; tone: string } {
  switch (condition) {
    case 'sunny': return { label: 'Sunny', icon: 'sun', tone: 'sun' };
    case 'clear-night': return { label: 'Clear', icon: 'moon', tone: 'clear' };
    case 'partlycloudy': return { label: 'Partly cloudy', icon: 'cloud', tone: 'sun' };
    case 'cloudy': return { label: 'Cloudy', icon: 'cloud', tone: 'cloud' };
    case 'fog': return { label: 'Fog', icon: 'cloud', tone: 'cloud' };
    case 'lightning': case 'lightning-rainy': return { label: 'Storms', icon: 'bolt', tone: 'storm' };
    case 'rainy': case 'pouring': return { label: condition === 'pouring' ? 'Heavy rain' : 'Rain', icon: 'droplet', tone: 'rain' };
    case 'snowy': case 'snowy-rainy': case 'hail':
      return { label: condition === 'hail' ? 'Hail' : condition === 'snowy-rainy' ? 'Wintry mix' : 'Snow', icon: 'cloud', tone: 'snow' };
    case 'windy': case 'windy-variant': return { label: 'Windy', icon: 'cloud', tone: 'cloud' };
    case 'exceptional': return { label: 'Severe weather', icon: 'alert', tone: 'storm' };
    default: return { label: 'Conditions unavailable', icon: 'cloud', tone: 'cloud' };
  }
}

export function forecastDayLabel(date: string, index: number): string {
  if (index === 0) return 'Today';
  if (index === 1) return 'Tomorrow';
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}
