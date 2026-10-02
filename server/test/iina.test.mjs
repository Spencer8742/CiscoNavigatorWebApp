import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, URL } from 'node:url';

/**
 * IINA on a Mac, over SSH and mpv's IPC socket. The SSH side is a stub: the
 * status loop's output is fed in line by line, and commands are recorded
 * with the answer the test chooses.
 */

const { Iina, mpvCommand, parseStatus, IINA_SOCKET } = await import(fileURLToPath(new URL('../dist/testkit.js', import.meta.url)));

const MAC = { id: 'mac_studio', host: '10.0.0.5', username: 'me', name: 'Mac Studio', iina: true };
const OTHER = { id: 'build', host: '10.0.0.6', username: 'ci', name: 'build', iina: false };

/** An mpv reply to the status request. */
function reply({ pos = '61.5', dur = '5400', pause = 'no', volume = '80.000000', mute = 'no', path = 'http://pms/library/parts/9/1/file.mkv?X-Plex-Token=t', title = 'file.mkv' } = {}) {
  return JSON.stringify({ data: [pos, dur, pause, volume, mute, path, title].join('|'), request_id: 0, error: 'success' });
}

function rig({ runAnswer = null } = {}) {
  const runs = [];
  const streams = [];
  const changes = [];
  const iina = new Iina({
    sshHosts: () => [MAC, OTHER],
    run: async (host, command) => { runs.push({ host, command }); return runAnswer; },
    stream: (host, command, onLine, signal) => new Promise((resolve) => {
      const s = { host, command, onLine, signal, end: (problem = null) => resolve(problem) };
      signal.addEventListener('abort', () => resolve(null), { once: true });
      streams.push(s);
    }),
    onChange: (players) => changes.push(players),
  });
  return { iina, runs, streams, changes };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('reading mpv', () => {
  test('a status reply becomes numbers and flags, and the title may hold a bar', () => {
    const status = parseStatus(reply({ pause: 'yes', mute: 'yes', title: 'A | B' }));
    assert.deepEqual(status, {
      position: 61.5, duration: 5400, paused: true, volume: 80, muted: true,
      path: 'http://pms/library/parts/9/1/file.mkv?X-Plex-Token=t', title: 'A | B',
    });
  });

  test('events and junk are not statuses', () => {
    assert.equal(parseStatus('{"event":"playback-restart"}'), null);
    assert.equal(parseStatus('not json'), null);
  });

  test('nothing loaded reads as an empty path', () => {
    const status = parseStatus(JSON.stringify({ data: '||yes|100.000000|no||', error: 'success' }));
    assert.equal(status.path, '');
    assert.equal(status.position, null);
  });
});

describe('the status loop', () => {
  test('only Macs marked iina are players', () => {
    const { iina } = rig();
    assert.deepEqual(iina.snapshot().map((p) => p.id), ['mac_studio']);
  });

  test('one loop per Mac, asking mpv on the configured socket', () => {
    const { iina, streams } = rig();
    iina.watch('mac_studio');
    iina.watch('mac_studio');
    assert.equal(streams.length, 1);
    assert.equal(streams[0].host, 'mac_studio');
    assert.ok(streams[0].command.includes(`nc -U -w 1 ${IINA_SOCKET}`));
    assert.ok(streams[0].command.includes('expand-text'));
  });

  test('a reading is shown, with a listener allowed to name it', () => {
    const { iina, streams } = rig();
    iina.watch('mac_studio', { status: () => {}, titleFor: () => 'A Film', end: () => {} });
    streams[0].onLine(reply());
    const [state] = iina.snapshot();
    assert.equal(state.active, true);
    assert.equal(state.title, 'A Film');
    assert.equal(state.position, 61.5);
    assert.equal(state.volume, 80);
    assert.equal(state.paused, false);
  });

  test('without a listener the file name stands in for a title', () => {
    const { iina, streams } = rig();
    iina.watch('mac_studio');
    streams[0].onLine(reply({ title: '' }));
    assert.equal(iina.snapshot()[0].title, 'file.mkv');
  });

  test('a new listener ends the old one; the loop ending ends the new one', async () => {
    const { iina, streams } = rig();
    const ended = [];
    iina.watch('mac_studio', { status: () => {}, end: () => ended.push('first') });
    iina.watch('mac_studio', { status: () => {}, end: () => ended.push('second') });
    assert.deepEqual(ended, ['first']);
    streams[0].end();
    await tick();
    assert.deepEqual(ended, ['first', 'second']);
    assert.equal(iina.snapshot()[0].active, false);
  });

  test('a long idle hangs up, and a later watch starts a fresh loop', async () => {
    const { iina, streams } = rig();
    iina.watch('mac_studio');
    const idle = JSON.stringify({ data: '||yes|100|no||', error: 'success' });
    for (let i = 0; i < 24; i += 1) streams[0].onLine(idle);
    assert.equal(streams[0].signal.aborted, true);
    await tick();
    iina.watch('mac_studio');
    assert.equal(streams.length, 2);
  });
});

describe('controls', () => {
  test('each control is one fixed mpv command', () => {
    assert.deepEqual(mpvCommand('play_pause'), ['cycle', 'pause']);
    assert.deepEqual(mpvCommand('seek_back'), ['seek', -10, 'relative']);
    assert.deepEqual(mpvCommand('seek_forward'), ['seek', 30, 'relative']);
    assert.deepEqual(mpvCommand('seek', 90.4), ['seek', 90, 'absolute']);
    assert.deepEqual(mpvCommand('volume', 250), ['set_property', 'volume', 100]);
    assert.deepEqual(mpvCommand('volume', -3), ['set_property', 'volume', 0]);
    assert.equal(mpvCommand('seek'), null);
    assert.equal(mpvCommand('rm -rf'), null);
  });

  test('a control is sent over SSH and shown at once', async () => {
    const { iina, runs, streams } = rig();
    iina.watch('mac_studio');
    streams[0].onLine(reply({ volume: '50' }));
    assert.equal(await iina.command('mac_studio', 'volume', 70), null);
    assert.equal(runs.length, 1);
    assert.equal(
      runs[0].command,
      `printf '%s\\n' '{"command":["set_property","volume",70]}' | nc -U -w 1 ${IINA_SOCKET} | grep -q '"error":"success"'`,
    );
    assert.equal(iina.snapshot()[0].volume, 70);
    assert.equal(await iina.command('mac_studio', 'play_pause'), null);
    assert.equal(iina.snapshot()[0].paused, true);
  });

  test('a control IINA did not take says what to set up', async () => {
    const { iina } = rig({ runAnswer: 'mac_studio: command exited 1' });
    const problem = await iina.command('mac_studio', 'play_pause');
    assert.match(problem, /not playing on Mac Studio.*input-ipc-server/);
    assert.equal(iina.snapshot()[0].error, problem);
  });

  test('a Mac not marked iina, or an unknown op, is refused without SSH', async () => {
    const { iina, runs } = rig();
    assert.match(await iina.command('build', 'play_pause'), /not set up for IINA/);
    assert.match(await iina.command('mac_studio', 'quit'), /Unknown IINA control/);
    assert.equal(runs.length, 0);
  });

  test('status only starts the loop', async () => {
    const { iina, runs, streams } = rig();
    assert.equal(await iina.command('mac_studio', 'status'), null);
    assert.equal(runs.length, 0);
    assert.equal(streams.length, 1);
  });
});
