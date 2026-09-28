import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export { resolveTheme } from './lib/theme.ts';`,
    resolveDir: new URL('../src', import.meta.url).pathname,
  },
  tsconfig: new URL('../tsconfig.json', import.meta.url).pathname,
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { resolveTheme } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

test('a manual choice wins at any hour', () => {
  const midnight = new Date('2026-09-28T00:00:00Z');
  assert.equal(resolveTheme('light', midnight, 'UTC'), 'light');
  assert.equal(resolveTheme('dark', new Date('2026-09-28T12:00:00Z'), 'UTC'), 'dark');
});

test('auto is light from 07:00 to 19:00 on the configured clock, dark otherwise', () => {
  const at = (iso) => resolveTheme('auto', new Date(iso), 'UTC');
  assert.equal(at('2026-09-28T06:59:00Z'), 'dark');
  assert.equal(at('2026-09-28T07:00:00Z'), 'light');
  assert.equal(at('2026-09-28T18:59:00Z'), 'light');
  assert.equal(at('2026-09-28T19:00:00Z'), 'dark');
});

test('auto follows the configured zone, not the device clock', () => {
  // 15:00 UTC is 08:00 in Los Angeles (PDT) and 00:00 in Tokyo.
  const d = new Date('2026-09-28T15:00:00Z');
  assert.equal(resolveTheme('auto', d, 'America/Los_Angeles'), 'light');
  assert.equal(resolveTheme('auto', d, 'Asia/Tokyo'), 'dark');
});

test('an unknown zone falls back to the device clock rather than throwing', () => {
  assert.ok(['light', 'dark'].includes(resolveTheme('auto', new Date(), 'Not/AZone')));
});
