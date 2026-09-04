import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockWebosTv } from './mock-webos.mjs';

/*
 * The webOS client, against a mock television that speaks real SSAP.
 *
 * Imported from the built bundle for the same reason the other suites are:
 * the source is TypeScript with path aliases, and testing what actually ships
 * beats testing something transpiled a second way.
 */
const { WebosClient } = await import('../dist/testkit.js');

const PORT = 19810;
let tv;
let keyDir;

before(async () => {
  tv = new MockWebosTv(PORT);
  await tv.start();
  keyDir = await mkdtemp(join(tmpdir(), 'webos-'));
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
