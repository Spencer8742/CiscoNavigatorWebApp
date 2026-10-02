import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath, URL } from 'node:url';

/**
 * The Plex tab: browsing a Plex Media Server, and sending what was picked to
 * a player — a configured Apple TV (opened into Plex first) or any other Plex
 * player the server or plex.tv knows about.
 *
 * Three fakes stand in for the three parties: the server, plex.tv and a
 * player listening on its Companion port. The Apple TV bridge and the SSH
 * runner are stubs that record what they were asked to do.
 */

const { PlexClient, MediaArt, iinaCommand } = await import(fileURLToPath(new URL('../dist/testkit.js', import.meta.url)));

const TOKEN = 'plex-secret-token';
const MACHINE = 'server-machine-id';

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function json(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

let pms;
let plexTv;
let player;
const seen = { queues: [], commands: [], relayed: [], reports: [] };
let pmsUrl;
let playerPort;
/** What plex.tv lists. Changed per test. */
let resources = [];

before(async () => {
  player = await listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/resources') {
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end('<MediaContainer><Player title="Living Room" machineIdentifier="atv-plex-id" product="Plex for Apple TV" /></MediaContainer>');
      return;
    }
    if (url.pathname === '/player/playback/playMedia') {
      seen.commands.push({ query: Object.fromEntries(url.searchParams), target: req.headers['x-plex-target-client-identifier'] });
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  playerPort = player.address().port;

  pms = await listen((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.headers['x-plex-token'] !== TOKEN) return json(res, {}, 401);
    switch (url.pathname) {
      case '/':
        return json(res, { MediaContainer: { machineIdentifier: MACHINE, friendlyName: 'Basement' } });
      case '/library/sections':
        return json(res, { MediaContainer: { Directory: [
          { key: '1', title: 'Films', type: 'movie' },
          { key: '2', title: 'TV', type: 'show' },
          { key: '3', title: 'Holiday Photos', type: 'photo' },
          { key: '4', title: 'Music', type: 'artist' },
        ] } });
      case '/library/onDeck':
        return json(res, { MediaContainer: { Metadata: [
          { ratingKey: '50', type: 'episode', title: 'Pilot', grandparentTitle: 'Some Show', parentIndex: 1, index: 1,
            duration: 1_800_000, viewOffset: 600_000, grandparentThumb: '/library/metadata/40/thumb/1' },
        ] } });
      case '/library/recentlyAdded':
        // Only music was added lately, and music is not offered.
        return json(res, { MediaContainer: { Metadata: [{ ratingKey: '70', type: 'album', title: 'An Album' }] } });
      case '/:/timeline':
      case '/:/scrobble':
        seen.reports.push({
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          client: req.headers['x-plex-client-identifier'],
          device: req.headers['x-plex-device-name'],
        });
        res.writeHead(200);
        return res.end();
      case '/library/sections/1/all':
        assert.equal(url.searchParams.get('X-Plex-Container-Start'), '0');
        return json(res, { MediaContainer: { totalSize: 61, Metadata: [
          { ratingKey: '10', type: 'movie', title: 'A Film', year: 1999, duration: 5_400_000, thumb: '/library/metadata/10/thumb/9', viewCount: 1 },
        ] } });
      case '/library/metadata/10':
        return json(res, { MediaContainer: { Metadata: [{ ratingKey: '10', type: 'movie', title: 'A Film', viewOffset: 120_000,
          thumb: '/library/metadata/10/thumb/9', Media: [{ Part: [{ key: '/library/parts/901/1700000000/file.mkv' }] }] }] } });
      case '/library/metadata/60':
        return json(res, { MediaContainer: { Metadata: [{ ratingKey: '60', type: 'season', title: 'Season 1' }] } });
      case '/library/metadata/61':
        return json(res, { MediaContainer: { Metadata: [{ ratingKey: '61', type: 'movie', title: 'Odd',
          Media: [{ Part: [{ key: '/library/parts/1/../../clients' }] }] }] } });
      case '/security/token':
        assert.equal(url.searchParams.get('type'), 'delegation');
        return json(res, { MediaContainer: { token: 'transient-abc' } });
      case '/library/metadata/50':
        return json(res, { MediaContainer: { Metadata: [{ ratingKey: '50', type: 'episode', title: 'Pilot', viewOffset: 600_000,
          grandparentTitle: "Bob's Show", Media: [{ Part: [{ key: '/library/parts/902/1700000000/file.mp4' }] }] }] } });
      case '/playQueues':
        assert.equal(req.method, 'POST');
        seen.queues.push(Object.fromEntries(url.searchParams));
        return json(res, { MediaContainer: {
          playQueueID: 77, playQueueSelectedItemID: 2,
          Metadata: [{ ratingKey: '49', playQueueItemID: 1 }, { ratingKey: url.searchParams.get('uri').split('/').pop(), playQueueItemID: 2 }],
        } });
      case '/clients':
        return json(res, { MediaContainer: { Server: [
          { name: 'Bedroom Shield', address: '127.0.0.1', port: playerPort, machineIdentifier: 'shield-id', product: 'Plex for Android (TV)' },
        ] } });
      case '/player/playback/playMedia':
        seen.relayed.push(Object.fromEntries(url.searchParams));
        res.writeHead(200);
        return res.end();
      default:
        return json(res, {}, 404);
    }
  });
  pmsUrl = `http://127.0.0.1:${pms.address().port}`;

  plexTv = await listen((req, res) => {
    if (req.headers['x-plex-token'] !== TOKEN) return json(res, {}, 401);
    json(res, resources);
  });
});

after(() => {
  pms.close();
  plexTv.close();
  player.close();
});

const MAC = { id: 'mac_studio', host: '10.0.0.5', username: 'spencer', name: 'Mac Studio', iina: true };

function client({ appleTvs = [], power = 'on', calls = [], ssh = [], sshAnswer = null, listeners = [] } = {}) {
  return new PlexClient({ url: pmsUrl, token: TOKEN, enabled: true }, {
    art: new MediaArt(),
    appleTvs: () => appleTvs,
    appleTvStates: () => appleTvs.map((tv) => ({ id: tv.id, power })),
    appleTvCommand: async (device, op) => { calls.push(['command', device, op]); return null; },
    openApp: async (device, bundle) => { calls.push(['open', device, bundle]); return null; },
    sshHosts: () => ssh,
    runSsh: async (host, command) => { calls.push(['ssh', host, command]); return sshAnswer; },
    iinaWatch: (host, listener) => listeners.push({ host, listener }),
    plexTv: `http://127.0.0.1:${plexTv.address().port}`,
    playerPort,
    readyMs: 3_000,
  });
}

describe('browsing', () => {
  test('the front page has Continue Watching and the video libraries, and no token', async () => {
    const result = await client().handle({ kind: 'home' });
    assert.equal(result.kind, 'home');
    assert.equal(result.server, 'Basement');
    assert.deepEqual(result.sections.map((s) => s.title), ['Continue Watching', 'Libraries']);
    const deck = result.sections[0].items[0];
    assert.equal(deck.kind, 'episode');
    assert.equal(deck.subtitle, 'Some Show · S1 E1');
    assert.equal(deck.resume, 600);
    assert.match(deck.art, /^\/img\/art\?k=[0-9a-f]{16}$/);
    // Photos cannot be played on a TV from here, and music is not wanted on
    // this page, so neither library is offered — nor a recently added album.
    assert.deepEqual(result.sections[1].items.map((i) => i.title), ['Films', 'TV']);
    assert.ok(!JSON.stringify(result).includes(TOKEN), 'the Plex token must never reach the panel');
  });

  test('a library pages, and says there is more', async () => {
    const result = await client().handle({ kind: 'open', id: '1', library: true });
    assert.equal(result.kind, 'list');
    assert.equal(result.more, true);
    assert.deepEqual(result.items[0], {
      id: '10', kind: 'movie', title: 'A Film', subtitle: '1999 · 90 min', art: result.items[0].art,
      browsable: false, playable: true, duration: 5400, resume: null, watched: true,
    });
  });

  test('an id the panel made up is refused before anything is fetched', async () => {
    await assert.rejects(client().handle({ kind: 'open', id: '../../clients' }), /Not a Plex item/);
  });
});

describe('playing', () => {
  test('targets list the Apple TVs first, and do not list one twice', async () => {
    resources = [
      { name: 'Living Room', product: 'Plex for Apple TV', clientIdentifier: 'atv-plex-id', provides: 'player,pubsub-player',
        presence: true, connections: [{ address: '10.9.9.9', port: 32500, local: true }] },
      { name: 'Phone', product: 'Plex for iOS', clientIdentifier: 'phone-id', provides: 'client,player', presence: false,
        connections: [{ address: '10.9.9.8', port: 32500, local: true }] },
    ];
    const result = await client({ appleTvs: [{ id: 'living', name: 'Living Room', host: '10.9.9.9', shortcuts: [] }] })
      .handle({ kind: 'targets' });
    assert.deepEqual(result.targets.map((t) => t.id), ['atv:living', 'plex:shield-id']);
  });

  test('a Plex player gets a play queue and a playMedia that resumes', async () => {
    seen.queues.length = 0;
    seen.commands.length = 0;
    await client().handle({ kind: 'play', id: '10', target: 'plex:shield-id', resume: true });
    assert.equal(seen.queues[0].uri, `server://${MACHINE}/com.plexapp.plugins.library/library/metadata/10`);
    assert.equal(seen.queues[0].type, 'video');
    const command = seen.commands[0];
    assert.equal(command.target, 'shield-id');
    assert.equal(command.query.key, '/library/metadata/10');
    assert.equal(command.query.offset, '120000');
    assert.equal(command.query.machineIdentifier, MACHINE);
    assert.equal(command.query.containerKey, '/playQueues/77?window=100&own=1');
    assert.equal(command.query.token, TOKEN);
    assert.equal(command.query.address, '127.0.0.1');
  });

  test('start over sends offset 0', async () => {
    seen.commands.length = 0;
    await client().handle({ kind: 'play', id: '10', target: 'plex:shield-id', resume: false });
    assert.equal(seen.commands[0].query.offset, '0');
  });

  test('an Apple TV is woken, opened into Plex, found on its own address, then told to play', async () => {
    seen.commands.length = 0;
    const calls = [];
    const tv = { id: 'living', name: 'Living Room', host: '127.0.0.1', shortcuts: [] };
    const result = await client({ appleTvs: [tv], power: 'off', calls })
      .handle({ kind: 'play', id: '50', target: 'atv:living', resume: true });
    assert.deepEqual(result, { kind: 'played', target: 'atv:living' });
    assert.deepEqual(calls, [['command', 'living', 'power_on'], ['open', 'living', 'com.plexapp.plex']]);
    assert.equal(seen.commands[0].target, 'atv-plex-id');
    assert.equal(seen.commands[0].query.key, '/library/metadata/50');
  });

  test('an Apple TV whose Plex never answers says what to check', async () => {
    const tv = { id: 'den', name: 'Den', host: '10.255.255.1', shortcuts: [] };
    resources = [];
    await assert.rejects(
      client({ appleTvs: [tv] }).handle({ kind: 'play', id: '10', target: 'atv:den', resume: true }),
      /did not show up as a Plex player/,
    );
  });

  test('a player that is not listed is refused', async () => {
    await assert.rejects(
      client().handle({ kind: 'play', id: '10', target: 'plex:nobody', resume: true }),
      /no longer available/,
    );
  });
});

describe('playing on a Mac in IINA', () => {
  test('a Mac marked iina is listed after the Apple TVs; one that is not, is not', async () => {
    resources = [];
    const other = { ...MAC, id: 'laptop', name: 'Laptop', iina: false };
    const result = await client({ ssh: [MAC, other], appleTvs: [{ id: 'living', name: 'Living Room', host: '10.9.9.9', shortcuts: [] }] })
      .handle({ kind: 'targets' });
    assert.deepEqual(result.targets.map((t) => t.id), ['atv:living', 'mac:mac_studio', 'plex:shield-id']);
    assert.equal(result.targets[1].product, 'IINA on Mac');
    assert.equal(result.targets[1].name, 'Mac Studio');
  });

  test('the file is opened in IINA over SSH, resuming, with a transient token', async () => {
    const calls = [];
    const result = await client({ ssh: [MAC], calls }).handle({ kind: 'play', id: '10', target: 'mac:mac_studio', resume: true });
    assert.deepEqual(result, { kind: 'played', target: 'mac:mac_studio' });
    assert.equal(calls.length, 1);
    const [, host, command] = calls[0];
    assert.equal(host, 'mac_studio');
    const link = command.match(/^caffeinate -u -t 1; open '(iina:\/\/open\?[^']+)'$/)?.[1];
    assert.ok(link, command);
    const query = new URL(link).searchParams;
    const media = new URL(query.get('url'));
    assert.equal(media.origin, pmsUrl);
    assert.equal(media.pathname, '/library/parts/901/1700000000/file.mkv');
    assert.equal(media.searchParams.get('X-Plex-Token'), 'transient-abc');
    assert.ok(!command.includes(TOKEN), 'the long-lived token must not reach the Mac');
    assert.equal(query.get('mpv_start'), '120');
  });

  test('start over leaves the start out', async () => {
    const calls = [];
    await client({ ssh: [MAC], calls }).handle({ kind: 'play', id: '50', target: 'mac:mac_studio', resume: false });
    const query = new URL(calls[0][2].match(/open '([^']+)'/)[1]).searchParams;
    assert.equal(query.get('mpv_start'), null);
    assert.equal(new URL(query.get('url')).pathname, '/library/parts/902/1700000000/file.mp4');
  });

  test('a season is refused with what to pick instead', async () => {
    await assert.rejects(
      client({ ssh: [MAC] }).handle({ kind: 'play', id: '60', target: 'mac:mac_studio', resume: true }),
      /one file at a time\. Choose an episode/,
    );
  });

  test('a part key that is not one is refused before anything runs', async () => {
    const calls = [];
    await assert.rejects(
      client({ ssh: [MAC], calls }).handle({ kind: 'play', id: '61', target: 'mac:mac_studio', resume: true }),
      /no playable file/,
    );
    assert.deepEqual(calls, []);
  });

  test('a Mac that is not marked iina is refused', async () => {
    const calls = [];
    await assert.rejects(
      client({ ssh: [{ ...MAC, iina: false }], calls }).handle({ kind: 'play', id: '10', target: 'mac:mac_studio', resume: true }),
      /not set up to play Plex/,
    );
    assert.deepEqual(calls, []);
  });

  test('open failing says to check IINA and the login', async () => {
    await assert.rejects(
      client({ ssh: [MAC], sshAnswer: 'mac_studio: command exited 1' })
        .handle({ kind: 'play', id: '10', target: 'mac:mac_studio', resume: true }),
      /could not open IINA/,
    );
  });

  test('nothing in the media link can leave the quoted argument', () => {
    const command = iinaCommand("http://pms/library/parts/1/2/file.mkv?X-Plex-Token=it's'; rm -rf ~; echo (x)! *", 5);
    const quoted = command.slice(command.indexOf("'"));
    assert.match(quoted, /^'[^']*'$/);
    assert.ok(!/[\s;$`\\]/.test(quoted), quoted);
  });
});

describe('IINA watch state reaches Plex', () => {
  const PATH = `${'http://127.0.0.1'}/library/parts/901/1700000000/file.mkv?X-Plex-Token=transient-abc`;
  const status = (over = {}) => ({ position: 120, duration: 5400, paused: false, volume: 100, muted: false, path: PATH, title: 'file.mkv', ...over });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  test('the Mac is followed after playing, and its position is reported as a timeline', async () => {
    seen.reports.length = 0;
    const listeners = [];
    await client({ ssh: [MAC], listeners }).handle({ kind: 'play', id: '10', target: 'mac:mac_studio', resume: true });
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].host, 'mac_studio');
    const { listener } = listeners[0];
    assert.equal(listener.titleFor(status()), 'A Film');
    assert.match(listener.artFor(status()), /^\/img\/art\?k=[0-9a-f]{16}$/, 'the poster, proxied, never the server');

    listener.status(status());
    await settle();
    assert.equal(seen.reports.length, 1);
    const [report] = seen.reports;
    assert.equal(report.path, '/:/timeline');
    assert.equal(report.query.ratingKey, '10');
    assert.equal(report.query.key, '/library/metadata/10');
    assert.equal(report.query.state, 'playing');
    assert.equal(report.query.time, '120000');
    assert.equal(report.query.duration, '5400000');
    assert.match(report.client, /-iina-mac_studio$/);
    assert.equal(report.device, 'Mac Studio');

    // The same state again within the interval is not sent again; a pause is.
    listener.status(status({ position: 125 }));
    listener.status(status({ position: 126, paused: true }));
    await settle();
    assert.deepEqual(seen.reports.map((r) => r.query.state), ['playing', 'paused']);
  });

  test('90% watched is scrobbled once, and stopping reports where it stopped', async () => {
    seen.reports.length = 0;
    const listeners = [];
    await client({ ssh: [MAC], listeners }).handle({ kind: 'play', id: '10', target: 'mac:mac_studio', resume: true });
    const { listener } = listeners[0];
    listener.status(status({ position: 4900 }));
    listener.status(status({ position: 4905 }));
    listener.end();
    listener.end();
    await settle();
    const scrobbles = seen.reports.filter((r) => r.path === '/:/scrobble');
    assert.equal(scrobbles.length, 1);
    assert.equal(scrobbles[0].query.key, '10');
    const timelines = seen.reports.filter((r) => r.path === '/:/timeline');
    assert.deepEqual(timelines.map((r) => r.query.state), ['playing', 'stopped']);
    assert.equal(timelines.at(-1).query.time, '4905000');
  });

  test('something else opened in IINA ends the report rather than being reported', async () => {
    seen.reports.length = 0;
    const listeners = [];
    await client({ ssh: [MAC], listeners }).handle({ kind: 'play', id: '10', target: 'mac:mac_studio', resume: true });
    const { listener } = listeners[0];
    // Before the file is open, IINA may still show the last one: ignored.
    listener.status(status({ path: 'http://127.0.0.1/library/parts/5/1/file.mp4' }));
    listener.status(status({ position: 300 }));
    listener.status(status({ position: 9999, path: '/Users/me/holiday.mov' }));
    listener.status(status({ position: 400 }));
    await settle();
    assert.deepEqual(seen.reports.map((r) => [r.query.state, r.query.time]), [['playing', '300000'], ['stopped', '300000']]);
    assert.equal(listener.titleFor(status({ path: '/Users/me/holiday.mov' })), null);
    assert.equal(listener.artFor(status({ path: '/Users/me/holiday.mov' })), null);
  });
});

