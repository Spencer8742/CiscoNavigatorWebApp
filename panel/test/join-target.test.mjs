import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

/**
 * Which booking Join belongs to. Mirrors `next_joinable_booking` in the Cisco
 * RoomOS integration — see shared/meetings.ts — so these cases are the same
 * ones its own tests pin down.
 */
const bundle = await build({
  entryPoints: [new URL('../../shared/meetings.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const { joinTargetOf } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

const NOW = Date.parse('2026-09-28T12:00:00Z');
const at = (min) => new Date(NOW + min * 60_000).toISOString();
const booking = (title, start, end, joinable = true) => ({ title, start_time: at(start), end_time: at(end), joinable });

test('a finished booking the device still lists is never the target', () => {
  const list = [booking('morning', -180, -150), booking('next', 30, 60)];
  assert.equal(joinTargetOf(list, NOW).title, 'next');
});

test('stays on the running meeting until three minutes before the next one', () => {
  const list = (lead) => [booking('running', -25, lead), booking('next', lead, lead + 30)];
  assert.equal(joinTargetOf(list(3.1), NOW).title, 'running');
  for (const lead of [3, 1, 0]) assert.equal(joinTargetOf(list(lead), NOW).title, 'next', `${lead} min`);
});

test('a later booking that is not dialable, or cannot be placed, never takes over', () => {
  const plain = [booking('running', -25, 1), booking('block', 1, 30, false)];
  assert.equal(joinTargetOf(plain, NOW).title, 'running');
  const unplaced = [booking('running', -25, 1), { ...booking('next', 1, 30), start_time: undefined }];
  assert.equal(joinTargetOf(unplaced, NOW).title, 'running');
});

test('nothing joinable is an answer', () => {
  assert.equal(joinTargetOf([booking('done', -60, -30)], NOW), undefined);
  assert.equal(joinTargetOf([], NOW), undefined);
});
