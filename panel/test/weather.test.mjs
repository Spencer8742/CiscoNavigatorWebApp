import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const result = await build({ entryPoints: [new URL('../src/assist/weather.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node' });
const { isHomeWeatherRequest, forecastCondition, forecastDayLabel, fetchHomeForecast } =
  await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

test('local weather questions from typed or transcribed speech show a forecast', () => {
  for (const text of ["What's the weather?", 'Show the forecast for the next three days.',
    'Hey Jarvis, what is the weather like tomorrow?', 'Will it rain today?', 'Is it going to snow?',
    'How hot is it outside?', 'Do I need an umbrella?', 'Weather at home',
    'What is in the forecast for this weekend?', 'What is the weather in my area?', 'Forecast for tomorrow']) {
    assert.equal(isHomeWeatherRequest(text), true, text);
  }
});

test('other locations, music, historical queries and house commands do not show misleading home data', () => {
  for (const text of ['What is the weather in London?', 'Forecast for Paris', 'Will it rain in Tokyo?',
    'Weather near Boston', 'Play Weather With You', 'Define weather', 'What was the weather yesterday?',
    'Set the thermostat to 70', 'What is the bedroom temperature?', 'Start a timer for three days', 'Stop']) {
    assert.equal(isHomeWeatherRequest(text), false, text);
  }
});

test('forecast labels cover HA conditions and use the forecast date, not the browser timezone', () => {
  for (const condition of ['sunny', 'clear-night', 'partlycloudy', 'cloudy', 'fog', 'lightning', 'lightning-rainy',
    'rainy', 'pouring', 'snowy', 'snowy-rainy', 'hail', 'windy', 'windy-variant', 'exceptional']) {
    assert.notEqual(forecastCondition(condition).label, 'Conditions unavailable');
  }
  assert.equal(forecastCondition(null).label, 'Conditions unavailable');
  assert.equal(forecastDayLabel('2026-09-09', 0), 'Today');
  assert.equal(forecastDayLabel('2026-09-10', 1), 'Tomorrow');
  assert.equal(forecastDayLabel('2026-09-11', 2), 'Friday');
});

test('forecast fetch is abortable and old backend HTML is not mistaken for weather data', async (t) => {
  const signal = new AbortController().signal;
  const days = [{ date: '2026-09-09' }, { date: '2026-09-10' }, { date: '2026-09-11' }];
  const mock = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, '/api/weather/forecast');
    assert.equal(init.signal, signal);
    return Response.json({ temperatureUnit: 'F', days });
  });
  assert.deepEqual((await fetchHomeForecast(signal)).days, days);
  mock.mock.mockImplementation(async () => new Response('<html>old panel</html>', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(fetchHomeForecast(signal), /backend update/);
  mock.mock.mockImplementation(async () => new Response('', { status: 404 }));
  await assert.rejects(fetchHomeForecast(signal), /backend update/);
  mock.mock.mockImplementation(async () => new Response('', { status: 401 }));
  await assert.rejects(fetchHomeForecast(signal), /Reconnect/);
  mock.mock.mockImplementation(async () => new Response('', { status: 502 }));
  await assert.rejects(fetchHomeForecast(signal), /unavailable/);
  mock.mock.mockImplementation(async () => Response.json({ days: [] }));
  await assert.rejects(fetchHomeForecast(signal), /unavailable/);
});
