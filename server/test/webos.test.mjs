import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockWebosTv } from './mock-webos.mjs';

/** Poll until `check` is truthy, or fail with `what`. */
async function waitFor(check, what, timeoutMs = 4000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) assert.fail(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/*
 * The webOS client, against a mock television that speaks real SSAP.
 *
 * Imported from the built bundle for the same reason the other suites are:
 * the source is TypeScript with path aliases, and testing what actually ships
 * beats testing something transpiled a second way.
 */
const { WebosClient, endpointsFor, inputOfAppId } = await import('../dist/testkit.js');

const PORT = 19810;
let tv;
let keyDir;
let certPath;
let tlsKeyPath;

before(async () => {
  tv = new MockWebosTv(PORT);
  await tv.start();
  keyDir = await mkdtemp(join(tmpdir(), 'webos-'));

  /*
   * A throwaway self-signed certificate, generated here rather than
   * committed.
   *
   * The TLS test needs a server whose certificate cannot be verified —
   * which is the whole point, since that is what a television presents.
   * Generating it per run keeps a private key out of the repository, and
   * out of the way of anything that scans for one.
   */
  certPath = join(keyDir, 'tv-cert.pem');
  tlsKeyPath = join(keyDir, 'tv-key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', tlsKeyPath, '-out', certPath,
    '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1',
  ], { stdio: 'ignore' });
});

after(async () => {
  await tv?.stop();
});

function client(opts = {}) {
  return new WebosClient({ host: `127.0.0.1:${PORT}`, keyFile: join(keyDir, 'tv-keys.json'), ...opts });
}

describe('pairing', () => {
  test('a first connection stores the key the TV hands back', async () => {
    const keyFile = join(keyDir, 'first.json');
    const c = client({ keyFile });

    assert.equal(c.paired, false, 'precondition: nothing stored yet');
    await c.listInputs();

    assert.equal(c.paired, true);
    const stored = JSON.parse(await readFile(keyFile, 'utf8'));
    assert.equal(stored[`127.0.0.1:${PORT}`], 'mock-client-key');
    await c.stop();
  });

  test('a stored key is offered, so the TV does not prompt again', async () => {
    // The failure this guards: a key that is written but never read back
    // works perfectly until a restart, then puts a pairing prompt on a
    // television in the middle of a meeting.
    const keyFile = join(keyDir, 'reuse.json');
    await writeFile(keyFile, JSON.stringify({ [`127.0.0.1:${PORT}`]: 'mock-client-key' }));

    tv.registrations.length = 0;
    const c = client({ keyFile });
    await c.listInputs();

    assert.equal(tv.registrations.length, 1);
    assert.equal(
      tv.registrations[0].clientKey,
      'mock-client-key',
      'the stored key must be sent with the registration',
    );
    await c.stop();
  });

  test('sends the manifest NESTED, or the TV grants nothing', async () => {
    /*
     * The bug this pins, seen on the real set: the manifest was sent flat
     * rather than under `manifest`. The television still registered the
     * client and still handed back a key — it just authorised nothing, so
     * every command came back `401 insufficient permissions` from a client
     * that believed it was paired. The handshake looks entirely successful.
     */
    tv.registrations.length = 0;
    const c = client({ keyFile: join(keyDir, 'manifest.json') });
    await c.listInputs();

    const reg = tv.registrations.at(-1);
    assert.ok(reg.manifest, 'the payload must carry a `manifest` key');
    assert.ok(
      Array.isArray(reg.manifest.permissions) && reg.manifest.permissions.length > 0,
      'and that manifest must ask for permissions',
    );
    assert.ok(
      reg.manifest.permissions.includes('CONTROL_POWER'),
      'including the ones this panel actually uses',
    );
    await c.stop();
  });

  test('a key the TV will not honour is discarded, and pairing starts again', async () => {
    /*
     * Recovery from the above. A bad key sits on disk and is offered again on
     * every reconnect, so without this the panel says "insufficient
     * permissions" forever and the only fix is deleting a file inside the
     * container.
     */
    const keyFile = join(keyDir, 'stale.json');
    await writeFile(keyFile, JSON.stringify({ [`127.0.0.1:${PORT}`]: 'stale-key' }));

    // The set knows this key and refuses everything done with it.
    tv.rejectKeys.add('stale-key');

    const c = client({ keyFile });
    await c.turnOff();

    const stored = JSON.parse(await readFile(keyFile, 'utf8'));
    assert.notEqual(
      stored[`127.0.0.1:${PORT}`],
      'stale-key',
      'the rejected key must not be left on disk to be offered again',
    );
    // Recovery is complete rather than merely clean: the retry re-registers,
    // so a working key is already in place and the next command succeeds
    // without anybody touching anything.
    assert.equal(stored[`127.0.0.1:${PORT}`], 'mock-client-key');
    assert.equal(await c.turnOff(), null, 'and the TV obeys again');

    tv.rejectKeys.clear();
    await c.stop();
  });

  test('waits through the on-screen prompt instead of taking it for an answer', async () => {
    // An unpaired TV answers `pairingType: PROMPT` first and `registered`
    // only once somebody accepts. Treating the first frame as the reply
    // leaves the client believing it paired, with no key to store.
    const keyFile = join(keyDir, 'prompt.json');
    tv.requirePrompt = true;

    const c = client({ keyFile });
    const inputs = await c.listInputs();

    assert.ok(inputs.length > 0, 'the command ran only after the prompt was accepted');
    assert.equal(c.paired, true, 'and the key from the second frame was kept');
    tv.requirePrompt = false;
    await c.stop();
  });
});

describe('commands', () => {
  test('switchInput sends the TV its own input id', async () => {
    tv.commands.length = 0;
    const c = client();
    const error = await c.switchInput('HDMI_2');

    assert.equal(error, null);
    const sent = tv.commands.find((cmd) => cmd.uri === 'ssap://tv/switchInput');
    assert.ok(sent, 'a switchInput request');
    assert.deepEqual(sent.payload, { inputId: 'HDMI_2' });
    await c.stop();
  });

  test('inputs are parsed with their labels', async () => {
    const c = client();
    const inputs = await c.listInputs();

    assert.deepEqual(
      inputs.map((i) => `${i.id}:${i.label}`),
      ['HDMI_1:HDMI 1', 'HDMI_2:Laptop', 'HDMI_3:Mac Studio'],
    );
    await c.stop();
  });

  test('a refusal is reported, not swallowed', async () => {
    // returnValue:false arrives as an ordinary `response`. A client that only
    // looks at the frame type calls this a success — which on a power command
    // means telling somebody the TV turned off when it did not.
    tv.refuse.add('ssap://system/turnOff');
    const c = client();
    const error = await c.turnOff();

    assert.ok(error, 'the refusal must surface as an error');
    assert.match(error, /Refused by the TV/);
    tv.refuse.delete('ssap://system/turnOff');
    await c.stop();
  });
});

describe('what the TV is showing', () => {
  /*
   * The panel labels its input key with the live input, so it has to know
   * one. webOS reports it as the foreground APP — an external input is an app
   * — and pushes updates on a subscription, which is how the label follows
   * the television's own remote and not only this panel's keys.
   */

  test('an input change on the TV reaches the client', async () => {
    const c = client({ keyFile: join(keyDir, 'watch.json') });
    await c.switchInput('HDMI_2');

    await waitFor(() => c.currentInput === 'HDMI_2', 'the input to be reported back');
    await c.switchInput('HDMI_3');
    await waitFor(() => c.currentInput === 'HDMI_3', 'and to follow a second change');
    await c.stop();
  });

  test('a set that goes away stops claiming an input', async () => {
    // Keeping the last value would leave a confident, wrong label on the
    // button for as long as the television stayed off.
    const gone = new MockWebosTv(19833);
    await gone.start();

    const c = new WebosClient({ host: '127.0.0.1:19833', keyFile: join(keyDir, 'gone.json') });
    await c.switchInput('HDMI_2');
    await waitFor(() => c.currentInput === 'HDMI_2', 'an input to be known first');

    await gone.stop();
    await waitFor(() => c.currentInput === undefined, 'the input to become unknown');
    await c.stop();
  });
});

describe('when the TV will not say what it is showing', () => {
  /*
   * Reported from the real set: the input key only ever selected the first
   * input, and showed no label. Both are the same failure — the current
   * input was never known — and the app id is the likeliest reason: webOS
   * reports external inputs under more than one shape, and matching only
   * `com.webos.app.hdmiN` leaves the rest silently unrecognised.
   */

  test('an input is recognised in every shape webOS uses', () => {
    assert.equal(inputOfAppId('com.webos.app.hdmi2'), 'HDMI_2');
    assert.equal(inputOfAppId('com.webos.app.externalinput.hdmi3'), 'HDMI_3');
    assert.equal(inputOfAppId('com.webos.app.hdmi2_1'), 'HDMI_2');
  });

  test('something that is not an input stays not an input', () => {
    // A real answer, not a missing one: the set is on Netflix.
    assert.equal(inputOfAppId('com.webos.app.livetv'), null);
    assert.equal(inputOfAppId('netflix'), null);
    assert.equal(inputOfAppId(undefined), null);
  });

  test('a cycle still moves when the TV never reports an input', async () => {
    // The anchor falls back to what we last ASKED for. Without it every press
    // computes "unknown, so start at the first", which is exactly the
    // "only works for one input" symptom.
    const c = client({ keyFile: join(keyDir, 'anchor.json') });
    assert.equal(c.cycleAnchor, undefined, 'nothing known before any press');

    await c.switchInput('HDMI_3');
    assert.equal(c.cycleAnchor, 'HDMI_3', 'the last request anchors the next step');
    await c.stop();
  });

  test('but the label only ever claims what the set confirmed', async () => {
    /*
     * A television that accepts the command and never reports back — the
     * shape of set this whole suite exists for. The cycle must keep moving
     * from what we asked for, while the LABEL stays silent: a command that
     * was accepted is not a television that did it.
     */
    tv.reportsInput = false;
    tv.foregroundAppId = undefined;

    const c = client({ keyFile: join(keyDir, 'claim.json') });
    const failed = await c.switchInput('HDMI_3');
    assert.equal(failed, null, 'precondition: the set accepts the command');

    assert.equal(c.cycleAnchor, 'HDMI_3', 'the cycle still knows where it got to');
    assert.equal(
      c.currentInput,
      undefined,
      'but an unreported input is never shown as though the TV said so',
    );

    tv.reportsInput = true;
    await c.stop();
  });
});

describe('a television that is off', () => {
  test('is reported as off rather than hanging', async () => {
    const c = client({ host: '127.0.0.1:19811' });
    assert.equal(await c.isOn(), false);
  });

  test('cannot be turned on without a MAC, and says so', async () => {
    // The most likely misconfiguration, and the most confusing symptom: power
    // off works, power on silently does nothing.
    const c = client({ host: '127.0.0.1:19811' });
    const error = await c.turnOn();

    assert.ok(error, 'an error, not a silent no-op');
    assert.match(error, /MAC/);
  });

  test('reports a command as failed instead of resolving null', async () => {
    const c = client({ host: '127.0.0.1:19811' });
    const error = await c.turnOff();
    assert.ok(error, 'turning off an unreachable TV is not a success');
  });
});

/* ── Which port, and over what ────────────────────────────────────────────*/

describe('finding the TV', () => {
  /*
   * The bug this exists for, reported from a real set: every command failed
   * with ECONNRESET. Not a network fault — sets from roughly 2020 on serve
   * SSAP over TLS on 3001 and leave 3000 closed, and a modern TV ACCEPTS the
   * connection on 3000 and immediately resets it. The error names the
   * symptom and hides the cause completely.
   */

  test('tries the modern TLS port first, then the old plain one', () => {
    assert.deepEqual(endpointsFor('192.168.1.67'), [
      'wss://192.168.1.67:3001',
      'ws://192.168.1.67:3000',
    ]);
  });

  test('a written port is honoured, but the scheme is still discovered', () => {
    // The port is an instruction. The scheme is not: choosing it from the
    // port number makes 3001 magic and silently downgrades anything on a
    // non-standard port to plaintext, which fails in exactly the unreadable
    // way this is meant to prevent.
    assert.deepEqual(endpointsFor('192.168.1.67', 8888), [
      'wss://192.168.1.67:8888',
      'ws://192.168.1.67:8888',
    ]);
  });

  test('connects over TLS to a set that only serves 3001', async () => {
    // The real 192.168.1.67 case. The TV's certificate is self-signed and
    // issued to itself, so this only works because verification is off.
    const secure = new MockWebosTv(19831, { tls: true, cert: certPath, key: tlsKeyPath });
    await secure.start();

    const c = new WebosClient({
      host: '127.0.0.1:19831',
      keyFile: join(keyDir, 'tls.json'),
    });
    const error = await c.switchInput('HDMI_2');

    assert.equal(error, null, 'a wss-only TV must be reachable');
    assert.ok(
      secure.commands.some((cmd) => cmd.uri === 'ssap://tv/switchInput'),
      'and the command must actually arrive',
    );

    await c.stop();
    await secure.stop();
  });

  test('falls back to plaintext when TLS is not what is being served', async () => {
    // The opposite shape: an older set with no TLS listener. The client must
    // try wss, fail, and go on rather than giving up — which is what it did
    // before, reporting the TV as simply unreachable.
    const plain = new MockWebosTv(19832);
    await plain.start();

    const c = new WebosClient({ host: '127.0.0.1:19832', keyFile: join(keyDir, 'plain.json') });
    const error = await c.switchInput('HDMI_1');

    assert.equal(error, null, 'plaintext must be reached after TLS fails');
    assert.ok(plain.commands.some((cmd) => cmd.uri === 'ssap://tv/switchInput'));
    await c.stop();
    await plain.stop();
  });
});
