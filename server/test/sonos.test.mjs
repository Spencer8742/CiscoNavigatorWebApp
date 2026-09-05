import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { fileURLToPath, URL } from 'node:url';
import { MockSonos, defaultZones } from './mock-sonos.mjs';
import { MockSmapi } from './mock-smapi.mjs';
import { mkdtemp, copyFile, rm, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeEntities,
  parseXml,
  textOf,
  findAll,
  parseZoneGroupState,
  parseTrackMetadata,
  seconds,
  flag,
} from '../dist/testkit.js';

/**
 * Phase 1 of docs/SONOS.md: the household, read-only.
 *
 * Two layers, for two different kinds of bug.
 *
 * The **direct** tests feed the XML layer the cases that fail silently against
 * real hardware — an album called `Rock & Roll`, an entity that is already
 * escaped, a live stream reporting `NOT_IMPLEMENTED`. None of these throw when
 * they are handled wrongly; they produce plausible output, which is exactly
 * why they need assertions rather than review.
 *
 * The **integration** tests spawn a real backend against a mock household of
 * five speakers on five ports and read the result as the panel does, over the
 * WebSocket. That is what proves the store talks to each speaker rather than
 * reading one and reporting it for all of them.
 *
 * Home Assistant is left unconfigured throughout: music must stand on its
 * own.
 */

const TOKEN = 'panel-token';
const SERVER = fileURLToPath(new URL('../dist/server.js', import.meta.url));
const CONFIG = fileURLToPath(new URL('./fixtures/dashboard.test.yaml', import.meta.url));

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

/* ── The XML layer, directly ──────────────────────────────────────────────*/

describe('entity decoding', () => {
  test('decodes the five named entities', () => {
    assert.equal(decodeEntities('Rock &amp; Roll'), 'Rock & Roll');
    assert.equal(decodeEntities('&lt;Live&gt;'), '<Live>');
    assert.equal(decodeEntities('&quot;x&quot; &apos;y&apos;'), '"x" \'y\'');
  });

  test('decodes numeric references, decimal and hex', () => {
    assert.equal(decodeEntities('caf&#233;'), 'café');
    assert.equal(decodeEntities('caf&#xe9;'), 'café');
  });

  /*
   * The one that matters. `&amp;lt;` is an ESCAPED `&lt;`, so it decodes to
   * the four characters `&lt;` and stops there. A decoder that loops until
   * nothing changes turns it into `<` and corrupts any title containing a
   * literal entity — and, far more often, mangles the second level of Sonos's
   * doubly-escaped payloads.
   */
  test('decodes exactly once', () => {
    assert.equal(decodeEntities('&amp;lt;'), '&lt;');
    assert.equal(decodeEntities('&amp;amp;'), '&amp;');
  });

  test('leaves unknown and malformed entities alone', () => {
    assert.equal(decodeEntities('a &nosuch; b'), 'a &nosuch; b');
    assert.equal(decodeEntities('100% & rising'), '100% & rising');
    // Lone surrogates are not characters; decoding one produces a string that
    // breaks anything that later re-encodes it.
    assert.equal(decodeEntities('&#xD800;'), '&#xD800;');
  });
});

describe('parsing XML', () => {
  test('reads attributes, text and nesting', () => {
    const root = parseXml('<a x="1"><b y="2">hi</b><c/></a>');
    assert.equal(root.name, 'a');
    assert.equal(root.attrs.x, '1');
    assert.equal(textOf(root, 'b'), 'hi');
    assert.equal(findAll(root, 'c').length, 1);
  });

  test('decodes entities in text and in attributes', () => {
    const root = parseXml('<z n="Ben &amp; Jerry&apos;s"><t>Rock &amp; Roll &lt;Live&gt;</t></z>');
    assert.equal(root.attrs.n, "Ben & Jerry's");
    assert.equal(textOf(root, 't'), 'Rock & Roll <Live>');
  });

  test('matches on the local name, ignoring the namespace prefix', () => {
    // Sonos mixes prefixed and bare forms for the same field across services.
    const root = parseXml('<DIDL><dc:title>Teardrop</dc:title></DIDL>');
    assert.equal(textOf(root, 'title'), 'Teardrop');
  });

  test('survives an attribute containing an angle bracket', () => {
    // `indexOf('>')` would truncate this tag and lose the child entirely.
    const root = parseXml('<a note="2 &gt; 1"><b>ok</b></a>');
    assert.equal(root.attrs.note, '2 > 1');
    assert.equal(textOf(root, 'b'), 'ok');
  });

  test('ignores declarations and comments, and keeps CDATA literal', () => {
    const root = parseXml('<?xml version="1.0"?><!-- note --><a><![CDATA[a & b]]></a>');
    assert.equal(root.name, 'a');
    // CDATA is literal by definition — decoding it would be wrong.
    assert.equal(root.text, 'a & b');
  });

  test('a stray closing tag does not tear down the document', () => {
    const root = parseXml('<a><b>one</b></zzz><c>two</c></a>');
    assert.equal(textOf(root, 'c'), 'two');
  });
});

describe('reading the topology', () => {
  test('hides bonded members that are not speakers', () => {
    const { zones } = parseZoneGroupState(TOPOLOGY);
    const names = [...zones.values()].map((z) => z.name).sort();

    assert.deepEqual(names, ['Bedroom', 'Kitchen', 'Living Room', 'Study & Den']);
    // Each of these is a real ZoneGroupMember, and none is a speaker anyone
    // points at. Showing them puts "Sub" in the player picker.
    assert.ok(!zones.has('RINCON_BEDROOM_R'), 'the right channel of a pair is not a speaker');
    assert.ok(!zones.has('RINCON_LIVING_SUB'), 'a bonded sub is not a speaker');
    assert.ok(!zones.has('RINCON_LIVING_SAT'), 'a satellite is not a speaker');
  });

  test('decodes a zone name through both levels of escaping', () => {
    const { zones } = parseZoneGroupState(TOPOLOGY);
    assert.equal(zones.get('RINCON_STUDY').name, 'Study & Den');
  });

  test('groups members under their coordinator, coordinator first', () => {
    const { zones } = parseZoneGroupState(TOPOLOGY);
    const kitchen = zones.get('RINCON_KITCHEN');

    assert.equal(kitchen.coordinator, 'RINCON_LIVING');
    assert.deepEqual(kitchen.group, ['RINCON_LIVING', 'RINCON_KITCHEN']);
    assert.equal(zones.get('RINCON_LIVING').coordinator, 'RINCON_LIVING');
  });

  test('marks a stereo pair, and keeps every host for failover', () => {
    const { zones, hosts } = parseZoneGroupState(TOPOLOGY);
    assert.equal(zones.get('RINCON_BEDROOM').kind, 'stereo_pair');
    assert.equal(zones.get('RINCON_LIVING').kind, 'player');

    // The port travels with the address: taking the speaker's own word for
    // where it listens is what lets the mock household use ordinary ports.
    assert.ok(hosts.includes('192.168.1.51:1400'));
    assert.ok(hosts.length >= 4, 'every member address is kept, visible or not');
  });
});

describe('reading track metadata', () => {
  test('decodes a title through DIDL escaping', () => {
    const track = parseTrackMetadata(
      '<DIDL-Lite><item><dc:title>Rock &amp; Roll &lt;Live&gt;</dc:title>' +
        '<dc:creator>Led Zeppelin</dc:creator></item></DIDL-Lite>',
    );
    assert.equal(track.title, 'Rock & Roll <Live>');
    assert.equal(track.artist, 'Led Zeppelin');
  });

  test('is null for an empty or unimplemented payload', () => {
    assert.equal(parseTrackMetadata(''), null);
    assert.equal(parseTrackMetadata('NOT_IMPLEMENTED'), null);
    assert.equal(parseTrackMetadata(null), null);
  });
});

describe('Sonos value conventions', () => {
  test('reads H:MM:SS', () => {
    assert.equal(seconds('0:04:12'), 252);
    assert.equal(seconds('1:00:00'), 3600);
  });

  /*
   * A live stream reports NOT_IMPLEMENTED for both position and duration.
   * Parsing that to 0 draws a progress bar claiming a radio station is at the
   * start of a zero-length track.
   */
  test('NOT_IMPLEMENTED is null, not zero', () => {
    assert.equal(seconds('NOT_IMPLEMENTED'), null);
    assert.equal(seconds(''), null);
    assert.equal(seconds('garbage'), null);
  });

  test('booleans are 1 and 0', () => {
    assert.equal(flag('1'), true);
    assert.equal(flag('0'), false);
    // Notably NOT 'true' — nothing in Sonos ever sends that.
    assert.equal(flag('true'), false);
  });
});

/* ── The panel's view ─────────────────────────────────────────────────────*/

/** A panel: connects, records what it is told, and can drive a speaker. */
class TestPanel {
  #seq = 900;
  #browsers = new Map();

  constructor(port) {
    this.port = port;
    this.players = [];
    this.queues = [];
    this.health = null;
    this.sources = [];
    this.messages = [];
  }

  music(cmd) {
    this.ws.send(JSON.stringify({ t: 'music', id: (this.#seq += 1), cmd }));
  }

  /** Ask for something to look at, and wait for the answer. */
  browse(req) {
    const id = (this.#seq += 1);
    return new Promise((resolve, reject) => {
      this.#browsers.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ t: 'browse', id, req }));
      setTimeout(() => {
        if (this.#browsers.delete(id)) reject(new Error('browse timed out'));
      }, 8000);
    });
  }

  /** Connect or disconnect a music service, and wait for the answer. */
  link(sid, op) {
    const id = (this.#seq += 1);
    return new Promise((resolve, reject) => {
      this.#browsers.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ t: 'link', id, sid, op }));
      setTimeout(() => {
        if (this.#browsers.delete(id)) reject(new Error('link timed out'));
      }, 8000);
    });
  }

  get messageCount() {
    return this.messages.length;
  }

  /**
   * The last command refusal the backend sent, or null.
   *
   * `music_failed` rather than any `t: 'error'`, so a failed browse in the
   * same test does not read as a failed command. Asserting this is null is
   * how a test says "and nothing went wrong", which is the half a call-shape
   * assertion cannot cover.
   */
  get lastToast() {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const msg = this.messages[i];
      if (msg.t === 'error' && msg.code === 'music_failed') return msg.message;
    }
    return null;
  }

  since(i) {
    return this.messages.slice(i);
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
        this.sources = msg.sources;
      } else if (msg.t === 'players') {
        this.players = msg.players;
        this.queues = msg.queues;
      } else if (msg.t === 'health') {
        this.health = msg.health;
      } else if (msg.t === 'sources') {
        this.sources = msg.sources;
      } else if (msg.t === 'browse') {
        const w = this.#browsers.get(msg.ref);
        if (w) {
          this.#browsers.delete(msg.ref);
          w.resolve(msg.result);
        }
      } else if (msg.t === 'link') {
        const w = this.#browsers.get(msg.ref);
        if (w) {
          this.#browsers.delete(msg.ref);
          w.resolve(msg.link);
        }
      } else if (msg.t === 'error') {
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

  player(id) {
    return this.players.find((p) => p.id === id);
  }

  queue(id) {
    return this.queues.find((q) => q.id === id);
  }

  close() {
    this.ws?.close();
  }
}

/** A backend with its own mock household. */
function isolated({ host, zones, swallowEvents = false, services = false } = {}) {
  const ctx = {};

  before(async () => {
    ctx.port = await freePort();
    ctx.sonos = new MockSonos(zones ?? defaultZones());
    ctx.sonos.swallowEvents = swallowEvents;
    await ctx.sonos.start();

    /*
     * Music-service tokens are written next to the config, so a suite that
     * links a service gets its own directory. Without it a link would survive
     * into the next run and the second run would test a different program
     * from the first.
     */
    ctx.stateDir = await mkdtemp(join(tmpdir(), 'navigator-sonos-'));
    const configPath = join(ctx.stateDir, 'dashboard.yaml');
    await copyFile(CONFIG, configPath);
    if (services) {
      ctx.smapi = new MockSmapi();
      await ctx.smapi.start();
    }

    // Point SONOS_HOST at ONE speaker. Everything else — including the other
    // four addresses — has to come out of the topology it answers with.
    const seed = host === undefined ? ctx.sonos.address('RINCON_KITCHEN') : host;

    ctx.backend = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: String(ctx.port),
        HOST: '127.0.0.1',
        PANEL_TOKEN: TOKEN,
        CONFIG_PATH: configPath,
        HA_URL: '',
        HA_TOKEN: '',
        IMMICH_URL: '',
        IMMICH_API_KEY: '',
        SONOS_HOST: seed,
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
    await ctx.sonos?.stop();
    await ctx.smapi?.stop();
    if (ctx.stateDir) await rm(ctx.stateDir, { recursive: true, force: true });
  });

  return ctx;
}

describe('speakers from Sonos', () => {
  const ctx = isolated();

  test('the household reaches the panel in the first frame', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players to arrive');

    assert.equal(panel.health.sonos, 'connected');
    assert.equal(panel.health.sonosError, null);

    const names = panel.players.map((p) => p.name);
    assert.deepEqual(names, ['Bedroom', 'Kitchen', 'Living Room', 'Study & Den']);

    panel.close();
  });

  /*
   * The reason the mock runs one server per speaker. A store that reads one
   * address and reports it for the whole household passes every other test in
   * this file and gives four speakers the same volume.
   */
  test('each speaker is read at its own address', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    // Every volume, not just the first: waiting on one speaker made this pass
    // or fail depending on the order four concurrent reads happened to finish.
    await waitFor(
      () => panel.players.length === 4 && panel.players.every((p) => p.volume !== null),
      'every volume',
    );

    assert.equal(panel.player('RINCON_LIVING').volume, 35);
    assert.equal(panel.player('RINCON_KITCHEN').volume, 18);
    assert.equal(panel.player('RINCON_STUDY').volume, 55);
    assert.equal(panel.player('RINCON_BEDROOM').volume, 8);

    assert.equal(panel.player('RINCON_STUDY').muted, true);
    assert.equal(panel.player('RINCON_LIVING').muted, false);

    panel.close();
  });

  /*
   * A grouped follower's own AVTransport says STOPPED while it is audibly
   * playing. Only its coordinator knows. Asking each speaker about itself
   * draws a paused Kitchen in the middle of a party.
   */
  test('a follower reports what its coordinator is playing', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.player('RINCON_KITCHEN')?.media !== null, 'media');

    const kitchen = panel.player('RINCON_KITCHEN');
    assert.equal(kitchen.state, 'playing', 'the mock has the Kitchen reporting STOPPED');
    assert.equal(kitchen.syncedTo, 'RINCON_LIVING');
    assert.deepEqual(kitchen.members, ['RINCON_LIVING', 'RINCON_KITCHEN']);
    assert.equal(kitchen.media.title, 'Rock & Roll <Live>');

    const living = panel.player('RINCON_LIVING');
    assert.equal(living.syncedTo, null, 'the coordinator follows nobody');

    // A group of one is not a group: a lone speaker listing itself as its own
    // member reads oddly in "Playing on".
    assert.deepEqual(panel.player('RINCON_BEDROOM').members, []);

    panel.close();
  });

  test('now playing survives both levels of escaping', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.player('RINCON_LIVING')?.media !== null, 'media');

    const media = panel.player('RINCON_LIVING').media;
    assert.equal(media.title, 'Rock & Roll <Live>');
    assert.equal(media.artist, 'Led Zeppelin');
    assert.equal(media.album, 'Led Zeppelin IV');
    assert.equal(media.duration, 252);
    assert.equal(media.elapsed, 67);
    assert.ok(media.elapsedAt > 0, 'the moment it was measured, so the panel can extrapolate');

    // Artwork is a key on our own origin, never a Sonos address — the panel is
    // never told where another device on the LAN lives.
    assert.match(media.art, /^\/img\/art\?k=[0-9a-f]{16}$/);

    panel.close();
  });

  test('a live stream shows the song, not the station, and has no progress bar', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.player('RINCON_STUDY')?.media !== null, 'media');

    const media = panel.player('RINCON_STUDY').media;
    // dc:title is the station and r:streamContent is the song. A panel that
    // reads only dc:title shows the same text for an hour and looks frozen.
    assert.equal(media.title, 'Sleaford Mods - Nudge It');
    assert.equal(media.artist, 'BBC Radio 6 Music');
    assert.equal(media.duration, null, 'NOT_IMPLEMENTED is not zero');
    assert.equal(media.elapsed, null);

    panel.close();
  });

  test('one queue per group, owned by the coordinator', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.queues.length > 0, 'queues');

    const ids = panel.queues.map((q) => q.id).sort();
    // The Kitchen is a follower: it has no queue of its own while grouped.
    assert.deepEqual(ids, ['RINCON_BEDROOM', 'RINCON_LIVING', 'RINCON_STUDY']);

    const living = panel.queue('RINCON_LIVING');
    assert.equal(living.count, 12);
    // Sonos counts tracks from 1; the panel counts from 0.
    assert.equal(living.index, 2, 'the mock is on track 3');

    // SHUFFLE means shuffle AND repeat-all. SHUFFLE_NOREPEAT is the one that
    // means what its name suggests. Reading them the obvious way round makes
    // the repeat button lie.
    assert.equal(living.shuffle, true);
    assert.equal(living.repeat, 'all');

    const bedroom = panel.queue('RINCON_BEDROOM');
    assert.equal(bedroom.shuffle, true);
    assert.equal(bedroom.repeat, 'off');

    // Every player names the queue driving it — for a follower, its group's.
    assert.equal(panel.player('RINCON_KITCHEN').queueId, 'RINCON_LIVING');

    panel.close();
  });

  test('every zone can be grouped with every other, and none has power', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const all = panel.players.map((p) => p.id).sort();
    for (const player of panel.players) {
      // Sonos groups anything with anything, so this is every OTHER zone.
      assert.deepEqual(
        [...player.canGroupWith].sort(),
        all.filter((id) => id !== player.id),
      );
      assert.equal(player.powered, null, 'Sonos speakers have no power concept');
    }

    panel.close();
  });
});

/* ── Phase 2: events ──────────────────────────────────────────────────────*/

describe('live updates', () => {
  const ctx = isolated();

  test('subscribes to the right services on the right speakers', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');
    /*
     * All EIGHT, not "enough to look started": four RenderingControl, three
     * AVTransport, one topology. Waiting for a subset and then asserting on
     * the whole set is a race that passes on a fast machine and fails on a
     * slow one — the assertions below are the real wait condition, so they
     * are what this counts.
     */
    await waitFor(() => ctx.sonos.liveSubscriptions.length >= 8, 'subscriptions');

    const live = ctx.sonos.liveSubscriptions;
    const on = (service) => live.filter((s) => s.service === service).map((s) => s.uuid).sort();

    // Volume is per speaker, so every visible zone gets one.
    assert.deepEqual(on('RenderingControl'), [
      'RINCON_BEDROOM',
      'RINCON_KITCHEN',
      'RINCON_LIVING',
      'RINCON_STUDY',
    ]);

    // Transport is per GROUP. The Kitchen is a follower, and its own
    // AVTransport would report STOPPED while it is audibly playing — so
    // subscribing to it would deliver a stream of confidently wrong states.
    assert.deepEqual(on('AVTransport'), ['RINCON_BEDROOM', 'RINCON_LIVING', 'RINCON_STUDY']);

    // Topology is household-wide; one subscription serves it.
    assert.equal(on('ZoneGroupTopology').length, 1);

    panel.close();
  });

  test('a volume changed in the Sonos app arrives without being asked for', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.player('RINCON_BEDROOM')?.volume === 8, 'the starting volume');

    /*
     * Wait for push to be ESTABLISHED before measuring.
     *
     * Until the first event lands the backend does not yet know the callback
     * path works, so its five-second tick polls — correctly. Taking the
     * baseline inside that window makes this test measure the fallback and
     * fail intermittently, which is what it did.
     */
    await waitFor(() => panel.health?.sonosUpdates === 'live', 'push to be established');

    const soapBefore = ctx.sonos.calls.length;
    await ctx.sonos.set('RINCON_BEDROOM', { volume: 42, mute: true });

    // Two seconds, not the fifteen phase 1's poll needed. If this ever starts
    // taking longer, the push path has broken and something is polling again.
    await waitFor(
      () => panel.player('RINCON_BEDROOM')?.volume === 42,
      'the new volume to be pushed',
      2000,
    );
    assert.equal(panel.player('RINCON_BEDROOM').muted, true);

    /*
     * And it cost no request of ours: the speaker volunteered it.
     *
     * Asserted as "nothing re-read THIS SPEAKER'S volume", not "no SOAP call
     * happened anywhere". The second is a broader claim than this test's own
     * name makes and it is not true: a topology reconcile debounced from an
     * earlier event legitimately re-reads a coordinator's transport, and on a
     * loaded machine that lands inside this two-second window. Reproduced
     * under CPU contention, where the extra calls were exactly one
     * `#readGroup` — `GetTransportInfo`, `GetPositionInfo`, `GetMediaInfo`,
     * `GetTransportSettings`, `GetRemainingSleepTimerDuration`.
     *
     * The property worth guarding is the one that breaks if the store starts
     * polling again: an event about a speaker's volume must not send us back
     * to ask that speaker its volume. `#readZone` is `GetVolume` + `GetMute`,
     * so those are what must be absent.
     */
    const readBack = ctx.sonos.calls
      .slice(soapBefore)
      .filter(
        (c) =>
          c.uuid === 'RINCON_BEDROOM' &&
          (c.action === 'GetVolume' || c.action === 'GetMute'),
      );

    assert.deepEqual(
      readBack.map((c) => c.action),
      [],
      'a pushed change must not trigger a read back',
    );

    panel.close();
  });

  test('a track change pushes the new track and re-anchors the position', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.player('RINCON_LIVING')?.media !== null, 'media');

    await ctx.sonos.set('RINCON_LIVING', {
      trackNo: 4,
      duration: '0:03:30',
      relTime: '0:00:02',
      track: { title: 'Black Dog', creator: 'Led Zeppelin', album: 'Led Zeppelin IV' },
    });

    await waitFor(
      () => panel.player('RINCON_LIVING')?.media?.title === 'Black Dog',
      'the new track to be pushed',
      3000,
    );

    /*
     * The event carries the duration but never the position, so the backend
     * follows it with one GetPositionInfo. Without that the panel would
     * extrapolate from the PREVIOUS track's offset and draw a bar that starts
     * a minute in.
     */
    await waitFor(
      () => panel.player('RINCON_LIVING')?.media?.elapsed === 2,
      'the position to be re-anchored',
      3000,
    );
    assert.equal(panel.player('RINCON_LIVING').media.duration, 210);

    panel.close();
  });

  test('grouping done elsewhere re-shapes the subscriptions', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');
    await waitFor(() => ctx.sonos.liveSubscriptions.length >= 6, 'subscriptions');

    // As if somebody grouped the Study into the Living Room in the Sonos app.
    await ctx.sonos.regroup('RINCON_STUDY', 'RINCON_LIVING');

    await waitFor(
      () => panel.player('RINCON_STUDY')?.syncedTo === 'RINCON_LIVING',
      'the new grouping to be pushed',
      3000,
    );

    // Its transport subscription has to go: the coordinator speaks for it now.
    await waitFor(
      () =>
        !ctx.sonos.liveSubscriptions.some(
          (s) => s.uuid === 'RINCON_STUDY' && s.service === 'AVTransport',
        ),
      'the follower’s transport subscription to be dropped',
      3000,
    );

    // And it must be dropped properly rather than left to lapse — a speaker
    // whose subscriber vanished keeps POSTing at a dead endpoint.
    assert.ok(
      ctx.sonos.subscriptions.some(
        (s) => s.method === 'UNSUBSCRIBE' && s.uuid === 'RINCON_STUDY',
      ),
      'the subscription must be torn down, not abandoned',
    );

    panel.close();
  });

  /*
   * Grouping felt slow because the panel was published LAST — behind a
   * subscription reconcile and a re-read of every zone, several times over,
   * since one regroup emits a topology event per speaker involved.
   *
   * The topology event already carries the complete new grouping, so there is
   * nothing to wait for. This pins that: the panel learns about it before the
   * follow-up reads have happened.
   */
  test('a regroup reaches the panel before the follow-up reads', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');
    await waitFor(() => ctx.sonos.liveSubscriptions.length >= 6, 'subscriptions');

    await sleep(200);
    const started = Date.now();
    await ctx.sonos.regroup('RINCON_BEDROOM', 'RINCON_LIVING');

    await waitFor(
      () => panel.player('RINCON_BEDROOM')?.syncedTo === 'RINCON_LIVING',
      'the new grouping to be pushed',
      2000,
    );

    /*
     * Asserted as LATENCY rather than as a request count.
     *
     * The reconcile is debounced by 600 ms, so arriving inside that window is
     * proof the publish did not wait for it — and it stays true however fast
     * or slow the machine is, where "fewer than N reads happened" races the
     * debounce and fails on a loaded runner.
     */
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 500,
      `the panel should hear before the reconcile even starts (took ${elapsed}ms)`,
    );

    panel.close();
  });

  test('refuses a NOTIFY it cannot account for', async () => {
    // The route carries no bearer token — a speaker has nowhere to put one —
    // so these three checks are what stand in for one.
    const base = `http://127.0.0.1:${ctx.port}`;
    const body =
      '<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">' +
      '<e:property><LastChange>x</LastChange></e:property></e:propertyset>';

    // A guessed path.
    const wrongPath = await fetch(`${base}/sonos/event/deadbeef`, {
      method: 'NOTIFY',
      headers: { sid: 'uuid:whatever' },
      body,
    });
    assert.equal(wrongPath.status, 405, 'an unknown path is not even a NOTIFY route');

    // The real path is a per-boot secret we cannot know from here, so the
    // remaining guard worth reaching from outside is the method policy: no
    // other route in this app accepts anything but GET or HEAD.
    const post = await fetch(`${base}/api/config`, { method: 'POST', body });
    assert.equal(post.status, 405);
  });
});

/*
 * The failure that actually happens in the wild.
 *
 * SUBSCRIBE succeeds — it is outbound — and the NOTIFY never arrives, because
 * the speakers cannot reach the container's address. Commands keep working, so
 * nothing looks broken; the panel just stops noticing anything done anywhere
 * else. Falling back to polling is what makes that survivable, and saying so
 * is what makes it fixable.
 */
describe('when events cannot reach the backend', () => {
  const ctx = isolated({ swallowEvents: true });

  test('falls back to polling rather than going stale', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(
      () => panel.players.length === 4 && panel.players.every((p) => p.volume !== null),
      'the initial read',
    );

    // Changed at the speaker, with no event to announce it.
    await ctx.sonos.set('RINCON_BEDROOM', { volume: 71 });

    // The poll has to find it. Slower than a push — that is the point of
    // preferring push — but the panel is not wrong for five minutes.
    await waitFor(
      () => panel.player('RINCON_BEDROOM')?.volume === 71,
      'the poll to notice',
      15_000,
    );

    panel.close();
  });

  test('says it is polling, and why', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();

    await waitFor(() => panel.health?.sonosUpdates === 'polling', 'the mode to be reported');
    assert.equal(panel.health.sonos, 'connected', 'the household is reachable; events are not');

    await waitFor(() => panel.health?.sonosError !== null, 'a reason', 30_000);
    // Names the actual fix rather than describing the symptom.
    assert.match(panel.health.sonosError, /SONOS_CALLBACK_HOST|host networking/i);

    panel.close();
  });
});

describe('when events do arrive', () => {
  const ctx = isolated();

  test('reports live updates', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.health?.sonosUpdates === 'live', 'live updates to be reported');
    assert.equal(panel.health.sonosError, null);
    panel.close();
  });
});

/* ── Phase 3: control ─────────────────────────────────────────────────────*/

/**
 * Actions that CHANGE something, as opposed to reading it.
 *
 * The distinction matters for refusal tests: the store re-reads state in the
 * background whenever the topology shifts, so "nothing arrived at all" is not
 * a property a refusal can have. "Nothing was done" is.
 */
const COMMAND_ACTIONS = new Set([
  'Play',
  'Pause',
  'Stop',
  'Next',
  'Previous',
  'Seek',
  'SetPlayMode',
  'SetAVTransportURI',
  'BecomeCoordinatorOfStandaloneGroup',
  'DelegateGroupCoordinationTo',
  'SetVolume',
  'SetMute',
]);

describe('driving the speakers', () => {
  const ctx = isolated();

  /**
   * The single most common Sonos integration bug.
   *
   * `Play` sent to a grouped follower is accepted and does nothing. Nothing
   * errors, nothing logs, the music just fails to start — so this asserts the
   * command physically arrived at the coordinator's address.
   */
  test('transport goes to the coordinator, volume to the speaker', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const before = ctx.sonos.calls.length;
    // The Kitchen is a follower of the Living Room.
    panel.music({ verb: 'next', player: 'RINCON_KITCHEN' });

    const call = await waitFor(
      () => ctx.sonos.calls.slice(before).find((c) => c.action === 'Next'),
      'the skip to arrive',
    );
    assert.equal(call.uuid, 'RINCON_LIVING', 'transport belongs to the coordinator');

    const volumeBefore = ctx.sonos.calls.length;
    panel.music({ verb: 'volume', player: 'RINCON_KITCHEN', level: 27 });

    const setVolume = await waitFor(
      () => ctx.sonos.calls.slice(volumeBefore).find((c) => c.action === 'SetVolume'),
      'the volume to arrive',
    );
    assert.equal(setVolume.uuid, 'RINCON_KITCHEN', 'volume belongs to the speaker itself');
    assert.equal(setVolume.args.DesiredVolume, '27');
    assert.equal(setVolume.args.Channel, 'Master');

    panel.close();
  });

  test('play, pause, seek and mute reach the speaker in Sonos’s own vocabulary', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const before = ctx.sonos.calls.length;
    // The Bedroom is PAUSED_PLAYBACK in the fixture, so this must resolve to
    // Play rather than Pause — the store already knows, so it costs no round
    // trip to the speaker.
    panel.music({ verb: 'playPause', player: 'RINCON_BEDROOM' });
    await waitFor(
      () => ctx.sonos.calls.slice(before).find((c) => c.action === 'Play'),
      'play to arrive',
    );

    const seekBefore = ctx.sonos.calls.length;
    panel.music({ verb: 'seek', player: 'RINCON_BEDROOM', seconds: 95 });
    const seek = await waitFor(
      () => ctx.sonos.calls.slice(seekBefore).find((c) => c.action === 'Seek'),
      'seek to arrive',
    );
    // Sonos accepts H:MM:SS and nothing else.
    assert.equal(seek.args.Target, '0:01:35');
    assert.equal(seek.args.Unit, 'REL_TIME');

    const muteBefore = ctx.sonos.calls.length;
    panel.music({ verb: 'mute', player: 'RINCON_BEDROOM', muted: true });
    const mute = await waitFor(
      () => ctx.sonos.calls.slice(muteBefore).find((c) => c.action === 'SetMute'),
      'mute to arrive',
    );
    // Sonos writes booleans as 1/0, never true/false.
    assert.equal(mute.args.DesiredMute, '1');

    panel.close();
  });

  /*
   * Sonos folds shuffle and repeat into ONE setting, so changing either means
   * sending the combination. `SHUFFLE` means shuffle AND repeat-all;
   * `SHUFFLE_NOREPEAT` is the one that means what it says.
   */
  test('shuffle and repeat are sent as the one setting Sonos has', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.queues.length > 0, 'queues');

    // The Bedroom starts SHUFFLE_NOREPEAT: shuffle on, repeat off.
    assert.equal(panel.queue('RINCON_BEDROOM').shuffle, true);
    assert.equal(panel.queue('RINCON_BEDROOM').repeat, 'off');

    const before = ctx.sonos.calls.length;
    panel.music({ verb: 'repeat', player: 'RINCON_BEDROOM', mode: 'all' });

    const call = await waitFor(
      () => ctx.sonos.calls.slice(before).find((c) => c.action === 'SetPlayMode'),
      'the play mode to arrive',
    );
    // Shuffle was already on, so turning repeat to "all" is SHUFFLE — not
    // REPEAT_ALL, which would silently turn shuffle off.
    assert.equal(call.args.NewPlayMode, 'SHUFFLE');

    panel.close();
  });

  test('grouping joins with an x-rincon URI and leaves by standing alone', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const before = ctx.sonos.calls.length;
    // Living Room currently leads the Kitchen. Set it to lead the Study
    // instead: one join, one departure, from a single absolute instruction.
    panel.music({
      verb: 'group',
      player: 'RINCON_LIVING',
      members: ['RINCON_LIVING', 'RINCON_STUDY'],
    });

    const join = await waitFor(
      () => ctx.sonos.calls.slice(before).find((c) => c.action === 'SetAVTransportURI'),
      'the join to arrive',
    );
    assert.equal(join.uuid, 'RINCON_STUDY', 'the JOINER is told to follow');
    assert.equal(join.args.CurrentURI, 'x-rincon:RINCON_LIVING');

    const leave = await waitFor(
      () =>
        ctx.sonos.calls
          .slice(before)
          .find((c) => c.action === 'BecomeCoordinatorOfStandaloneGroup'),
      'the departure to arrive',
    );
    assert.equal(leave.uuid, 'RINCON_KITCHEN', 'the speaker being dropped stands alone');

    panel.close();
  });

  test('hands the current queue to another room', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const before = ctx.sonos.calls.length;
    panel.music({ verb: 'handoff', player: 'RINCON_BEDROOM', target: 'RINCON_STUDY' });
    const delegate = await waitFor(
      () => ctx.sonos.calls.slice(before).find((call) => call.action === 'DelegateGroupCoordinationTo'),
      'the coordinator transfer to arrive',
    );
    assert.equal(delegate.uuid, 'RINCON_BEDROOM');
    assert.equal(delegate.args.NewCoordinator, 'RINCON_STUDY');
    assert.equal(delegate.args.RejoinGroup, '0', 'the old room is left behind');
    panel.close();
  });

  test('refuses a zone it was never shown, and anything that is not a verb', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const cases = [
      ['an unknown zone', { verb: 'volume', player: 'RINCON_NOPE', level: 50 }],
      [
        'an unknown zone inside a group',
        { verb: 'group', player: 'RINCON_LIVING', members: ['RINCON_NOPE'] },
      ],
      ['a volume out of range', { verb: 'volume', player: 'RINCON_LIVING', level: 900 }],
      ['a negative seek', { verb: 'seek', player: 'RINCON_LIVING', seconds: -5 }],
      // There is no SOAP action name on the wire to be permitted or refused —
      // reaching one would mean this repository had written a verb for it.
      ['a SOAP action name', { verb: 'SetZoneAttributes', player: 'RINCON_LIVING' }],
      ['a made-up verb', { verb: 'explode', player: 'RINCON_LIVING' }],
    ];

    for (const [label, cmd] of cases) {
      const before = ctx.sonos.calls.length;
      const mark = panel.messageCount;
      panel.music(cmd);

      await waitFor(() => panel.since(mark).find((m) => m.t === 'error'), `refusal of ${label}`);
      await sleep(80);

      // Counts COMMANDS, not reads: the store legitimately re-reads state in
      // the background after a topology change, and a refusal is about
      // nothing being *done*, not about the backend going quiet.
      const sent = ctx.sonos.calls.slice(before).filter((c) => COMMAND_ACTIONS.has(c.action));
      assert.deepEqual(
        sent.map((c) => c.action),
        [],
        `${label} must not reach a speaker`,
      );
    }

    panel.close();
  });

  /*
   * Tone is per SPEAKER and group volume is per GROUP, and they are not
   * interchangeable. Sonos scales a group's members proportionally, keeping a
   * deliberately quiet speaker quiet; setting each member to the same number
   * would flatten that, and it is the difference people notice at once.
   */
  test('tone goes to the speaker, group volume to the group', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    /*
     * Read the coordinator from the panel rather than assuming it. Earlier
     * tests in this suite regroup the household, and asserting a fixed leader
     * would test the order these tests happen to run in.
     */
    const leader = panel.player('RINCON_KITCHEN')?.syncedTo ?? 'RINCON_KITCHEN';

    const before = ctx.sonos.calls.length;
    panel.music({ verb: 'bass', player: 'RINCON_KITCHEN', level: -4 });
    panel.music({ verb: 'groupVolume', player: 'RINCON_KITCHEN', level: 40 });

    const bass = await waitFor(
      () => ctx.sonos.calls.slice(before).find((c) => c.action === 'SetBass'),
      'the tone change',
    );
    assert.equal(bass.uuid, 'RINCON_KITCHEN', 'tone belongs to the speaker itself');
    assert.equal(bass.args.DesiredBass, '-4');

    const group = await waitFor(
      () => ctx.sonos.calls.slice(before).find((c) => c.action === 'SetGroupVolume'),
      'the group volume change',
    );
    assert.equal(group.uuid, leader, 'group volume belongs to the coordinator');
    assert.equal(group.args.DesiredVolume, '40');

    panel.close();
  });

  /*
   * An EMPTY duration cancels a sleep timer. `0:00:00` is what an obvious
   * implementation sends and what a real speaker rejects — so "Off" would do
   * nothing, which is the worst possible failure for a bedtime control.
   */
  test('a sleep timer is set in H:MM:SS and cancelled with nothing', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    let before = ctx.sonos.calls.length;
    panel.music({ verb: 'sleep', player: 'RINCON_STUDY', minutes: 45 });

    const set = await waitFor(
      () => ctx.sonos.calls.slice(before).find((c) => c.action === 'ConfigureSleepTimer'),
      'the timer to be set',
    );
    assert.equal(set.args.NewSleepTimerDuration, '0:45:00');

    // The countdown starts on the tap rather than a round trip later.
    const running = await waitFor(
      () => panel.player('RINCON_STUDY')?.sleepAt,
      'the countdown to appear',
    );
    assert.ok(running > Date.now() + 44 * 60_000);

    before = ctx.sonos.calls.length;
    panel.music({ verb: 'sleep', player: 'RINCON_STUDY', minutes: 0 });

    const off = await waitFor(
      () => ctx.sonos.calls.slice(before).find((c) => c.action === 'ConfigureSleepTimer'),
      'the timer to be cancelled',
    );
    assert.equal(off.args.NewSleepTimerDuration, '', 'empty cancels; 0:00:00 is refused');

    await waitFor(() => panel.player('RINCON_STUDY')?.sleepAt === null, 'the countdown to clear');

    panel.close();
  });

  /*
   * A speaker with no TV socket refuses, and that refusal is the answer. The
   * alternative is a table of every Sonos model ever made, which would be
   * wrong the day after the next one ships.
   */
  test('an input a speaker does not have is refused in words', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const before = ctx.sonos.calls.length;
    panel.music({ verb: 'input', player: 'RINCON_STUDY', source: 'tv' });

    const set = await waitFor(
      () => ctx.sonos.calls.slice(before).find((c) => c.action === 'SetAVTransportURI'),
      'the input to be selected',
    );
    // Addressed to the speaker that HAS the socket — its own uuid.
    assert.equal(set.args.CurrentURI, 'x-sonos-htastream:RINCON_STUDY:spdif');

    panel.close();
  });

  /*
   * The guard rejects a tone value outside Sonos's own range rather than
   * passing it on. A speaker faults on an out-of-range value rather than
   * clamping it, so this is the difference between a refusal and an error.
   */
  test('an out-of-range tone value never reaches a speaker', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const before = ctx.sonos.calls.length;
    panel.music({ verb: 'treble', player: 'RINCON_STUDY', level: 50 });

    await waitFor(() => panel.lastToast, 'a refusal');
    assert.ok(
      !ctx.sonos.calls.slice(before).some((c) => c.action === 'SetTreble'),
      'nothing was sent',
    );

    panel.close();
  });
});

/* ── Phase 4: browsing ────────────────────────────────────────────────────*/

describe('browsing', () => {
  const ctx = isolated();

  test('favourites come back with keys, not URIs', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const result = await panel.browse({ kind: 'library', media: 'track', favorite: true });
    assert.equal(result.kind, 'list');
    assert.equal(result.items.length, 4);

    const playlist = result.items[0];
    assert.equal(playlist.n, 'Morning & Coffee', 'decoded through both levels of escaping');

    /*
     * Read from `r:resMD`, NOT from the row's own class.
     *
     * Every row in `FV:2` says `object.itemobject.item.sonos-favorite`, which
     * describes the favouriting rather than the favourite. Trusting it draws
     * a track icon on everything — and, far worse, plays a playlist down the
     * single-track path.
     */
    assert.equal(playlist.k, 'playlist');
    assert.equal(result.items[1].k, 'radio', 'a station, from one level down');
    assert.equal(result.items[2].k, 'playlist', 'a service playlist, from one level down');
    assert.equal(result.items[3].k, 'album', 'an album, from one level down');
    assert.equal(playlist.b, false, 'a provider playlist plays but does not open an empty folder');
    assert.equal(result.items[2].b, false, 'every provider collection avoids the dead drill-down');
    assert.notEqual(result.items[3].b, false, 'a local album can still be opened');

    /*
     * The whole point of the registry. A URI here would let the panel name
     * anything a speaker will fetch, and Sonos fetches whatever it is given.
     */
    assert.match(playlist.u, /^[0-9a-f]{16}$/, 'an opaque key, never a URI');
    assert.ok(!playlist.u.includes(':'), 'no scheme can appear in a key');
    assert.match(playlist.a, /^\/img\/art\?k=[0-9a-f]{16}$/, 'artwork is proxied too');

    panel.close();
  });

  test('search includes content saved as Sonos favourites', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const result = await panel.browse({ kind: 'search', text: 'coffee', source: 'library' });
    assert.equal(result.kind, 'groups');
    const saved = result.groups.find((group) => group.name === 'Saved in Sonos');
    assert.deepEqual(saved.items.map((item) => item.n), ['Morning & Coffee']);

    panel.close();
  });

  test('searches every connected source and filters by media type', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const result = await panel.browse({ kind: 'search', text: 'coffee', source: 'all', media: 'playlist' });
    assert.equal(result.kind, 'groups');
    assert.ok(result.groups.some((group) => group.name.startsWith('Sonos ·')));
    assert.ok(result.groups.flatMap((group) => group.items).every((item) => item.k === 'playlist'));
    panel.close();
  });

  test('keeps pinned and recently played music on shared shelves', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');
    const favourites = await panel.browse({ kind: 'library', media: 'track', favorite: true });
    const item = favourites.items[0];

    panel.music({ verb: 'pin', player: 'RINCON_LIVING', item: item.u, media: item, on: true });
    await waitFor(async () => {
      const pinned = await panel.browse({ kind: 'shelf', shelf: 'pinned' });
      return pinned.kind === 'list' && pinned.items[0]?.n === item.n;
    }, 'the pin to reach the shelf');

    panel.music({ verb: 'playItem', player: 'RINCON_LIVING', item: item.u, media: item, enqueue: 'replace' });
    await waitFor(async () => {
      const recent = await panel.browse({ kind: 'shelf', shelf: 'recent' });
      return recent.kind === 'list' && recent.items[0]?.n === item.n;
    }, 'the play to reach recent');
    panel.close();
  });

  test('a local favourite opens its inner library object id', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const favourites = await panel.browse({ kind: 'library', media: 'track', favorite: true });
    const album = favourites.items.find((item) => item.n === 'Led Zeppelin IV');
    const before = ctx.sonos.calls.length;
    await panel.browse({ kind: 'item', uri: album.u });
    const call = ctx.sonos.calls.slice(before).find((entry) => entry.action === 'Browse');
    assert.equal(call.args.ObjectID, 'A:ALBUM/Led%20Zeppelin%20IV');

    panel.close();
  });

  test('reports a real total, so paging is a fact rather than a guess', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const result = await panel.browse({ kind: 'library', media: 'track', favorite: true });
    assert.equal(result.more, false, 'four of four items is the end');

    panel.close();
  });

  test('the queue lists rows, addressed by object id', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const result = await panel.browse({ kind: 'queue', queueId: 'RINCON_KITCHEN' });
    assert.equal(result.kind, 'queuePage');
    assert.equal(result.entries.length, 2);

    // `Q:0/2`, NOT a position. A position would address the wrong track the
    // moment anything was reordered around it.
    assert.equal(result.entries[1].id, 'Q:0/2');
    assert.equal(result.entries[1].name, 'Rock & Roll <Live>');
    assert.equal(result.entries[0].duration, 295);

    panel.close();
  });

  test('a library search appends the term to the category id', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const result = await panel.browse({ kind: 'search', text: 'zeppelin', source: 'library' });
    assert.equal(result.kind, 'groups');

    const albums = result.groups.find((g) => g.name === 'Albums');
    assert.ok(albums, 'the album category matched');
    assert.equal(albums.items[0].n, 'Led Zeppelin IV');

    panel.close();
  });

  /*
   * The two playback paths, and the reason they are two.
   *
   * A radio stream has no end and cannot go in a queue: `AddURIToQueue` on one
   * either fails or produces an entry that plays forever. A track has to go
   * through the queue, and the queue then has to be made the player's source
   * — a speaker that was on a radio station otherwise stays on it while the
   * album sits in a queue nothing is reading.
   */
  test('a stream replaces what is playing; a track goes through the queue', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const favourites = await panel.browse({
      kind: 'library',
      media: 'track',
      favorite: true,
    });
    const radio = favourites.items.find((i) => i.k === 'radio');
    const playlist = favourites.items.find((i) => i.k === 'playlist');
    assert.ok(radio && playlist, 'the fixture has one of each');

    // The stream.
    let before = ctx.sonos.calls.length;
    panel.music({ verb: 'playItem', player: 'RINCON_LIVING', item: radio.u, enqueue: 'replace' });

    const set = await waitFor(
      () => ctx.sonos.calls.slice(before).find((c) => c.action === 'SetAVTransportURI'),
      'the stream to be set',
    );
    assert.match(set.args.CurrentURI, /^x-sonosapi-stream:/);
    // Sonos needs the metadata handed back, or it accepts this and plays
    // silence — the least obvious failure in the whole integration.
    assert.ok(set.args.CurrentURIMetaData.includes('DIDL-Lite'));
    assert.ok(
      !ctx.sonos.calls.slice(before).some((c) => c.action === 'AddURIToQueue'),
      'a stream must never be queued',
    );

    // A real track, which is the only thing the queue path was ever right for.
    const tracks = await panel.browse({ kind: 'library', media: 'track' });
    const track = tracks.items[0];

    before = ctx.sonos.calls.length;
    panel.music({
      verb: 'playItem',
      player: 'RINCON_LIVING',
      item: track.u,
      enqueue: 'replace',
    });

    await waitFor(
      () => ctx.sonos.calls.slice(before).find((c) => c.action === 'AddURIToQueue'),
      'the item to be queued',
    );

    const sent = ctx.sonos.calls.slice(before).map((c) => c.action);
    assert.ok(sent.includes('RemoveAllTracksFromQueue'), 'replace clears first');

    const source = ctx.sonos.calls
      .slice(before)
      .find((c) => c.action === 'SetAVTransportURI');
    assert.match(
      source.args.CurrentURI,
      /^x-rincon-queue:RINCON_LIVING#0$/,
      'the player must be pointed at its own queue, or nothing audible changes',
    );
    assert.ok(sent.includes('Play'));

    // The container is a third path, proved next.
    assert.ok(playlist, 'the fixture has a container favourite');

    panel.close();
  });

  /*
   * The bug a real household found, and the reason the mock now models a
   * refusal that looks like a success.
   *
   * A favourited playlist is a CONTAINER: the speaker resolves it for itself.
   * Sent down the track path it was enqueued — except the service answered
   * "added 0 tracks" with a 200, so the transport was pointed at an empty
   * queue and `Play` came back UPnP 701.
   *
   * `SetAVTransportURI` with the container is what the Sonos app's own "Play
   * now" does, and it never touches the queue.
   */
  test('a container plays without going near the queue', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const favourites = await panel.browse({ kind: 'library', media: 'track', favorite: true });
    const playlist = favourites.items.find((i) => i.k === 'playlist');

    const before = ctx.sonos.calls.length;
    panel.music({
      verb: 'playItem',
      player: 'RINCON_LIVING',
      item: playlist.u,
      enqueue: 'replace',
    });

    const set = await waitFor(
      () => ctx.sonos.calls.slice(before).find((c) => c.action === 'SetAVTransportURI'),
      'the container to be set',
    );
    assert.match(set.args.CurrentURI, /^x-rincon-cpcontainer:/);

    // The `<desc>` naming the service is what tells the speaker which account
    // to play through. Without it the command is accepted and plays silence.
    assert.ok(set.args.CurrentURIMetaData.includes('SA_RINCON'), 'the service descriptor rides along');

    await waitFor(
      () => ctx.sonos.calls.slice(before).some((c) => c.action === 'Play'),
      'it to start',
    );

    const sent = ctx.sonos.calls.slice(before).map((c) => c.action);
    assert.ok(!sent.includes('AddURIToQueue'), 'a container is never enqueued to be played');
    assert.ok(!sent.includes('RemoveAllTracksFromQueue'), 'and never clears the queue to do it');

    // No refusal reached the panel: the speaker actually started.
    assert.equal(panel.lastToast, null, `played cleanly, got: ${panel.lastToast}`);

    panel.close();
  });

  /*
   * A local album is an address in the ContentDirectory (`A:ALBUM/…`), not
   * something a speaker can fetch. Registering the bare object id as if it
   * were a URI produces an `AddURIToQueue` that adds nothing.
   */
  test('a library container with no res gets a playable URI built for it', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const albums = await panel.browse({ kind: 'library', media: 'album' });
    const bare = albums.items.find((i) => i.n === 'Kind of Blue');
    assert.ok(bare, 'the fixture has an album with no res of its own');

    const before = ctx.sonos.calls.length;
    panel.music({ verb: 'playItem', player: 'RINCON_LIVING', item: bare.u, enqueue: 'replace' });

    const set = await waitFor(
      () => ctx.sonos.calls.slice(before).find((c) => c.action === 'SetAVTransportURI'),
      'the album to be set',
    );
    assert.equal(
      set.args.CurrentURI,
      'x-rincon-playlist:RINCON_LIVING#A:ALBUM/Kind%20of%20Blue',
      'built against the coordinator that will play it',
    );

    panel.close();
  });

  /*
   * `NumTracksAdded: 0` is a refusal wearing a 200. Left unchecked it becomes
   * a UPnP 701 two commands later, which is a fault code about transitions
   * describing a problem with credentials.
   */
  test('an enqueue that adds nothing is reported, not turned into a 701', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const tracks = await panel.browse({ kind: 'library', media: 'track' });

    // Make this household refuse the track's own scheme.
    ctx.sonos.enqueueRefusals = ['x-file-cifs:'];

    panel.music({
      verb: 'playItem',
      player: 'RINCON_LIVING',
      item: tracks.items[0].u,
      enqueue: 'replace',
    });

    const toast = await waitFor(() => panel.lastToast, 'a refusal to reach the panel');
    assert.match(toast, /would not add/i);

    ctx.sonos.enqueueRefusals = ['x-rincon-cpcontainer:'];
    panel.close();
  });

  test('refuses a key it never minted, and a queue id it never sent', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const cases = [
      // A URI, which is exactly what the registry exists to make unsayable.
      [
        'a raw URI',
        { verb: 'playItem', player: 'RINCON_LIVING', item: 'x-rincon-mp3radio://evil/x.mp3', enqueue: 'replace' },
      ],
      [
        'an unminted key',
        { verb: 'playItem', player: 'RINCON_LIVING', item: 'aaaaaaaaaaaaaaaa', enqueue: 'replace' },
      ],
      // RemoveTrackFromQueue takes an ObjectID: an unchecked one would reach
      // containers elsewhere in the ContentDirectory.
      ['a non-queue object id', { verb: 'queueRemove', player: 'RINCON_LIVING', item: 'FV:2/1' }],
    ];

    for (const [label, cmd] of cases) {
      const before = ctx.sonos.calls.length;
      const mark = panel.messageCount;
      panel.music(cmd);

      await waitFor(() => panel.since(mark).find((m) => m.t === 'error'), `refusal of ${label}`);
      await sleep(80);

      const sent = ctx.sonos.calls.slice(before).filter((c) => COMMAND_ACTIONS.has(c.action));
      assert.deepEqual(sent.map((c) => c.action), [], `${label} must not reach a speaker`);
    }

    panel.close();
  });
});

/* ── Phase 5: Spotify ─────────────────────────────────────────────────────*/

describe('searching somewhere that does not exist', () => {
  const ctx = isolated();

  test('is refused rather than quietly answered from the library', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    /*
     * Falling through to the local library would answer a search of a service
     * the panel believes in with local results — "your Plex has three albums"
     * rather than the mismatch it actually is.
     */
    await assert.rejects(
      () => panel.browse({ kind: 'search', text: 'zeppelin', source: 'nowhere' }),
      /cannot search|not a place/i,
    );

    panel.close();
  });
});

/* ── Music services ───────────────────────────────────────────────────────*/

/**
 * The half of the integration that leaves the house.
 *
 * Favourites already play anything from any service with no login here at all
 * — that is what `FV:2` is for. What needs a service's own API is SEARCHING
 * it, and browsing a catalog nobody has favourited yet.
 */
describe('music services', () => {
  const ctx = isolated({ services: true });

  /*
   * The household HAS this service — somebody added it in the Sonos app.
   *
   * That is a different question from whether THIS app is connected to it,
   * and the difference is the whole shape of the feature: Sonos knows about
   * hundreds of services and a household has a handful, so the account list
   * is what separates "offer this" from "do not mention this". Whether we
   * hold a token decides only whether the row says "Not connected".
   *
   * Set once, because the catalog is cached for an hour — as it should be,
   * and as it would be in a house.
   */
  before(() => {
    ctx.sonos.services = [
      { sid: 200, name: 'Testify', uri: ctx.smapi.url, auth: 'DeviceLink', capabilities: 563 },
    ];
    // serviceType = sid * 256 + 7.
    ctx.sonos.accounts = [{ type: 200 * 256 + 7, sn: 4 }];
  });

  /*
   * `ListAvailableServices` is Sonos's WHOLE CATALOG — every service it
   * supports in this region, hundreds of them, most needing no login. A filter
   * that let anonymous services through put a row on screen for every podcast
   * aggregator Sonos has ever heard of.
   *
   * The bar is an ACCOUNT: somebody added it in the Sonos app.
   */
  test('the browse root contains household content rather than provider logins', async () => {
    ctx.sonos.services = [
      { sid: 200, name: 'Testify', uri: ctx.smapi.url, auth: 'DeviceLink', capabilities: 563 },
      // Three the household has never added. Two need no login at all, which
      // is exactly what made them slip through.
      { sid: 201, name: 'Podcast Firehose', uri: 'https://a.invalid/x', auth: 'Anonymous' },
      { sid: 202, name: 'Regional Radio', uri: 'https://b.invalid/x', auth: 'Anonymous' },
      { sid: 203, name: 'Some Streamer', uri: 'https://c.invalid/x', auth: 'DeviceLink' },
    ];
    ctx.sonos.accounts = [{ type: 200 * 256 + 7, sn: 4 }];

    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const list = await panel.browse({ kind: 'sources' });
    const names = list.items.map((i) => i.n);

    assert.ok(names.includes('Favourites'));
    assert.ok(names.includes('Sonos Playlists'));
    assert.ok(!names.includes('Testify'), 'provider accounts are not offered as new app logins');
    assert.ok(!names.includes('Podcast Firehose'), 'anonymous is not the same as added');
    assert.ok(!names.includes('Regional Radio'));
    assert.ok(!names.includes('Some Streamer'));
    assert.match(list.note, /accounts already connected in the Sonos app/i);

    panel.close();
  });

  test('a direct provider browse still explains when separate credentials are required', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    await panel.browse({ kind: 'sources' });
    ctx.smapi.anonymous = false;
    const refused = await panel.browse({ kind: 'service', sid: 200 });
    assert.equal(refused.items.length, 0);
    assert.equal(refused.connect, 200, 'names the service to connect');
    assert.match(refused.note, /connect/i);

    panel.close();
  });

  /*
   * A link that will not start must say what the SERVICE said.
   *
   * Routing this through the same explanation as a refused browse produced
   * "Connect SoundCloud to browse it" — on the Connect sheet, as the reason
   * connecting had failed. Advice to do the thing that just failed, and the
   * service's own account of why thrown away.
   */
  test('a link that will not start reports the service, not itself', async () => {
    ctx.smapi.refuseLink = 'Client.AccountRequiresUpgrade';

    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');
    await panel.browse({ kind: 'sources' });

    await assert.rejects(
      () => panel.link(200, 'begin'),
      (err) => {
        assert.match(err.message, /AccountRequiresUpgrade/, "the service's own words");
        assert.doesNotMatch(err.message, /to browse it/, 'not advice to do what just failed');
        return true;
      },
    );

    ctx.smapi.refuseLink = null;
    panel.close();
  });

  /*
   * …and that answer has to OUTLIVE the sheet it was shown in.
   *
   * Services differ from one another — one refusing this app says nothing
   * about the next — so the only way to learn what a given service does is to
   * press Connect and read what came back. A message that vanishes with the
   * sheet makes that experiment worthless: somebody presses the button on four
   * services and ends up knowing nothing about any of them.
   *
   * Unlike `blocked`, this does not withdraw the button. The attempt can
   * reasonably be made again; the report is what changes.
   */
  test('what a service said when connecting failed stays on the service', async () => {
    ctx.smapi.refuseLink = 'Client.AccountRequiresUpgrade';

    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');
    await panel.browse({ kind: 'sources' });

    await assert.rejects(() => panel.link(200, 'begin'));

    const reported = await waitFor(
      () => panel.sources.find((s) => s.sid === 200 && s.lastError),
      'the failure to reach the panel',
    );
    assert.match(reported.lastError, /AccountRequiresUpgrade/, "the service's own words");
    assert.equal(reported.linkable, true, 'still worth trying again');
    assert.equal(reported.blocked, undefined, 'this is not a wall');

    /*
     * And it clears the moment the service starts working, because a stale
     * account of a failure is worse than none — it describes a state the
     * service is no longer in.
     */
    ctx.smapi.refuseLink = null;
    await panel.link(200, 'begin');

    await waitFor(
      () => panel.sources.find((s) => s.sid === 200)?.lastError === undefined,
      'the stale failure to be dropped',
    );

    // Leave no half-finished link behind: `begin` is idempotent within its TTL
    // and would hand the next test a prompt instead of calling the service.
    await panel.link(200, 'forget');
    panel.close();
  });

  test('a refused connection stays retryable and reports why', async () => {
    ctx.smapi.refuseLink = 'Client.NOT_AUTHORIZED';
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');
    await panel.browse({ kind: 'sources' });
    await assert.rejects(() => panel.link(200, 'begin'), /rejected this connection/);
    const source = await waitFor(
      () => panel.sources.find((s) => s.sid === 200 && s.lastError), 'connection error',
    );
    assert.equal(source.linkable, true);
    assert.match(source.lastError, /NOT_AUTHORIZED/);
    ctx.smapi.refuseLink = null;
    await panel.link(200, 'begin');
    await panel.link(200, 'forget');
    panel.close();
  });

  /*
   * `deviceId` carries the household's own serial, not an invented UUID.
   *
   * SoCo — the reference implementation — reads `R_TrialZPSerial` and sends
   * that, because the field means "which device is asking" and this app is a
   * controller for a real household. A generated id is a placeholder standing
   * where a real answer exists.
   */
  test('a link identifies the household, not an invented device', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');
    await panel.browse({ kind: 'sources' });

    const before = ctx.smapi.calls.length;
    await panel.link(200, 'begin');

    const call = ctx.smapi.calls.slice(before)[0];
    assert.match(call.body, /<deviceId>48-A6-B8-11-22-33:7<\/deviceId>/);
    assert.match(call.body, /<deviceProvider>Sonos<\/deviceProvider>/);

    panel.close();
  });

  test('connecting is a code to type, not a redirect', async () => {
    ctx.smapi.pollsBeforeLink = 1;

    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    // Discovery is lazy; asking for the list is what triggers it.
    await panel.browse({ kind: 'sources' });

    const started = await panel.link(200, 'begin');
    assert.equal(started.state, 'prompt');
    assert.equal(started.url, 'https://example.invalid/link');
    assert.equal(started.code, 'ABCD-1234');

    /*
     * The first poll is REFUSED, and that refusal is a SOAP fault. A client
     * that treats every fault as an error can never finish a device link —
     * which is the single most likely way to get this flow wrong.
     */
    const first = await panel.link(200, 'poll');
    assert.equal(first.state, 'waiting');

    const second = await panel.link(200, 'poll');
    assert.equal(second.state, 'linked');

    // Every panel learns, not just the one that did it.
    await waitFor(
      () => panel.sources.find((s) => s.sid === 200)?.ready === true,
      'the connection to be announced',
    );

    panel.close();
  });

  test('a linked service browses, and plays through the household account', async () => {

    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    await panel.browse({ kind: 'sources' });
    const top = await panel.browse({ kind: 'service', sid: 200 });
    assert.deepEqual(top.items.map((i) => i.n), ['Stations', 'My Playlists']);

    // Drill in. The service's own ids are addresses inside the service, and
    // opening one must be a call to it rather than a Browse to a speaker.
    const stations = await panel.browse({ kind: 'item', uri: top.items[0].u });
    const station = stations.items[0];
    assert.equal(station.n, 'Ambient Sleeping Pill');
    assert.equal(station.k, 'radio', 'a stream is a station, not a track');

    const before = ctx.sonos.calls.length;
    panel.music({ verb: 'playItem', player: 'RINCON_LIVING', item: station.u, enqueue: 'replace' });

    const set = await waitFor(
      () => ctx.sonos.calls.slice(before).find((c) => c.action === 'SetAVTransportURI'),
      'the station to be set',
    );

    // `sn=4` is the household's account for this service, learned from
    // `/status/accounts` — not a guess, and playing with the wrong one is
    // silence rather than an error.
    assert.match(set.args.CurrentURI, /^x-sonosapi-stream:st-1\?sid=200&sn=4/);
    assert.match(set.args.CurrentURIMetaData, /SA_RINCON51207_/, 'sid * 256 + 7');

    panel.close();
  });

  test('a track drills down to its artist and album', async () => {

    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    await panel.browse({ kind: 'sources' });
    const top = await panel.browse({ kind: 'service', sid: 200 });
    const playlists = await panel.browse({ kind: 'item', uri: top.items[1].u });
    const tracks = await panel.browse({ kind: 'item', uri: playlists.items[0].u });

    const track = tracks.items[0];
    assert.equal(track.n, 'Nightswimming');
    // Artist and duration live inside `trackMetadata`, one level down. Missing
    // that nesting leaves every row with a blank second line.
    assert.equal(track.s, 'R.E.M. · Automatic for the People');
    assert.equal(track.k, 'track');

    panel.close();
  });

  test('searching a service returns its own catalog, grouped', async () => {

    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');
    await panel.browse({ kind: 'sources' });

    const result = await panel.browse({ kind: 'search', text: 'radiohead', source: 200 });
    assert.equal(result.kind, 'groups');

    const albums = result.groups.find((g) => g.name === 'Albums');
    assert.equal(albums.items[0].n, 'Kid A');

    // Categories the service does not know answer with a fault, which is not
    // a failed search — only every category failing is.
    assert.ok(!result.groups.some((g) => g.name === 'Artists'));

    panel.close();
  });

});

/*
 * The floor this whole feature stands on. Favourites never needed a service
 * login, so a household whose speakers report no services at all must lose the
 * service list and nothing else.
 */
/*
 * `AppLink` is Sonos's newer linking policy and a DIFFERENT SOAP call, with
 * the same three fields wrapped one level deeper. Asking every service for a
 * device link code means an AppLink service can never be connected at all.
 *
 * Its own household because the catalog is cached for an hour, and a test that
 * shares one can only assert conditionally — which is a test that passes
 * whether or not the code is right.
 */
/*
 * The bug that made a real household look like it had no music services at
 * all, and the reason it was invisible here for three rounds.
 *
 * Sonos escapes a URI's own `&` when it writes the DIDL, and escapes the DIDL
 * again when it puts it in `<Result>`. So one decode leaves the query string
 * reading `?sid=200&amp;flags=8300&amp;sn=4`, and a scanner expecting a literal
 * `&` before `sn=` matches nothing — on every household, at every depth.
 *
 * No fixture carried a query string, so the scanner looked perfectly correct.
 */
describe('finding services in what the household already has', () => {
  const ctx = isolated({ services: true });

  before(() => {
    ctx.sonos.services = [
      { sid: 200, name: 'Testify', uri: ctx.smapi.url, auth: 'DeviceLink', capabilities: 563 },
      // Sonos's own kind: no separate account, so its URIs carry no `sn`.
      { sid: 303, name: 'Housecast', uri: 'https://radio.invalid/smapi', auth: 'Anonymous' },
    ];

    /*
     * A saved station, only in this suite.
     *
     * Sonos's OWN services name no account — `?sid=303&flags=8300`, no `sn` —
     * because there is no separate login to identify. A scanner insisting on
     * the pair never found them, so a household that plainly has Sonos Radio
     * appeared not to. Saved stations are where they show up.
     */
    ctx.sonos.containers['R:0/0'] = [
      {
        id: 'R:0/0/1',
        title: 'Main Stream',
        upnpClass: 'object.item.audioItem.audioBroadcast',
        res: 'x-sonosapi-radio:ST%3aetc?sid=303&flags=8300',
      },
    ];
    // The firmware serves NO account list. Everything must come from what the
    // household already holds, which is the case that was completely broken.
    ctx.sonos.accounts = null;
  });

  /*
   * Sonos's own services carry no `sn`, and requiring one lost every last of
   * them — Sonos Radio and TuneIn both. A saved station is where they appear.
   */
  test('a service with no account number is still found', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    await panel.browse({ kind: 'sources' });
    await waitFor(
      () => panel.sources.some((s) => s.sid === 303),
      'the sn-less service named by a saved station is discovered',
    );

    panel.close();
  });

  test('a favourite is enough to discover a service and its account', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    await panel.browse({ kind: 'sources' });

    // The backend still learns the account for playing saved Sonos content.
    await waitFor(
      () => panel.sources.some((s) => s.sid === 200 && s.searchable),
      'the service to reach the panel',
    );

    /*
     * `sn=4` came out of the favourite. Playing through the wrong account is
     * silence rather than an error, so this is the value that matters.
     */
    const favourites = await panel.browse({ kind: 'library', media: 'track', favorite: true });
    const row = favourites.items.find((i) => i.n === 'Late Night Testify');
    assert.ok(row, 'and the favourite itself still plays');

    panel.close();
  });
});

describe('connecting an AppLink service', () => {
  const ctx = isolated({ services: true });

  before(() => {
    ctx.sonos.services = [
      { sid: 210, name: 'Applink', uri: ctx.smapi.url, auth: 'AppLink', capabilities: 563 },
    ];
    ctx.sonos.accounts = [{ type: 210 * 256 + 7, sn: 2 }];
  });

  test('asks for an app link, not a device link code', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');
    await panel.browse({ kind: 'sources' });

    const before = ctx.smapi.calls.length;
    const started = await panel.link(210, 'begin');

    const asked = ctx.smapi.calls.slice(before).map((c) => c.action);
    assert.ok(asked.includes('getAppLink'), 'the AppLink call');
    assert.ok(!asked.includes('getDeviceLinkCode'), 'and not the other one');

    // The fields live one level deeper in this shape, so finding them proves
    // the reply is read by name rather than at a fixed path.
    assert.equal(started.url, 'https://example.invalid/app-link');
    assert.equal(started.code, 'WXYZ-9876');
    assert.equal(started.linkDeviceId, undefined, 'private proof never reaches the panel');
    ctx.smapi.pollsBeforeLink = 0;
    const replies = await Promise.all([panel.link(210, 'poll'), panel.link(210, 'poll')]);
    assert.ok(replies.every((reply) => reply.state === 'linked'));
    const auth = ctx.smapi.calls.filter((c) => c.action === 'getDeviceAuthToken');
    assert.equal(auth.length, 1, 'simultaneous panels share a completed link');
    assert.match(auth[0].body, /<linkDeviceId>private-device-proof<\/linkDeviceId>/);

    panel.close();
  });
});

describe('a household with no music services', () => {
  const ctx = isolated({ services: true });

  before(() => {
    // A real speaker still exposes the A: category folders with no indexed
    // files. The source list must use the track count rather than that shell.
    ctx.sonos.containers['A:'] = [
      { id: 'A:ARTIST', title: 'Artists', upnpClass: 'object.container' },
      { id: 'A:ALBUM', title: 'Albums', upnpClass: 'object.container' },
      { id: 'A:TRACKS', title: 'Tracks', upnpClass: 'object.container' },
    ];
    ctx.sonos.containers['A:TRACKS'] = [];
  });

  test('loses the services and keeps the rest of the browser', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const list = await panel.browse({ kind: 'sources' });
    const names = list.items.map((i) => i.n);

    // Favourites never need a second service login, so they remain first.
    assert.deepEqual(names, ['Favourites', 'Sonos Playlists']);
    assert.equal(list.items[0].s, '4 items', 'the count is real, not a guess');
    assert.match(list.note, /Sonos app/i);

    // A place rather than a record: no play button on a folder.
    assert.equal(list.items[0].o, true);

    panel.close();
  });

  /*
   * Empty local sources are LEFT OUT rather than shown as rows that lead
   * nowhere. This household has no NAS share and no saved stations, which is
   * the common case and used to produce four tabs that were all blank.
   */
  /*
   * The escape hatch. Detection reads the household — accounts, favourites,
   * saved stations — so a service set up in the Sonos app that has left none
   * of those is invisible to it, and would be permanently unreachable here.
   */
  test('the provider catalog remains available to explicit API callers', async () => {
    ctx.sonos.services = [
      { sid: 400, name: 'Undetectable', uri: 'https://u.invalid/x', auth: 'DeviceLink' },
    ];

    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const list = await panel.browse({ kind: 'sources' });
    assert.ok(
      !list.items.some((i) => i.n === 'Undetectable'),
      'it leaves no trace, so detection does not offer it',
    );

    const catalog = await panel.browse({ kind: 'catalog' });
    assert.ok(
      catalog.items.some((i) => i.n === 'Undetectable'),
      'and the catalog has it',
    );

    panel.close();
  });

  test('a source with nothing in it is not offered at all', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const list = await panel.browse({ kind: 'sources' });
    const names = list.items.map((i) => i.n);

    assert.ok(!names.includes('Music Library'), 'no share, so no library row');
    assert.ok(!names.includes('Radio Stations'), 'no saved stations, so no radio row');

    panel.close();
  });

  /*
   * An empty result says WHY. On a wall panel an empty list and a broken one
   * look identical, and the commonest empty list here is entirely correct.
   */
  test('an empty container explains itself', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');

    const albums = await panel.browse({ kind: 'library', media: 'radio' });
    assert.equal(albums.items.length, 0);
    assert.match(albums.note, /Sonos app/, 'says where the thing actually comes from');

    panel.close();
  });
});

describe('when Sonos cannot be reached', () => {
  // A port nothing is listening on: the shape of a wrong SONOS_HOST.
  const ctx = isolated({ host: '127.0.0.1:9' });

  test('says so specifically instead of showing an empty screen', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();

    await waitFor(() => panel.health.sonosError !== null, 'a reason to be reported', 10_000);

    assert.equal(panel.health.sonos, 'disconnected');
    assert.equal(panel.players.length, 0);
    // The Settings screen shows this verbatim. "Disconnected" alone gives
    // nobody standing at the panel anything to act on.
    assert.match(panel.health.sonosError, /UPnP|could not be reached|refused/i);

    panel.close();
  });
});

describe('when Sonos is not configured', () => {
  const ctx = isolated({ host: '' });

  test('is disabled rather than broken', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();

    assert.equal(panel.health.sonos, 'disabled');
    assert.equal(panel.health.sonosError, null);
    assert.equal(panel.players.length, 0);

    panel.close();
  });
});

/**
 * A `ZoneGroupState` payload as a speaker sends it, escaped once.
 *
 * Written out rather than generated so the escaping is visible: this is the
 * document the parser has to get right, and a fixture built by the same code
 * that reads it proves nothing.
 */
const TOPOLOGY = `<ZoneGroupState><ZoneGroups>
<ZoneGroup Coordinator="RINCON_LIVING" ID="RINCON_LIVING:1">
  <ZoneGroupMember UUID="RINCON_LIVING" ZoneName="Living Room"
    Location="http://192.168.1.51:1400/xml/device_description.xml"
    Invisible="0" ChannelMapSet="">
    <Satellite UUID="RINCON_LIVING_SAT" ZoneName="Living Room (LS)"
      Location="http://192.168.1.54:1400/xml/device_description.xml" Invisible="1"/>
  </ZoneGroupMember>
  <ZoneGroupMember UUID="RINCON_KITCHEN" ZoneName="Kitchen"
    Location="http://192.168.1.52:1400/xml/device_description.xml"
    Invisible="0" ChannelMapSet=""/>
  <ZoneGroupMember UUID="RINCON_LIVING_SUB" ZoneName="Living Room (Sub)"
    Location="http://192.168.1.55:1400/xml/device_description.xml"
    Invisible="1" ChannelMapSet=""/>
</ZoneGroup>
<ZoneGroup Coordinator="RINCON_STUDY" ID="RINCON_STUDY:1">
  <ZoneGroupMember UUID="RINCON_STUDY" ZoneName="Study &amp; Den"
    Location="http://192.168.1.53:1400/xml/device_description.xml"
    Invisible="0" ChannelMapSet=""/>
</ZoneGroup>
<ZoneGroup Coordinator="RINCON_BEDROOM" ID="RINCON_BEDROOM:1">
  <ZoneGroupMember UUID="RINCON_BEDROOM" ZoneName="Bedroom"
    Location="http://192.168.1.56:1400/xml/device_description.xml"
    Invisible="0" ChannelMapSet="RINCON_BEDROOM:LF,LF;RINCON_BEDROOM_R:RF,RF"/>
  <ZoneGroupMember UUID="RINCON_BEDROOM_R" ZoneName="Bedroom (R)"
    Location="http://192.168.1.57:1400/xml/device_description.xml"
    Invisible="1" ChannelMapSet=""/>
</ZoneGroup>
</ZoneGroups><VanishedDevices/></ZoneGroupState>`;


describe('manually adding a music service', () => {
  const ctx = isolated({ services: true });
  before(() => {
    ctx.sonos.services = [{ sid: 230, name: 'Hidden Music', uri: ctx.smapi.url, auth: 'AppLink', capabilities: 563 }];
    ctx.sonos.accounts = [];
  });
  test('catalog selection supplies Connect with a source, then refreshes all panels', async () => {
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');
    const catalog = await panel.browse({ kind: 'catalog' });
    const row = catalog.items.find((item) => item.sid === 230);
    assert.ok(row);
    assert.ok(!panel.sources.some((source) => source.sid === 230));
    const result = await panel.browse({ kind: 'item', uri: row.u });
    assert.equal(result.connect, 230);
    const source = await waitFor(() => panel.sources.find((item) => item.sid === 230), 'selected source');
    assert.equal(source.linkable, true);
    const prompts = await Promise.all([panel.link(230, 'begin'), panel.link(230, 'begin')]);
    assert.equal(prompts[0].code, prompts[1].code);
    assert.equal(ctx.smapi.calls.filter((call) => call.action === 'getAppLink').length, 1);
    ctx.smapi.pollsBeforeLink = 0;
    await panel.link(230, 'poll');
    await waitFor(() => panel.sources.find((item) => item.sid === 230)?.ready, 'ready source');
    ctx.smapi.faults.getMetadata = { code: 'Client.AuthTokenExpired' };
    const expired = await panel.browse({ kind: 'item', uri: row.u });
    assert.equal(expired.connect, 230);
    await waitFor(() => !panel.sources.find((item) => item.sid === 230)?.ready, 'expired source');
    panel.close();
  });
});


describe('durable service connections', () => {
  const ctx = isolated({ services: true });
  before(() => {
    ctx.sonos.services = [{ sid: 240, name: 'Saved Music', uri: ctx.smapi.url, auth: 'AppLink', capabilities: 563 }];
    ctx.sonos.accounts = [{ type: 240 * 256 + 7, sn: 2 }];
    ctx.smapi.pollsBeforeLink = 0;
  });
  test('a storage failure does not claim success and can be retried', async () => {
    const path = join(ctx.stateDir, 'music-services.json');
    await mkdir(path);
    const panel = new TestPanel(ctx.port);
    await panel.connect();
    await waitFor(() => panel.players.length > 0, 'players');
    await panel.browse({ kind: 'sources' });
    await panel.link(240, 'begin');
    await assert.rejects(() => panel.link(240, 'poll'), /could not be saved/);
    assert.equal(panel.sources.find((s) => s.sid === 240)?.ready, false);
    await rm(path, { recursive: true });
    await panel.link(240, 'begin');
    assert.equal((await panel.link(240, 'poll')).state, 'linked');
    const stored = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(stored.tokens['240'].token, 'tok-abc');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    panel.close();
  });
});
