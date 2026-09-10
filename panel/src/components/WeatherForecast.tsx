import { useEffect, useState } from 'preact/hooks';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { fetchHomeForecast, forecastCondition, forecastDayLabel } from '~/assist/weather.ts';
import type { WeatherForecast as Forecast } from '@shared/protocol.ts';

export function WeatherForecast() {
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setForecast(null);
    setError('');
    const timeout = setTimeout(() => {
      setError('Home forecast took too long to respond');
      abort.abort();
    }, 10_000);
    void fetchHomeForecast(abort.signal).then((result) => {
      if (!abort.signal.aborted) setForecast(result);
    }).catch((reason: unknown) => {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'Home forecast is unavailable');
    }).finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); abort.abort(); };
  }, [attempt]);

  return (
    <section class="weather-forecast" aria-label="Three day home forecast" aria-busy={!forecast && !error}>
      <header class="forecast-head"><h3>Home forecast</h3><span>Next 3 days{forecast?.temperatureUnit ? ` / ${forecast.temperatureUnit}` : ''}</span></header>
      {error ? (
        <div class="forecast-status" role="status"><span>{error}</span>
          <span title="Retry forecast"><Pressable class="sheet-close p-sm" ariaLabel="Retry forecast" onPress={() => setAttempt(attempt + 1)}>
            <Icon name="refresh" size="1.25rem" />
          </Pressable></span>
        </div>
      ) : !forecast ? <div class="forecast-status" role="status">Loading forecast...</div> : (
        <div class="forecast-days">
          {forecast.days.map((day, index) => {
            const condition = forecastCondition(day.condition);
            return (
              <article key={day.date} class="forecast-day">
                <h4>{forecastDayLabel(day.date, index)}</h4>
                <time dateTime={day.date}>{new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day.date}T12:00:00Z`))}</time>
                <div class="forecast-symbol" data-weather={condition.tone} aria-hidden="true"><Icon name={condition.icon} size="3.2rem" weight={1.6} /></div>
                <div class="forecast-condition">{day.available ? condition.label : 'No forecast'}</div>
                <div class="forecast-temperatures tnum">
                  <span aria-label={`High ${temperature(day.high)} ${forecast.temperatureUnit}`}><small>High</small>{temperature(day.high)}</span>
                  <span aria-label={`Low ${temperature(day.low)} ${forecast.temperatureUnit}`}><small>Low</small>{temperature(day.low)}</span>
                </div>
                <div class="forecast-rain" aria-label={day.rainChance === null ? 'Rain chance unavailable' : `${Math.round(day.rainChance)} percent chance of precipitation`}>
                  <Icon name="droplet" size="0.9rem" /><span>{day.rainChance === null ? '--' : `${Math.round(day.rainChance)}%`}</span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function temperature(value: number | null): string {
  return value === null ? '--' : `${Math.round(value)}\u00b0`;
}
