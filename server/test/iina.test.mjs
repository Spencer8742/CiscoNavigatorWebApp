import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, URL } from 'node:url';

/**
 * IINA on a Mac, over SSH and mpv's IPC socket. The SSH side is a stub: the
 * status loop's output is fed in line by line, and commands are recorded
 * with the answer the test chooses.
 */

const { Iina, mpvCommand, mpvShell, parseLine, IINA_SOCKET } = await import(fileURLToPath(new URL('../dist/testkit.js', import.meta.url)));

const SCREENS = [{ name: 'Studio Display', x: 0, y: 0 }, { name: 'LG TV', x: 2560, y: -200 }];
const MAC = { id: 'mac_studio', host: '10.0.0.5', username: 'me', name: 'Mac Studio', iina: true, screens: SCREENS };
const OTHER = { id: 'build', host: '10.0.0.6', username: 'ci', name: 'build', iina: false, screens: [] };

/** An mpv reply to the status request. */
function reply({
  pos = '61.5', dur = '5400', pause = 'no', volume = '80.000000', mute = 'no', eof = 'no', fs = 'no', speed = '1.000000',
  path = 'http://pms/library/parts/9/1/file.mkv?X-Plex-Token=t', title = 'file.mkv',
} = {}) {
  return JSON.stringify({ data: [pos, dur, pause, volume, mute, eof, fs, speed, path, title].join('|'), request_id: 1, error: 'success' });
}

const TRACKS = JSON.stringify({
  data: [
    { id: 1, type: 'video', selected: true },
    { id: 1, type: 'audio', lang: 'eng', title: 'Surround 5.1', selected: true },
    { id: 2, type: 'audio', lang: 'fra', selected: false },
    { id: 1, type: 'sub', lang: 'eng', title: 'English (SDH)', selected: false },
    { id: 2, type: 'sub', selected: false },
  ],
  request_id: 2,
  error: 'success',
});

function rig({ runAnswer = null } = {}) {
  const runs = [];
  const streams = [];
  const changes = [];
  const iina = new Iina({
    sshHosts: () => [MAC, OTHER],
    run: async (host, command) => { runs.push({ host, command }); return typeof runAnswer === 'function' ? runAnswer(command) : runAnswer; },
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
const idle = JSON.stringify({ data: '||yes|100|no|no|no|1||', request_id: 1, error: 'success' });

describe('reading mpv', () => {
  test('a status reply becomes numbers and flags, and the title may hold a bar', () => {
    const line = parseLine(reply({ pause: 'yes', mute: 'yes', eof: 'yes', fs: 'yes', speed: '1.500000', title: 'A | B' }));
    assert.deepEqual(line, {
      kind: 'status',
      status: {
        position: 61.5, duration: 5400, paused: true, volume: 80, muted: true, eof: true, fullscreen: true, speed: 1.5,
        path: 'http://pms/library/parts/9/1/file.mkv?X-Plex-Token=t', title: 'A | B',
      },
    });
  });

  test('the track list becomes audio and subtitle choices with readable names', () => {
    assert.deepEqual(parseLine(TRACKS), {
      kind: 'tracks',
      tracks: [
        { id: 1, type: 'audio', label: 'Surround 5.1 (ENG)', selected: true },
        { id: 2, type: 'audio', label: 'FRA', selected: false },
        { id: 1, type: 'sub', label: 'English (SDH)', selected: false },
        { id: 2, type: 'sub', label: 'Track 2', selected: false },
      ],
    });
  });

  test("the Mac's volume, including an output that has none", () => {
    assert.deepEqual(parseLine('{"system":"45,true"}'), { kind: 'system', volume: 45, muted: true });
    assert.deepEqual(parseLine('{"system":"missing value,false"}'), { kind: 'system', volume: null, muted: false });
  });

  test('events, junk and replies to nothing asked are skipped', () => {
    assert.equal(parseLine('{"event":"playback-restart"}'), null);
    assert.equal(parseLine('not json'), null);
    assert.equal(parseLine('{"data":"x","request_id":7}'), null);
  });
});

describe('the status loop', () => {
  test('only Macs marked iina are players, with their displays named', () => {
    const { iina } = rig();
    const players = iina.snapshot();
    assert.deepEqual(players.map((p) => p.id), ['mac_studio']);
    assert.deepEqual(players[0].screens, ['Studio Display', 'LG TV']);
  });

  test('one loop per Mac, asking mpv and macOS', () => {
    const { iina, streams } = rig();
    iina.watch('mac_studio');
    iina.watch('mac_studio');
    assert.equal(streams.length, 1);
    const { command } = streams[0];
    assert.ok(command.includes(`nc -U -w 1 ${IINA_SOCKET}`));
    assert.ok(command.includes('expand-text') && command.includes('track-list'));
    assert.ok(command.includes('get volume settings'));
  });

  test('a reading is shown, with a listener describing it', () => {
    const { iina, streams } = rig();
    iina.watch('mac_studio', { status: () => {}, titleFor: () => 'A Film', artFor: () => '/img/art?k=abc', end: () => {} });
    streams[0].onLine(reply());
    const [state] = iina.snapshot();
    assert.equal(state.active, true);
    assert.equal(state.title, 'A Film');
    assert.equal(state.art, '/img/art?k=abc');
    assert.equal(state.position, 61.5);
    assert.equal(state.volume, 80);
    assert.equal(state.paused, false);
  });

  test('without a listener the file name stands in for a title', () => {
    const { iina, streams } = rig();
    iina.watch('mac_studio');
    streams[0].onLine(reply({ title: '' }));
    assert.equal(iina.snapshot()[0].title, 'file.mkv');
    assert.equal(iina.snapshot()[0].art, null);
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
    assert.deepEqual(mpvCommand('fullscreen'), ['cycle', 'fullscreen']);
    assert.deepEqual(mpvCommand('speed', 9), ['set_property', 'speed', 2]);
    assert.deepEqual(mpvCommand('speed', 1.25), ['set_property', 'speed', 1.25]);
    assert.deepEqual(mpvCommand('sid', -1), ['set_property', 'sid', 'no']);
    assert.deepEqual(mpvCommand('aid', 2), ['set_property', 'aid', 2]);
    assert.equal(mpvCommand('seek'), null);
    assert.equal(mpvCommand('rm -rf'), null);
  });

  test('a quote in any string cannot leave the single-quoted request', () => {
    const shell = mpvShell(['sub-add', "http://pms/x?t=a'b", 'auto', "Bob's subs; rm -rf ~", 'en']);
    const quoted = shell.slice(shell.indexOf("' '") + 2, shell.lastIndexOf("' |"));
    assert.ok(!quoted.slice(1).includes("'"), quoted);
    assert.ok(shell.includes('\\u0027'));
  });

  test('a control is sent over SSH and shown at once', async () => {
    const { iina, runs, streams } = rig();
    iina.watch('mac_studio');
    streams[0].onLine(reply({ volume: '50' }));
    streams[0].onLine(TRACKS);
    assert.equal(await iina.command('mac_studio', 'volume', 70), null);
    assert.equal(
      runs[0].command,
      `printf '%s\\n' '{"command":["set_property","volume",70]}' | nc -U -w 1 ${IINA_SOCKET} | grep -q '"error":"success"'`,
    );
    assert.equal(iina.snapshot()[0].volume, 70);
    assert.equal(await iina.command('mac_studio', 'play_pause'), null);
    assert.equal(iina.snapshot()[0].paused, true);
    assert.equal(await iina.command('mac_studio', 'sid', 2), null);
    assert.deepEqual(iina.snapshot()[0].tracks.filter((t) => t.type === 'sub').map((t) => t.selected), [false, true]);
    assert.equal(await iina.command('mac_studio', 'speed', 1.5), null);
    assert.equal(iina.snapshot()[0].speed, 1.5);
  });

  test("the Mac's volume goes through macOS, clamped", async () => {
    const { iina, runs } = rig();
    assert.equal(await iina.command('mac_studio', 'system_volume', 140), null);
    assert.equal(runs[0].command, `osascript -e 'set volume output volume 100'`);
    assert.equal(iina.snapshot()[0].systemVolume, 100);
    assert.equal(await iina.command('mac_studio', 'system_mute'), null);
    assert.match(runs[1].command, /set volume output muted \(not/);
  });

  test('a display is reached by moving the window from the config, then fullscreen', async () => {
    const { iina, runs } = rig();
    assert.equal(await iina.command('mac_studio', 'screen', 1), null);
    const script = runs[0].command;
    assert.match(script, /"fullscreen",false/);
    assert.match(script, /set position of window 1 to \{2600, -160\}/);
    assert.match(script, /"fullscreen",true/);
    assert.equal(iina.snapshot()[0].fullscreen, true);
    assert.match(await iina.command('mac_studio', 'screen', 5), /Unknown display/);
  });

  test('a window macOS will not move says which permission to grant', async () => {
    const { iina } = rig({ runAnswer: 'mac_studio: command exited 3' });
    assert.match(await iina.command('mac_studio', 'screen', 0), /Accessibility/);
  });

  test('skip seeks to the end of the marker on screen; nothing to skip says so', async () => {
    const { iina, runs, streams } = rig();
    assert.match(await iina.command('mac_studio', 'skip'), /nothing to skip/);
    iina.watch('mac_studio', {
      status: () => {},
      describe: () => ({ title: null, art: null, skip: { kind: 'credits', to: 5300.5 }, next: null }),
      end: () => {},
    });
    streams[0].onLine(reply());
    assert.equal(await iina.command('mac_studio', 'skip'), null);
    assert.match(runs.at(-1).command, /\["seek",5301,"absolute"\]/);
  });

  test('next asks the listener to play it', async () => {
    const { iina, streams } = rig();
    let asked = 0;
    iina.watch('mac_studio', {
      status: () => {},
      describe: () => ({ title: null, art: null, skip: null, next: { id: '51', title: 'Next', art: null } }),
      playNext: async () => { asked += 1; return null; },
      end: () => {},
    });
    assert.match(await iina.command('mac_studio', 'next'), /no next episode/);
    streams[0].onLine(reply());
    assert.equal(await iina.command('mac_studio', 'next'), null);
    assert.equal(asked, 1);
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
