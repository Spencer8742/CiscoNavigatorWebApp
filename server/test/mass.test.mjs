import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { fileURLToPath, URL } from 'node:url';
import { MockMusicAssistant } from './mock-mass.mjs';

/**
 * End-to-end tests for the direct Music Assistant connection.
 *
 * A real backend process, a mock Music Assistant speaking the real protocol,
 * and a WebSocket client standing in for the panel. Home Assistant is left
 * unconfigured throughout: the point of this suite is that music works
 * entirely without it.
 *
 * The protocol details worth having a mock for at all are the ones that fail
 * silently — the unsolicited server-info frame, the auth handshake, and
 * chunked `partial` results that truncate long lists if mishandled.
 */

const TOKEN = 'panel-token';
const SERVER = fileURLToPath(new URL('../dist/server.js', import.meta.url));
const CONFIG = fileURLToPath(new URL('./fixtures/dashboard.test.yaml', import.meta.url));

/** OS-assigned, so a crashed run never leaves the next one with EADDRINUSE. */
function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(25);
  }
  assert.fail(`Timed out waiting for: ${description}`);
}

/** A panel: connects, records messages, and can browse the way the UI does. */
class TestPanel {
  #browsers = new Map();
  #seq = 900;

  constructor(port) {
    this.port = port;
    this.messages = [];
    this.errors = [];
    this.players = [];
    this.queues = [];
    this.health = null;
  }

  async connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws?t=${TOKEN}`);

    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      this.messages.push(msg);

      if (msg.t === 'hello') {
        this.health = msg.health;
        this.players = msg.players;
        this.queues = msg.queues;
      } else if (msg.t === 'players') {
        this.players = msg.players;
        this.queues = msg.queues;
      } else if (msg.t === 'health') {
        this.health = msg.health;
      } else if (msg.t === 'browse') {
        const w = this.#browsers.get(msg.ref);
        if (w) {
          this.#browsers.delete(msg.ref);
          w.resolve(msg.result);
        }
      } else if (msg.t === 'error') {
        this.errors.push(msg);
        const w = this.#browsers.get(msg.ref);
        if (w) {
          this.#browsers.delete(msg.ref);
          w.reject(new Error(msg.message));
        }
      }
    });

    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    await waitFor(() => this.health !== null, 'hello message');
  }

  browse(req) {
    const id = (this.#seq += 1);
    return new Promise((resolve, reject) => {
      this.#browsers.set(id, { resolve, reject });
      this.send({ t: 'browse', id, req });
      setTimeout(() => {
        if (this.#browsers.delete(id)) reject(new Error('browse timed out'));
      }, 8000);
    });
  }

  mass(command, args) {
    this.send({ t: 'mass', id: (this.#seq += 1), command, args });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  player(id) {
    return this.players.find((p) => p.id === id);
  }

  get messageCount() {
    return this.messages.length;
  }

  since(i) {
    return this.messages.slice(i);
  }

  close() {
    this.ws?.close();
  }
}

/**
 * A backend with its own mock Music Assistant.
 *
 * Module-scope so `after()` can always tear it down: a failing test that skips
 * its own cleanup used to leave the runner hanging on a live child process.
 */
function isolated(configure) {
  const ctx = {};

  before(async () => {
    ctx.port = await freePort();
    ctx.massPort = await freePort();
    ctx.mass = new MockMusicAssistant(ctx.massPort);
    await configure(ctx.mass, ctx);
    await ctx.mass.start();

    ctx.backend = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: String(ctx.port),
        HOST: '127.0.0.1',
        PANEL_TOKEN: TOKEN,
        CONFIG_PATH: CONFIG,
        // Home Assistant deliberately absent — music must not depend on it.
        HA_URL: '',
        HA_TOKEN: '',
        IMMICH_URL: '',
        IMMICH_API_KEY: '',
        MASS_URL: `http://127.0.0.1:${ctx.massPort}`,
        MASS_TOKEN: ctx.token ?? 'mass-test-token',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ctx.backend.stdout.on('data', (d) => process.stderr.write(`[backend] ${d}`));
    ctx.backend.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));

    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${ctx.port}/api/health`)).ok;
      } catch {
        return false;
      }
    }, 'backend to listen');
  });

  after(async () => {
    if (ctx.backend && ctx.backend.exitCode === null) {
      ctx.backend.kill('SIGTERM');
      await new Promise((resolve) => {
        ctx.backend.once('exit', resolve);
        setTimeout(() => {
          ctx.backend.kill('SIGKILL');
          resolve();
        }, 3000);
      });
    }
    await ctx.mass?.stop();
  });

  return ctx;
}

/* ── Players ──────────────────────────────────────────────────────────────*/

describe('speakers from Music Assistant', () => {
  const ctx = isolated((mass) => {
    mass.seedPlayer('kitchen', 'Kitchen');
    mass.seedPlayer('living', 'Living Room', { playback_state: 'playing', volume_level: 55 });
    // Infrastructure players. Music Assistant creates these for AirPlay and
    // the like, and its own UI hides them — so must ours.
    mass.seedPlayer('airplay-proto', 'AirPlay wrapper', { type: 'protocol' });
    mass.seedPlayer('hue-sync', 'Hue Sync', { type: 'light' });
    mass.seedPlayer('hidden-one', 'Hidden', { hide_in_ui: true });
    mass.seedPlayer('disabled-one', 'Disabled', { enabled: false });
  });

  test('delivers players and queues in the first frame', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players to arrive');

    const kitchen = panel.player('kitchen');
    assert.ok(kitchen, 'the kitchen speaker must be present');
    assert.equal(kitchen.name, 'Kitchen');
    // Music Assistant's own 0-100 scale, NOT Home Assistant's 0-1.
    assert.equal(panel.player('living').volume, 55);
    assert.equal(panel.player('living').state, 'playing');
    assert.equal(kitchen.queueId, 'kitchen', 'each player names the queue driving it');

    panel.close();
  });

  test('hides the players Music Assistant itself hides', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players to arrive');

    const ids = panel.players.map((p) => p.id);
    assert.deepEqual(ids.sort(), ['kitchen', 'living']);

    panel.close();
  });

  test('health reports the Music Assistant link', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.health?.mass === 'connected', 'mass to report connected');
    assert.equal(panel.health.massError, null);
    // And Home Assistant is genuinely absent, so this is not passing by
    // accidentally going through it.
    assert.equal(panel.health.ha, 'disconnected');

    panel.close();
  });

  test('a player update is pushed, not polled', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players to arrive');

    const before = ctx.mass.commands.length;
    ctx.mass.updatePlayer('kitchen', {
      playback_state: 'playing',
      volume_level: 72,
      current_media: {
        media_type: 'track',
        title: 'Pushed Track',
        artist: 'Pushed Artist',
        album: 'Pushed Album',
        duration: 240,
        elapsed_time: 30,
        elapsed_time_last_updated: Date.now() / 1000,
        image_url: 'http://music-assistant.local:8095/imageproxy/abc?size=512',
      },
    });

    await waitFor(() => panel.player('kitchen')?.volume === 72, 'the pushed update');
    const kitchen = panel.player('kitchen');
    assert.equal(kitchen.media.title, 'Pushed Track');
    assert.equal(kitchen.media.artist, 'Pushed Artist');

    // Elapsed time arrives in float SECONDS and has to become epoch MS, or
    // the panel's progress bar thinks every track started in 1970.
    assert.ok(kitchen.media.elapsedAt > 1_600_000_000_000, 'elapsedAt must be epoch ms');

    // Nothing was re-fetched to learn this.
    await sleep(200);
    assert.equal(
      ctx.mass.commands.slice(before).filter((c) => c.command === 'players/all').length,
      0,
      'a pushed update must not trigger a refetch',
    );

    panel.close();
  });

  test('never hands the panel a Music Assistant URL', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.player('kitchen')?.media?.art, 'artwork to arrive');

    const wire = JSON.stringify(panel.players);
    assert.ok(!wire.includes('music-assistant.local'), 'the upstream host must not be sent');
    assert.match(panel.player('kitchen').media.art, /^\/img\/art\?k=[0-9a-f]{16}$/);

    panel.close();
  });

  test('forgets everything when the link drops', async () => {
    /*
     * Unlike Home Assistant — where a restart is a blip and the dashboard
     * keeps showing last-known state — a speaker we can no longer reach must
     * stop claiming to be playing. There is no equivalent of "the light is
     * probably still on" for music.
     */
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players to arrive');

    ctx.mass.dropConnections();
    await waitFor(() => panel.players.length === 0, 'players to be cleared');

    // And it comes back on its own.
    await waitFor(() => panel.players.length > 0, 'players to return after reconnect', 15_000);

    panel.close();
  });
});

/* ── Auth ─────────────────────────────────────────────────────────────────*/

describe('authentication', () => {
  const ctx = isolated((mass, c) => {
    mass.seedPlayer('kitchen', 'Kitchen');
    mass.rejectAuth = true;
    c.token = 'wrong-token';
  });

  test('says exactly why a bad token failed', async () => {
    /*
     * A rejected token and an unreachable server both leave the screen empty.
     * Only one of them is fixed by editing an environment variable, so the
     * panel is told which — an empty Media screen on a wall is otherwise
     * unactionable.
     */
    const panel = new TestPanel(ctx.port);
    await panel.connect();

    await waitFor(() => panel.health?.massError, 'an auth error to be reported', 10_000);
    assert.match(panel.health.massError, /token/i);
    assert.equal(panel.players.length, 0);

    panel.close();
  });
});

describe('older servers without tokens', () => {
  const ctx = isolated((mass) => {
    // Below schema 28 Music Assistant has no `auth` command at all. Sending
    // one anyway would fail against every older server.
    mass.schemaVersion = 27;
    mass.seedPlayer('kitchen', 'Kitchen');
  });

  test('connects without attempting to authenticate', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players to arrive');

    assert.equal(
      ctx.mass.commands.filter((c) => c.command === 'auth').length,
      0,
      'auth must not be sent to a server that predates it',
    );
    assert.equal(panel.health.mass, 'connected');

    panel.close();
  });
});

/* ── Browsing ─────────────────────────────────────────────────────────────*/

describe('browsing', () => {
  const ctx = isolated((mass) => {
    mass.seedPlayer('kitchen', 'Kitchen');
    mass.seedLibrary('album', 140);
    mass.seedLibrary('artist', 8);
    const tracks = mass.seedLibrary('track', 30);
    mass.seedLibrary('playlist', 3);
    mass.seedLibrary('radio', 4);
    mass.seedChildren('album-7', tracks.slice(0, 12));
    mass.seedChildren('artist-3', (mass.library.get('album') ?? []).slice(0, 5));
    mass.seedHistory([
      {
        media_type: 'track',
        uri: 'spotify://track/streamed',
        name: 'Streamed, not owned',
        artists: [{ media_type: 'artist', uri: 'spotify://artist/x', name: 'Someone' }],
      },
      ...tracks.slice(0, 4),
    ]);
  });

  test('lists a library page and pages through it', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();

    const first = await panel.browse({ kind: 'library', media: 'album' });
    assert.equal(first.kind, 'list');
    assert.equal(first.items.length, 60);
    assert.equal(first.more, true);
    assert.equal(first.items[0].u, 'library://album/0');
    assert.equal(first.items[0].s, 'Artist 0');

    const second = await panel.browse({ kind: 'library', media: 'album', offset: 60 });
    assert.equal(second.items[0].u, 'library://album/60');

    const last = await panel.browse({ kind: 'library', media: 'album', offset: 120 });
    assert.equal(last.items.length, 20);
    assert.equal(last.more, false);

    panel.close();
  });

  test('reassembles a chunked reply instead of truncating it', async () => {
    /*
     * Music Assistant streams long lists as several messages sharing a
     * message_id, all but the last flagged `partial`. A client that resolves
     * on the first one silently truncates every long list — and only for
     * people with big libraries, which is the worst way to find out.
     *
     * The mock chunks at 25, so a 60-item page arrives in three messages.
     */
    const panel = new TestPanel(ctx.port);
    await panel.connect();

    const page = await panel.browse({ kind: 'library', media: 'album' });
    assert.equal(page.items.length, 60, 'all chunks must be reassembled');
    // And in order, which a naive accumulator can get wrong.
    assert.equal(page.items[24].u, 'library://album/24');
    assert.equal(page.items[25].u, 'library://album/25');
    assert.equal(page.items[59].u, 'library://album/59');

    panel.close();
  });

  test('recently played is a real history, not the library re-sorted', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();

    const before = ctx.mass.commands.length;
    const result = await panel.browse({ kind: 'library', media: 'track', recent: true });

    const command = ctx.mass.commands.slice(before)[0];
    assert.equal(command.command, 'music/recently_played_items');
    // Something streamed but never added to the library can only appear via
    // the history — the library sorted by last-played cannot contain it.
    assert.equal(result.items[0].n, 'Streamed, not owned');

    panel.close();
  });

  test('favorites asks Music Assistant to filter', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();

    const before = ctx.mass.commands.length;
    const result = await panel.browse({ kind: 'library', media: 'album', favorite: true });

    const command = ctx.mass.commands.slice(before)[0];
    assert.equal(command.args.favorite, true);
    assert.equal(result.items.length, 35, '140 albums, every fourth a favorite');
    assert.equal(result.items[0].f, true, 'the favourite flag reaches the panel');

    panel.close();
  });

  test('drills into an album to get its tracks', async () => {
    /*
     * The thing the Home Assistant route could not do at all. Tapping an album
     * should be able to mean "show me track 7", not only "play all of it".
     */
    const panel = new TestPanel(ctx.port);
    await panel.connect();

    const result = await panel.browse({ kind: 'item', uri: 'library://album/7' });
    assert.equal(result.kind, 'list');
    assert.equal(result.items.length, 12);
    assert.equal(result.items[0].k, 'track');

    panel.close();
  });

  test('drills into an artist to get their albums', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();

    const result = await panel.browse({ kind: 'item', uri: 'library://artist/3' });
    assert.equal(result.items.length, 5);
    assert.equal(result.items[0].k, 'album');

    panel.close();
  });

  test('picks the thumbnail rather than whatever image comes first', async () => {
    /*
     * Music Assistant's `metadata.images` holds fanart and logos alongside the
     * thumbnail, in no guaranteed order. Taking images[0] gets you a 2000px
     * backdrop where a 56px cover belongs.
     */
    const panel = new TestPanel(ctx.port);
    await panel.connect();

    const result = await panel.browse({ kind: 'library', media: 'album' });
    for (const item of result.items) {
      assert.match(item.a, /^\/img\/art\?k=[0-9a-f]{16}$/);
    }

    /*
     * Every item shares one fanart image and has its own thumbnail, so
     * reading images[0] collapses every artwork key onto the same value —
     * which looks perfectly plausible until you compare two of them.
     */
    const keys = new Set(result.items.map((i) => i.a));
    assert.equal(keys.size, result.items.length, 'each cover must be its own image');

    panel.close();
  });

  test('search groups results by type', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();

    const result = await panel.browse({ kind: 'search', text: 'album 01' });
    assert.equal(result.kind, 'groups');
    assert.deepEqual(
      result.groups.map((g) => g.name),
      ['Albums'],
    );

    panel.close();
  });

  test('an empty search never reaches Music Assistant', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();

    const before = ctx.mass.commands.length;
    const result = await panel.browse({ kind: 'search', text: '   ' });
    assert.deepEqual(result, { kind: 'groups', groups: [] });

    await sleep(150);
    assert.equal(
      ctx.mass.commands.slice(before).filter((c) => c.command === 'music/search').length,
      0,
    );

    panel.close();
  });
});

/* ── The queue ────────────────────────────────────────────────────────────*/

describe('the queue', () => {
  const ctx = isolated((mass) => {
    mass.seedPlayer('kitchen', 'Kitchen');
    mass.seedQueue('kitchen', 140, 3);
  });

  test('lists the queue — the thing Home Assistant could not do', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players to arrive');

    const page = await panel.browse({ kind: 'queue', queueId: 'kitchen' });
    assert.equal(page.kind, 'queuePage');
    assert.equal(page.entries.length, 60);
    assert.equal(page.total, 140);
    assert.equal(page.current, 3, 'the playing row is marked');
    assert.equal(page.entries[0].id, 'qi-0', 'each row carries the id move and remove need');
    assert.equal(page.entries[0].index, 0);
    assert.equal(page.entries[0].sub, 'Artist 0 · Album 0');

    const second = await panel.browse({ kind: 'queue', queueId: 'kitchen', offset: 60 });
    assert.equal(second.entries[0].id, 'qi-60');
    assert.equal(second.entries[0].index, 60, 'indexes stay absolute across pages');

    panel.close();
  });

  test('refuses a queue the panel was never shown', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players to arrive');

    const before = ctx.mass.commands.length;
    await assert.rejects(
      () => panel.browse({ kind: 'queue', queueId: 'somebody-elses-queue' }),
      /Not permitted/,
    );

    await sleep(150);
    assert.equal(
      ctx.mass.commands.slice(before).filter((c) => c.command === 'player_queues/items').length,
      0,
      'the command must not reach Music Assistant at all',
    );

    panel.close();
  });

  test('reorders, removes and jumps', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players to arrive');

    const before = ctx.mass.commands.length;

    panel.mass('player_queues/move_item', {
      queue_id: 'kitchen',
      queue_item_id: 'qi-5',
      pos_shift: -1,
    });
    panel.mass('player_queues/delete_item', { queue_id: 'kitchen', item_id_or_index: 'qi-9' });
    panel.mass('player_queues/play_index', { queue_id: 'kitchen', index: 12 });

    await waitFor(
      () => ctx.mass.commands.slice(before).length >= 3,
      'the three queue commands to arrive',
    );

    const sent = ctx.mass.commands.slice(before);
    assert.deepEqual(
      sent.map((c) => c.command),
      ['player_queues/move_item', 'player_queues/delete_item', 'player_queues/play_index'],
    );
    assert.equal(sent[0].args.pos_shift, -1);
    assert.equal(sent[1].args.item_id_or_index, 'qi-9');
    assert.equal(sent[2].args.index, 12);

    panel.close();
  });

  test('a queue change is pushed to every panel', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.queues.length > 0, 'queues to arrive');

    ctx.mass.updateQueue('kitchen', { items: 141, current_index: 4 });
    await waitFor(
      () => panel.queues.find((q) => q.id === 'kitchen')?.count === 141,
      'the queue change to be pushed',
    );

    panel.close();
  });
});

/* ── The command guard ────────────────────────────────────────────────────*/

describe('the command guard', () => {
  const ctx = isolated((mass) => {
    mass.seedPlayer('kitchen', 'Kitchen');
    mass.seedPlayer('living', 'Living Room');
  });

  /**
   * Music Assistant's API is an ADMINISTRATIVE api. The same socket that skips
   * a track can delete a playlist, remove a provider and rewrite player
   * config. A wall panel gets the verbs a music remote needs and nothing else.
   */
  const refuse = [
    ['deleting a playlist', 'music/playlists/remove', { item_id: '1' }],
    ['removing a library item', 'music/library/remove_item', { item_id: '1' }],
    ['a full resync', 'music/sync', {}],
    ['announcements', 'players/cmd/play_announcement', { player_id: 'kitchen', url: 'http://x/y.mp3' }],
    ['removing a player', 'players/remove', { player_id: 'kitchen' }],
    ['rewriting player config', 'players/cmd/set_option', { player_id: 'kitchen' }],
    ['creating a group player', 'players/create_group_player', {}],
  ];

  for (const [label, command, args] of refuse) {
    test(`refuses ${label}`, async () => {
      const panel = new TestPanel(ctx.port);
      await panel.connect();
      await waitFor(() => panel.players.length > 0, 'players to arrive');

      const before = ctx.mass.commands.length;
      const mark = panel.messageCount;
      panel.mass(command, args);

      await waitFor(() => panel.since(mark).find((m) => m.t === 'error'), `refusal of ${label}`);
      await sleep(100);
      assert.equal(
        ctx.mass.commands.slice(before).length,
        0,
        `${label} must not reach Music Assistant`,
      );

      panel.close();
    });
  }

  test('refuses a player id it was never shown', async () => {
    /*
     * Grouping takes a LIST of player ids, so it re-targets the command at
     * every player it names. Unchecked, the allow-list would be decoration.
     */
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players to arrive');

    const cases = [
      ['a single unknown player', 'players/cmd/volume_set', { player_id: 'nope', volume_level: 50 }],
      [
        'an unknown player inside a group',
        'players/cmd/set_members',
        { player_id: 'kitchen', child_player_ids: ['living', 'nope'] },
      ],
      ['an unknown queue', 'player_queues/clear', { queue_id: 'nope' }],
    ];

    for (const [label, command, args] of cases) {
      const before = ctx.mass.commands.length;
      const mark = panel.messageCount;
      panel.mass(command, args);

      await waitFor(() => panel.since(mark).find((m) => m.t === 'error'), `refusal of ${label}`);
      await sleep(100);
      assert.equal(ctx.mass.commands.slice(before).length, 0, `${label} must not be forwarded`);
    }

    panel.close();
  });

  test('refuses media that is not a library URI', async () => {
    /*
     * Music Assistant will play a local file path or fetch an arbitrary URL if
     * handed one, which turns "play this album" into a way to read its host's
     * disk or make it fetch a URL of the caller's choosing.
     */
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players to arrive');

    for (const media of [
      'file:///etc/passwd',
      '/etc/shadow',
      'http://evil.example/x.mp3',
      'https://evil.example/x.mp3',
      'data:audio/mp3;base64,AAAA',
      '',
      42,
    ]) {
      const before = ctx.mass.commands.length;
      const mark = panel.messageCount;
      panel.mass('player_queues/play_media', { queue_id: 'kitchen', media });

      await waitFor(
        () => panel.since(mark).find((m) => m.t === 'error'),
        `refusal of ${String(media)}`,
      );
      await sleep(80);
      assert.equal(
        ctx.mass.commands.slice(before).length,
        0,
        `${String(media)} must not be forwarded`,
      );
    }

    panel.close();
  });

  test('forwards a legitimate command, with unknown arguments dropped', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players to arrive');

    const before = ctx.mass.commands.length;
    panel.mass('player_queues/play_media', {
      queue_id: 'kitchen',
      media: 'library://album/7',
      option: 'replace',
      // Not on the argument allow-list. Music Assistant ignores unknown
      // arguments rather than rejecting them, so an unfiltered pass-through
      // would hand it whatever a compromised panel invented.
      evil: true,
      user: 'someone-else',
    });

    const sent = await waitFor(
      () => ctx.mass.commands.slice(before)[0],
      'the command to reach Music Assistant',
    );
    assert.equal(sent.command, 'player_queues/play_media');
    assert.equal(sent.args.media, 'library://album/7');
    assert.ok(!('evil' in sent.args), 'unknown arguments must be dropped');
    assert.ok(!('user' in sent.args), 'unknown arguments must be dropped');

    panel.close();
  });

  test('clamps volume to Music Assistant’s scale', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players to arrive');

    const mark = panel.messageCount;
    panel.mass('players/cmd/volume_set', { player_id: 'kitchen', volume_level: 900 });
    await waitFor(() => panel.since(mark).find((m) => m.t === 'error'), 'refusal of 900%');

    const before = ctx.mass.commands.length;
    panel.mass('players/cmd/volume_set', { player_id: 'kitchen', volume_level: 42.6 });
    const sent = await waitFor(() => ctx.mass.commands.slice(before)[0], 'the volume command');
    assert.equal(sent.args.volume_level, 43, 'Music Assistant wants an integer');

    panel.close();
  });
});

/* ── Without Music Assistant ──────────────────────────────────────────────*/

describe('when Music Assistant is not configured', () => {
  const ctx = {};

  before(async () => {
    ctx.port = await freePort();
    ctx.backend = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: String(ctx.port),
        HOST: '127.0.0.1',
        PANEL_TOKEN: TOKEN,
        CONFIG_PATH: CONFIG,
        HA_URL: '',
        HA_TOKEN: '',
        IMMICH_URL: '',
        IMMICH_API_KEY: '',
        MASS_URL: '',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    ctx.backend.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${ctx.port}/api/health`)).ok;
      } catch {
        return false;
      }
    }, 'backend to listen');
  });

  after(async () => {
    if (ctx.backend && ctx.backend.exitCode === null) {
      ctx.backend.kill('SIGTERM');
      await new Promise((resolve) => {
        ctx.backend.once('exit', resolve);
        setTimeout(() => {
          ctx.backend.kill('SIGKILL');
          resolve();
        }, 3000);
      });
    }
  });

  test('still boots, and says so rather than failing silently', async () => {
    /*
     * A wall panel that refuses to start because one optional upstream is
     * missing shows nothing at all. Degraded is the correct outcome: the
     * clock and the light switches still work.
     */
    const panel = new TestPanel(ctx.port);
    await panel.connect();

    assert.equal(panel.health.mass, 'disabled');
    assert.deepEqual(panel.players, []);

    await assert.rejects(
      () => panel.browse({ kind: 'library', media: 'album' }),
      /not configured/i,
      'the panel must be told why, not left on a spinner',
    );

    panel.close();
  });
});
