import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const BRIDGE = fileURLToPath(new URL('../src/apple-tv/bridge.py', import.meta.url));
const FAKE_PYATV = fileURLToPath(new URL('./fake-pyatv', import.meta.url));

/**
 * Drives the real bridge.py over its real NDJSON protocol, with a fake Apple
 * TV underneath that can be told to misbehave mid-session.
 */
export class BridgeHarness {
  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'atv-bridge-'));
    this.controlFile = join(this.dir, 'control.json');
    this.logFile = join(this.dir, 'calls.log');
    this.storageFile = join(this.dir, 'storage.json');
    this.states = [];
    this.artworks = [];
    this.stderr = [];
    this.pending = new Map();
    this.sequence = 0;
    this.control({});
  }

  /** Rewrite the scenario. The fake re-reads it on every call. */
  control(settings) {
    this.settings = { ...(this.settings ?? {}), ...settings };
    writeFileSync(this.controlFile, JSON.stringify(this.settings));
  }

  /** Everything the fake Apple TV was asked to do, oldest first. */
  get calls() {
    if (!existsSync(this.logFile)) return [];
    return readFileSync(this.logFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  start() {
    this.child = spawn('python3', [BRIDGE, this.storageFile], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONPATH: FAKE_PYATV,
        PYTHONUNBUFFERED: '1',
        FAKE_ATV_CONTROL: this.controlFile,
        FAKE_ATV_LOG: this.logFile,
      },
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => this.stderr.push(chunk));
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.t === 'state') { this.states.push(message.state); return; }
      if (message.t === 'artwork') { this.artworks.push(message); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending(message);
    });
    return this;
  }

  /** Send a request; resolves with the bridge's response for it. */
  send(payload, timeoutMs = 15_000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`bridge never answered ${payload.t} (id ${id})`));
      }, timeoutMs);
      this.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      this.child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
    });
  }

  /** The most recent published state for a device, if any. */
  state(device = 'living-room') {
    for (let i = this.states.length - 1; i >= 0; i -= 1) {
      if (this.states[i].id === device) return this.states[i];
    }
    return null;
  }

  /** Wait until the fake Apple TV has been asked to do something matching. */
  async untilCall(predicate, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const call = this.calls.find(predicate);
      if (call) return call;
      if (Date.now() > deadline) {
        throw new Error(`no matching call within ${timeoutMs}ms; saw ${JSON.stringify(this.calls)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Wait until `predicate` sees a state it likes, or give up. */
  async untilState(predicate, timeoutMs = 10_000, device = 'living-room') {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = this.state(device);
      if (state && predicate(state)) return state;
      if (Date.now() > deadline) {
        throw new Error(`no matching state within ${timeoutMs}ms; last: ${JSON.stringify(state)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  configure(devices = [{ id: 'living-room', name: 'Living Room', host: '10.0.0.10', shortcuts: [] }]) {
    return this.send({ t: 'configure', devices });
  }

  stop() {
    this.child?.kill('SIGKILL');
  }

  /** Run the bridge's --probe mode against the fake and collect its report. */
  probe(host = '10.0.0.10') {
    return new Promise((resolve) => {
      const child = spawn('python3', [BRIDGE, '--probe', host, this.storageFile], {
        env: {
          ...process.env,
          PYTHONPATH: FAKE_PYATV,
          PYTHONUNBUFFERED: '1',
          FAKE_ATV_CONTROL: this.controlFile,
          FAKE_ATV_LOG: this.logFile,
        },
      });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { out += chunk; });
      child.on('close', (code) => resolve({ code, out }));
    });
  }
}
