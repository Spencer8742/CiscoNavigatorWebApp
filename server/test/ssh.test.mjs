import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';

/*
 * The SSH step that replaced Companion's `caffeinate` on the Mac, against a
 * real SSH server (ssh2's own). What it protects: the command runs, a non-zero
 * exit is a failure, and a host whose key changes is refused BEFORE the
 * password is sent — which is the whole point of pinning it.
 */
const { SshRunner, Controls, ConfigStore } = await import('../dist/testkit.js');

const PORT = 19840;
let dir;
let server;
let hostKey;
/** Every command the server was asked to run. */
const ran = [];
/** Passwords the server was offered. */
const offered = [];

/*
 * ssh2's ed25519 generator occasionally (about 1 in 250) writes a key its own
 * parser rejects as "Malformed OpenSSH private key", which failed every test
 * here through the hooks. Keep generating until the key reads back.
 */
function makeHostKey() {
  for (;;) {
    const key = ssh2.utils.generateKeyPairSync('ed25519').private;
    if (!(ssh2.utils.parseKey(key) instanceof Error)) return key;
  }
}

async function startServer(key) {
  server = await listen(PORT, key);
}

/** An SSH server on `port`, answering the commands below. */
async function listen(port, key) {
  const srv = new ssh2.Server({ hostKeys: [key] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password') offered.push(ctx.password);
      if (ctx.method === 'password' && ctx.username === 'me' && ctx.password === 'right') ctx.accept();
      else ctx.reject(['password']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          ran.push(info.command);
          if (info.command === 'lines') {
            // One line split across two writes, then two more in one.
            stream.write('one\ntw');
            setTimeout(() => {
              stream.write('o\nthree\n');
              stream.exit(0);
              stream.end();
            }, 20);
            return;
          }
          if (info.command === 'forever') {
            stream.write('tick\n');
            return;
          }
          if (info.command === 'say') {
            // A line on stdout, and one on stderr with no newline at all.
            stream.write('out line\n');
            stream.stderr.write('err line');
            stream.exit(1);
            stream.end();
            return;
          }
          stream.exit(info.command === 'false' ? 1 : 0);
          stream.end();
        });
      });
    });
    client.on('error', () => {});
  });
  await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve));
  return srv;
}

async function stopServer() {
  await new Promise((resolve) => server.close(resolve));
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ssh-'));
  hostKey = makeHostKey();
  await startServer(hostKey);
});

after(async () => {
  await stopServer();
  await rm(dir, { recursive: true, force: true });
});

const target = (password = 'right') => ({
  id: 'mac_studio',
  host: `127.0.0.1:${PORT}`,
  username: 'me',
  password,
});

test('runs the command and pins the host key', async () => {
  const known = join(dir, 'known.json');
  const runner = new SshRunner(known);
  assert.equal(await runner.run(target(), 'caffeinate -u -t 1'), null);
  assert.equal(ran.at(-1), 'caffeinate -u -t 1');
  const pinned = JSON.parse(await readFile(known, 'utf8'));
  assert.match(pinned[`127.0.0.1:${PORT}`], /^SHA256:/);
  // And again, against the pin.
  assert.equal(await runner.run(target(), 'caffeinate -u -t 1'), null);
});

test('a non-zero exit is a failure', async () => {
  const runner = new SshRunner(join(dir, 'known-exit.json'));
  assert.match(await runner.run(target(), 'false'), /exited 1/);
});

test('a wrong password is reported, not thrown', async () => {
  const runner = new SshRunner(join(dir, 'known-auth.json'));
  assert.match(await runner.run(target('wrong'), 'true'), /mac_studio:/);
});

test('a changed host key is refused before any password is sent', async () => {
  const known = join(dir, 'known-change.json');
  const runner = new SshRunner(known);
  assert.equal(await runner.run(target(), 'true'), null);

  await stopServer();
  await startServer(makeHostKey());
  try {
    offered.length = 0;
    ran.length = 0;
    assert.equal(await runner.run(target(), 'true'), 'mac_studio: host key changed');
    assert.equal(offered.length, 0, 'the password must not reach an impostor');
    assert.equal(ran.length, 0);
  } finally {
    await stopServer();
    await startServer(hostKey);
  }
});

test('no credential at all names the variable to set', async () => {
  const runner = new SshRunner(join(dir, 'known-none.json'));
  const result = await runner.run({ id: 'mac_studio', host: '127.0.0.1', username: 'me' }, 'true');
  assert.match(result, /SSH_KEY_FILE_MAC_STUDIO/);
});

test('a stream hands back whole lines, however they arrive', async () => {
  const runner = new SshRunner(join(dir, 'known-stream.json'));
  const lines = [];
  const result = await runner.stream(target(), 'lines', (line) => lines.push(line), new AbortController().signal);
  assert.equal(result, null);
  assert.deepEqual(lines, ['one', 'two', 'three']);
});

test('a stream that never ends stops when it is aborted', async () => {
  const runner = new SshRunner(join(dir, 'known-forever.json'));
  const abort = new AbortController();
  const lines = [];
  const done = runner.stream(target(), 'forever', (line) => {
    lines.push(line);
    abort.abort();
  }, abort.signal);
  assert.equal(await done, null);
  assert.deepEqual(lines, ['tick']);
});

/*
 * A Mac asleep when "Office Power" is pressed: the key's Wake-on-LAN and its
 * SSH step start in the same instant, so the first connection finds nobody.
 */
test('a step waits for a host that is still waking, and runs once it answers', async () => {
  const port = PORT + 1;
  const runner = new SshRunner(join(dir, 'known-wake.json'));
  let late;
  const wakes = setTimeout(async () => {
    late = await listen(port, hostKey);
  }, 2500);
  try {
    const started = Date.now();
    const result = await runner.run({ ...target(), host: `127.0.0.1:${port}` }, 'true', { waitForHostMs: 15_000 });
    assert.equal(result, null);
    assert.ok(Date.now() - started >= 2000, 'it did wait');
  } finally {
    clearTimeout(wakes);
    await new Promise((resolve) => (late ? late.close(resolve) : resolve()));
  }
});

test('without waiting, a host that does not answer fails at once', async () => {
  const runner = new SshRunner(join(dir, 'known-down.json'));
  const started = Date.now();
  const result = await runner.run({ ...target(), host: `127.0.0.1:${PORT + 2}` }, 'true');
  assert.match(result, /mac_studio:/);
  assert.ok(Date.now() - started < 2000);
});

test('a refused login is not waited on: it is not a machine still waking', async () => {
  const runner = new SshRunner(join(dir, 'known-refused.json'));
  const started = Date.now();
  const result = await runner.run(target('wrong'), 'true', { waitForHostMs: 15_000 });
  assert.match(result, /mac_studio:/);
  assert.ok(Date.now() - started < 3000, 'it gave up at once');
});

test('capture collects stdout and stderr, including a last line with no newline', async () => {
  const runner = new SshRunner(join(dir, 'known-capture.json'));
  const { problem, lines } = await runner.capture(target(), 'say');
  assert.match(problem, /exited 1/);
  assert.deepEqual(lines.sort(), ['err line', 'out line']);
});

test('a quiet failure is not logged as a warning', async () => {
  const runner = new SshRunner(join(dir, 'known-quiet.json'));
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    const result = await runner.run({ ...target(), host: `127.0.0.1:${PORT + 3}` }, 'true', { quiet: true });
    assert.match(result, /mac_studio:/);
  } finally {
    console.warn = original;
  }
  assert.deepEqual(warned, []);
});

/*
 * "Office Power", as the panel presses it: the Mac's Wake-on-LAN and the SSH
 * step that lights its display start together, so the Mac is still asleep
 * when the SSH step first tries it. The step must wait for it, not fail.
 */
test('a key whose Mac is still waking runs its SSH step once the Mac answers', async () => {
  const port = PORT + 4;
  const own = await mkdtemp(join(tmpdir(), 'ssh-key-'));
  const path = join(own, 'dashboard.yaml');
  await writeFile(path, `
version: 1
controls:
  ssh:
    - { id: mac_studio, host: "127.0.0.1:${port}", username: me }
  pages:
    - id: room
      name: Room
      items:
        - id: office_power
          name: Office Power
          actions:
            - { webhook: wake_the_mac }
            - { ssh: mac_studio, run: caffeinate -u -t 1 }
`);
  const config = new ConfigStore(path);
  assert.equal(await config.load(), true);
  const controls = new Controls({
    getConfig: () => config.current,
    haUrl: '',
    callService: async () => null,
    getEntity: () => null,
    onLights: () => {},
    onTvs: () => {},
    onRoomos: () => {},
    roomosPassword: () => '',
    appleTvCommand: async () => null,
    sshCredential: async () => ({ password: 'right' }),
    sshKnownHostsFile: join(own, 'known.json'),
    hasPanels: () => false,
    tvKeyFile: join(own, 'tv-keys.json'),
  });
  let late;
  const wakes = setTimeout(async () => {
    late = await listen(port, hostKey);
  }, 2500);
  try {
    ran.length = 0;
    const problem = await controls.press('office_power');
    // The webhook fails here (no Home Assistant); the SSH step must not.
    assert.equal(problem, 'Home Assistant is not configured');
    assert.ok(ran.includes('caffeinate -u -t 1'), 'the SSH step ran once the Mac answered');
  } finally {
    clearTimeout(wakes);
    controls.stop();
    config.close();
    await new Promise((resolve) => (late ? late.close(resolve) : resolve()));
    await rm(own, { recursive: true, force: true });
  }
});
