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

test('refreshes once when the booking Join points at ends, so Join moves on', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-09-28T10:10:00Z') });
  const meetingsId = 'sensor.desk_pro_next_meeting';
  const cfg = { controls: { pages: [{ items: [{
    type: 'device',
    entities: { meetings: meetingsId, refreshMeetings: 'button.desk_pro_refresh_meetings' },
    keys: [],
  }] }] } };
  const booking = { title: 'Standup', start_time: '2026-09-28T10:00:00Z', end_time: '2026-09-28T10:15:00Z', joinable: true };
  let meetings = [booking];
  const pressed = [];
  const refresher = new MeetingRefresher({
    getConfig: () => cfg,
    getState: (id) => (id === meetingsId ? { id, s: '1', a: { meetings }, lc: 0, lu: 0 } : null),
    press: async (id) => { pressed.push(new Date(Date.now()).toISOString()); },
  });
  refresher.check();
  assert.deepEqual(pressed, []);
  t.mock.timers.tick(5 * 60_000);
  assert.deepEqual(pressed, ['2026-09-28T10:15:00.000Z']);
  // The device still lists it after the refresh: no second press.
  refresher.check();
  t.mock.timers.tick(60_000);
  refresher.check();
  assert.equal(pressed.length, 1);
  // The list moves on to the next booking; its end arms a new refresh.
  meetings = [{ ...booking, title: 'Review', start_time: '2026-09-28T10:20:00Z', end_time: '2026-09-28T10:25:00Z' }];
  refresher.check();
  t.mock.timers.tick(9 * 60_000);
  refresher.stop();
  assert.deepEqual(pressed, ['2026-09-28T10:15:00.000Z', '2026-09-28T10:25:00.000Z']);
});
