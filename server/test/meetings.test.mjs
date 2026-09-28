import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeetingRefresher } from '../dist/testkit.js';

const device = (prefix) => ({
  type: 'device',
  entities: { inCall: `binary_sensor.${prefix}_in_call`, refreshMeetings: `button.${prefix}_refresh_meetings` },
  keys: [],
});
const config = { controls: { pages: [{ items: [device('desk_pro')] }, { items: [device('desk_pro')] }] } };

function harness(start) {
  let clock = start;
  const states = new Map();
  const pressed = [];
  const refresher = new MeetingRefresher({
    getConfig: () => config,
    getState: (id) => (states.has(id) ? { id, s: states.get(id), a: {}, lc: 0, lu: 0 } : null),
    press: async (id) => { pressed.push(id); },
    now: () => clock,
  });
  const inCall = (s) => { states.set('binary_sensor.desk_pro_in_call', s); refresher.check(); };
  return { refresher, pressed, inCall, advance: (ms) => { clock += ms; } };
}

test('refreshes once when a call starts and once when it ends, not on startup or unavailability', () => {
  const h = harness(Date.parse('2026-09-28T10:10:00Z'));
  h.inCall('off');
  assert.deepEqual(h.pressed, []);
  h.advance(60_000);
  h.inCall('on');
  assert.deepEqual(h.pressed, ['button.desk_pro_refresh_meetings']);
  h.advance(60_000);
  h.inCall('unavailable');
  h.inCall('on');
  assert.equal(h.pressed.length, 1);
  h.advance(60_000);
  h.inCall('off');
  assert.equal(h.pressed.length, 2);
});

test('refreshes at the top and bottom of each hour', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-09-28T10:10:00Z') });
  const pressed = [];
  const refresher = new MeetingRefresher({
    getConfig: () => config,
    getState: () => null,
    press: async (id) => { pressed.push(new Date(Date.now()).toISOString()); },
  });
  refresher.start();
  t.mock.timers.tick(19 * 60_000);
  assert.equal(pressed.length, 0);
  t.mock.timers.tick(60_000);
  t.mock.timers.tick(30 * 60_000);
  t.mock.timers.tick(30 * 60_000);
  refresher.stop();
  assert.deepEqual(pressed, ['2026-09-28T10:30:00.000Z', '2026-09-28T11:00:00.000Z', '2026-09-28T11:30:00.000Z']);
});
