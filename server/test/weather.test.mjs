import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockHomeAssistant } from './mock-ha.mjs';
import { WeatherForecasts, normalizeForecast } from '../dist/testkit.js';

const source = { entityId: 'weather.home', temperatureUnit: '\u00b0F', timezone: 'America/New_York' };
const NOW = Date.parse('2026-09-09T16:00:00Z');
const daily = (date, extra = {}) => ({ datetime: `${date}T12:00:00Z`, condition: 'sunny', temperature: 76, templow: 54, ...extra });
const response = (days) => ({ [source.entityId]: { forecast: days } });

test('daily forecast uses the configured entity, home dates and units; ignores stale and extra days', () => {
  const normalized = normalizeForecast({ ...response([
    daily('2026-09-12'), daily('2026-09-08'), daily('2026-09-11'),
    daily('2026-09-09', { temperature: 0, templow: -5, precipitation_probability: 0 }),
    daily('2026-09-10'), daily('2026-09-09', { temperature: 999 }),
  ]), 'weather.elsewhere': { forecast: [daily('2026-09-09', { temperature: 200 })] } }, source, NOW);
  assert.deepEqual(normalized.days.map((day) => day.date), ['2026-09-09', '2026-09-10', '2026-09-11']);
  assert.deepEqual(normalized.days[0], { date: '2026-09-09', available: true, condition: 'sunny', high: 0, low: -5, rainChance: 0 });
  assert.equal(normalized.temperatureUnit, '\u00b0F');
  assert.equal(normalized.timezone, source.timezone);
  assert.equal(normalized.fetchedAt, new Date(NOW).toISOString());
});

test('missing days and invalid optional values never become invented temperatures', () => {
  const result = normalizeForecast(response([null, [], { datetime: 'bad' },
    daily('2026-09-10', { temperature: '75', templow: Infinity, precipitation_probability: 101 }),
  ]), source, NOW);
  assert.equal(result.days[0].available, false);
  assert.equal(result.days[2].available, false);
  assert.equal(result.days[1].available, true);
  assert.equal(result.days[1].high, null);
  assert.equal(result.days[1].low, null);
  assert.equal(result.days[1].rainChance, null);
  for (const raw of [null, {}, [], { 'weather.other': { forecast: [] } }, response([]), response([daily('2026-09-08')])])
    assert.throws(() => normalizeForecast(raw, source, NOW), /forecast/i);
});

test('dates remain calendar days at midnight, across DST and with date-only provider values', () => {
  const result = normalizeForecast(response([
    { datetime: '2026-10-31', temperature: 60 },
    { datetime: '2026-11-01T04:00:00Z', temperature: 61 },
    { datetime: '2026-11-02T05:00:00Z', temperature: 62 },
  ]), source, Date.parse('2026-11-01T03:59:00Z'));
  assert.deepEqual(result.days.map((day) => day.date), ['2026-10-31', '2026-11-01', '2026-11-02']);
  assert.ok(result.days.every((day) => day.available));
});

test('forecast requests coalesce and refresh after five minutes, a date rollover, or a unit/config change', async () => {
  let now = NOW;
  let count = 0;
  const cache = new WeatherForecasts(async () => {
    count++;
    return response([daily('2026-09-09'), daily('2026-09-10'), daily('2026-09-11')]);
  }, () => now);
  const first = cache.get(source);
  const second = cache.get(source);
  assert.equal(first, second);
  await first;
  await cache.get(source);
  assert.equal(count, 1);
  now += 5 * 60_000;
  await cache.get(source);
  assert.equal(count, 2);
  await cache.get({ ...source, temperatureUnit: '\u00b0C' });
  assert.equal(count, 3);
  now = Date.parse('2026-09-10T03:59:00Z');
  await cache.get(source);
  now += 60_000;
  const nextDay = await cache.get(source);
  assert.equal(count, 5);
  assert.equal(nextDay.days[0].date, '2026-09-10');
});

test('failed refreshes are retryable, not cached as success or replaced with stale data', async () => {
  let fails = true;
  let now = NOW;
  const cache = new WeatherForecasts(async () => {
    if (fails) throw new Error('offline');
    return response([daily('2026-09-09')]);
  }, () => now);
  await assert.rejects(cache.get(source), /offline/);
  fails = false;
  await cache.get(source);
  now += 5 * 60_000;
  fails = true;
  await assert.rejects(cache.get(source), /offline/);
});

const HA_PORT = 19423;
const PANEL_PORT = 19499;
const TOKEN = 'forecast-test-token';
const headers = { authorization: `Bearer ${TOKEN}` };
const base = `http://127.0.0.1:${PANEL_PORT}`;
let dir, configPath, ha, backend;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check) {
  for (let i = 0; i < 250; i++) {
    try { if (await check()) return; } catch { /* Starting. */ }
    await sleep(20);
  }
  assert.fail('Backend did not become ready');
}
async function configure(entity = 'weather.home') {
  await writeFile(configPath, `version: 1\nui:\n  timezone: America/New_York\nhome:\n  weather: ${entity || 'null'}\n`);
  await waitFor(async () => {
    const config = await (await fetch(`${base}/api/config`, { headers })).json();
    return (config.home.weather ?? null) === (entity || null) && config.ui.timezone === source.timezone;
  });
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'navigator-weather-'));
  configPath = join(dir, 'dashboard.yaml');
  await writeFile(configPath, 'version: 1\nui:\n  timezone: America/New_York\nhome:\n  weather: weather.home\n');
  ha = new MockHomeAssistant(HA_PORT);
  ha.seed('weather.home', 'sunny', { temperature_unit: '\u00b0F', supported_features: 3 });
  ha.seed('weather.other', 'sunny', { temperature_unit: '\u00b0C', supported_features: 1 });
  const current = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  ha.weatherForecasts = response([daily(current)]);
  await ha.start();
  backend = spawn(process.execPath, [new URL('../dist/server.js', import.meta.url).pathname], {
    env: { ...process.env, PORT: String(PANEL_PORT), HOST: '127.0.0.1', PANEL_TOKEN: TOKEN,
      CONFIG_PATH: configPath, HA_URL: `http://127.0.0.1:${HA_PORT}`, HA_TOKEN: 'mock-token',
      IMMICH_URL: '', IMMICH_API_KEY: '', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stderr.on('data', (data) => process.stderr.write(`[weather backend] ${data}`));
  await waitFor(async () => (await fetch(`${base}/api/health`)).ok && ha.connectionCount > 0);
  await configure();
});

after(async () => {
  if (backend && backend.exitCode === null) {
    backend.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { backend.kill('SIGKILL'); resolve(); }, 3000);
      backend.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  await ha?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('forecast API enforces auth and can only target configured home weather with response data', async () => {
  assert.equal((await fetch(`${base}/api/weather/forecast`)).status, 401);
  assert.equal(ha.serviceCalls.length, 0);
  const res = await fetch(`${base}/api/weather/forecast?entity_id=weather.other&type=hourly`, { headers });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const forecast = await res.json();
  assert.equal(forecast.days.length, 3);
  assert.equal(forecast.entityId, 'weather.home');
  assert.equal(forecast.temperatureUnit, '\u00b0F');
  assert.equal(ha.serviceCalls.length, 1);
  const call = ha.serviceCalls[0];
  assert.equal(call.domain, 'weather');
  assert.equal(call.service, 'get_forecasts');
  assert.equal(call.return_response, true);
  assert.deepEqual(call.target, { entity_id: 'weather.home' });
  assert.deepEqual(call.service_data, { type: 'daily' });
  const head = await fetch(`${base}/api/weather/forecast`, { headers, method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(ha.serviceCalls.length, 1);
});

test('unconfigured and failing providers return errors without serving stale home forecasts', async () => {
  await configure('');
  assert.equal((await fetch(`${base}/api/weather/forecast`, { headers })).status, 503);
  await configure('weather.other');
  ha.weatherError = 'Provider failed';
  assert.equal((await fetch(`${base}/api/weather/forecast`, { headers })).status, 502);
  ha.weatherError = null;
  const current = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  ha.weatherForecasts = { 'weather.other': { forecast: [daily(current)] } };
  const recovered = await fetch(`${base}/api/weather/forecast`, { headers });
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).entityId, 'weather.other');
});
