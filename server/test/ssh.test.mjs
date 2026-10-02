import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';

/*
 * The SSH step that replaced Companion's `caffeinate` on the Mac, against a
 * real SSH server (ssh2's own). What it protects: the command runs, a non-zero
 * exit is a failure, and a host whose key changes is refused BEFORE the
 * password is sent — which is the whole point of pinning it.
 */
const { SshRunner } = await import('../dist/testkit.js');

const PORT = 19840;
let dir;
let server;
let hostKey;
/** Every command the server was asked to run. */
const ran = [];
/** Passwords the server was offered. */
const offered = [];

function makeHostKey() {
  return ssh2.utils.generateKeyPairSync('ed25519').private;
}

async function startServer(key) {
  server = new ssh2.Server({ hostKeys: [key] }, (client) => {
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
          stream.exit(info.command === 'false' ? 1 : 0);
          stream.end();
        });
      });
    });
    client.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
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
