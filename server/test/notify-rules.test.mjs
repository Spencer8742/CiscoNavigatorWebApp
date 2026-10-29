import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigStore, NotificationRules, inQuietHours, isAway, isInsecure } from '../dist/testkit.js';

/**
 * `notifications:` — the rules the backend runs itself.
 *
 * Driven with a fake clock and a fake store, because every case worth
 * testing is about timing and transitions: the grace period after the last
 * person leaves, a restart while the house is already empty, a meeting
 * window that must fire exactly once.
 */

const T0 = Date.parse('2026-10-29T12:00:00Z');

function harness(notifications, { pages = [], timezone = 'UTC' } = {}) {
  const states = new Map();
  const sent = [];
  let now = T0;
  const config = { ui: { timezone }, controls: { pages }, notifications };
  const rules = new NotificationRules({
    getConfig: () => config,
    peek: (id) => states.get(id) ?? null,
    send: async (message, target) => { sent.push({ ...message, ...target }); },
    now: () => now,
  });
  return {
    rules,
    sent,
    set(id, s, a = {}) {
      states.set(id, { id, s, a: { friendly_name: a.friendly_name ?? id, ...a }, lc: now, lu: now });
      rules.check();
    },
    advance(ms) {
      now += ms;
      rules.check();
    },
  };
}

const AWAY = {
  quiet: null,
  meetings: null,
  away: {
    presence: 'zone.home',
    afterSeconds: 120,
    to: ['spencer-phone'],
    urgent: true,
    watch: ['cover.garage_door', 'lock.front_door', 'binary_sensor.back_door'],
  },
};

test('leaving with the garage open: one summary, after the grace period', () => {
  const h = harness(AWAY);
  h.set('zone.home', '2');
  h.set('cover.garage_door', 'open', { friendly_name: 'Garage Door' });
  h.set('lock.front_door', 'locked', { friendly_name: 'Front Door' });
  h.set('binary_sensor.back_door', 'off');
  assert.equal(h.sent.length, 0, 'opening things while somebody is home is nobody’s business');

  h.set('zone.home', '0');
  h.advance(60_000);
  assert.equal(h.sent.length, 0, 'still inside the grace period');

  h.advance(61_000);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(
    { title: h.sent[0].title, body: h.sent[0].body, category: h.sent[0].category, panels: h.sent[0].panels, urgent: h.sent[0].urgent },
    { title: 'Everyone has left', body: 'Garage Door is open', category: 'away', panels: ['spencer-phone'], urgent: true },
  );

  h.advance(10 * 60_000);
  assert.equal(h.sent.length, 1, 'said once, not on every tick');
});

test('a garage that closes during the grace period is not reported', () => {
  const h = harness(AWAY);
  h.set('zone.home', '1');
  h.set('cover.garage_door', 'open');
  h.set('zone.home', '0');
  h.advance(30_000);
  h.set('cover.garage_door', 'closed');
  h.advance(120_000);
  assert.equal(h.sent.length, 0);
});

test('something unlocked while everyone is out is reported at once, and only from a known state', () => {
  const h = harness(AWAY);
  h.set('zone.home', '1');
  h.set('lock.front_door', 'locked', { friendly_name: 'Front Door' });
  h.set('binary_sensor.back_door', 'off', { friendly_name: 'Back Door', device_class: 'door' });
  h.set('zone.home', '0');
  h.advance(130_000);
  assert.equal(h.sent.length, 0, 'everything was shut when they left');

  h.set('lock.front_door', 'unlocked', { friendly_name: 'Front Door' });
  assert.equal(h.sent.at(-1).title, 'Front Door unlocked');
  assert.equal(h.sent.at(-1).body, 'Nobody is home.');

  // Dropping off the network says nothing about the door.
  h.set('binary_sensor.back_door', 'unavailable');
  h.set('binary_sensor.back_door', 'off', { friendly_name: 'Back Door', device_class: 'door' });
  assert.equal(h.sent.length, 1);

  h.set('binary_sensor.back_door', 'on', { friendly_name: 'Back Door', device_class: 'door' });
  assert.equal(h.sent.at(-1).title, 'Back Door opened');

  // Somebody comes home: no more alerts.
  h.set('zone.home', '1');
  h.set('lock.front_door', 'locked');
  h.set('lock.front_door', 'unlocked');
  assert.equal(h.sent.length, 2);
});

test('a restart while the house is already empty is a baseline, not a departure', () => {
  const h = harness(AWAY);
  h.set('cover.garage_door', 'open');
  h.set('zone.home', '0');
  h.advance(10 * 60_000);
  assert.equal(h.sent.length, 0);
});

const PAGES = [{
  id: 'office',
  items: [{ type: 'device', id: 'desk_pro', name: 'Desk Pro', entities: { meetings: 'sensor.desk_pro_next_meeting' }, keys: [] }],
}];

function meetingsAt(h, list) {
  h.set('sensor.desk_pro_next_meeting', 'Standup', { meetings: list });
}

test('a meeting is warned about once, inside its window, and taps through to its page', () => {
  const h = harness(
    { quiet: null, away: null, meetings: { leadMinutes: 5, to: ['spencer-phone'], devices: [], urgent: false } },
    { pages: PAGES },
  );
  const start = new Date(T0 + 10 * 60_000).toISOString();
  meetingsAt(h, [{ title: 'Standup', start_time: start, organizer: 'Alex', joinable: true }]);
  assert.equal(h.sent.length, 0, 'ten minutes out is too early');

  h.advance(5 * 60_000 + 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].title, 'Standup in 5 min');
  assert.equal(h.sent[0].body, 'Desk Pro · Alex — tap to join from the panel');
  assert.equal(h.sent[0].url, '/?go=controls%3Aoffice');
  assert.equal(h.sent[0].category, 'meetings');
  assert.deepEqual(h.sent[0].panels, ['spencer-phone']);

  h.advance(60_000);
  h.advance(60_000);
  assert.equal(h.sent.length, 1, 'never twice');

  h.advance(10 * 60_000);
  assert.equal(h.sent.length, 1, 'and nothing once it has started');
});

test('meetings can be limited to some devices', () => {
  const h = harness(
    { quiet: null, away: null, meetings: { leadMinutes: 5, to: [], devices: ['room_kit'], urgent: false } },
    { pages: PAGES },
  );
  meetingsAt(h, [{ title: 'Standup', start_time: new Date(T0 + 2 * 60_000).toISOString() }]);
  assert.equal(h.sent.length, 0);
});

test('quiet hours drop routine notifications and let urgent ones through', () => {
  // 23:00 in New York is 03:00 UTC the next day.
  const night = Date.parse('2026-10-30T03:00:00Z');
  const h = harness(
    {
      quiet: { from: '22:00', until: '07:00' },
      meetings: { leadMinutes: 5, to: [], devices: [], urgent: false },
      away: { ...AWAY.away },
    },
    { pages: PAGES, timezone: 'America/New_York' },
  );
  h.advance(night - T0);
  meetingsAt(h, [{ title: 'Late call', start_time: new Date(night + 3 * 60_000).toISOString() }]);
  assert.equal(h.sent.length, 0, 'the meeting warning is held back overnight');

  h.set('zone.home', '1');
  h.set('lock.front_door', 'locked');
  h.set('zone.home', '0');
  h.advance(130_000);
  h.set('lock.front_door', 'unlocked');
  assert.equal(h.sent.length, 1, 'the unlocked door is not');
  assert.equal(h.sent[0].urgent, true);
});

test('quiet hours across midnight, on the household clock', () => {
  const q = { from: '22:00', until: '07:00' };
  assert.equal(inQuietHours(q, 'UTC', Date.parse('2026-10-29T23:30:00Z')), true);
  assert.equal(inQuietHours(q, 'UTC', Date.parse('2026-10-29T06:59:00Z')), true);
  assert.equal(inQuietHours(q, 'UTC', Date.parse('2026-10-29T07:00:00Z')), false);
  assert.equal(inQuietHours(q, 'UTC', Date.parse('2026-10-29T12:00:00Z')), false);
  assert.equal(inQuietHours({ from: '13:00', until: '14:00' }, 'UTC', Date.parse('2026-10-29T13:30:00Z')), true);
  assert.equal(inQuietHours(q, 'Europe/London', Date.parse('2026-07-01T21:30:00Z')), true, 'BST: 22:30 local');
});

test('what counts as away, and as open', () => {
  const e = (id, s) => ({ id, s, a: {}, lc: 0, lu: 0 });
  assert.equal(isAway(e('zone.home', '0')), true);
  assert.equal(isAway(e('zone.home', '2')), false);
  assert.equal(isAway(e('alarm_control_panel.house', 'armed_away')), true);
  assert.equal(isAway(e('alarm_control_panel.house', 'armed_home')), false);
  assert.equal(isAway(e('person.spencer', 'not_home')), true);
  assert.equal(isAway(e('person.spencer', 'home')), false);
  assert.equal(isAway(e('zone.home', 'unavailable')), null);

  assert.equal(isInsecure(e('lock.front', 'unlocked')), true);
  assert.equal(isInsecure(e('lock.front', 'jammed')), true);
  assert.equal(isInsecure(e('lock.front', 'locked')), false);
  assert.equal(isInsecure(e('cover.garage', 'opening')), true);
  assert.equal(isInsecure(e('cover.garage', 'closed')), false);
  assert.equal(isInsecure(e('binary_sensor.door', 'on')), true);
  assert.equal(isInsecure(e('binary_sensor.door', 'unknown')), null);
});

test('the notifications block is validated, and off until written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'navigator-notify-'));
  const path = join(dir, 'dashboard.yaml');
  try {
    await writeFile(path, 'version: 1\n', 'utf8');
    const empty = new ConfigStore(path);
    await empty.load();
    assert.deepEqual(empty.current.notifications, { quiet: null, meetings: null, away: null });
    empty.close();

    await writeFile(path, `
version: 1
notifications:
  quiet: { from: "22:00", until: "7:00" }
  meetings:
    to: [Spencer-Phone, "not a panel!"]
  away:
    to: spencer-phone
    watch: [cover.garage_door, lock.front_door, garage]
`, 'utf8');
    const store = new ConfigStore(path);
    await store.load();
    assert.deepEqual(store.current.notifications, {
      quiet: { from: '22:00', until: '07:00' },
      meetings: { leadMinutes: 5, to: ['spencer-phone'], devices: [], urgent: false },
      away: {
        presence: 'zone.home', afterSeconds: 120, to: ['spencer-phone'], urgent: true,
        watch: ['cover.garage_door', 'lock.front_door'],
      },
    });
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
