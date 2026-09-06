import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { logger } from '~/lib/log.ts';
import type { AppleTvConfig } from '@shared/config.ts';
import type { AppleTvCommand, AppleTvState } from '@shared/protocol.ts';

const log = logger('apple-tv');

interface BridgeReply { t: 'response'; id: number; ok: boolean; error?: string }
interface BridgeState { t: 'state'; state: AppleTvState }

export class AppleTvBridge {
  readonly #storageFile: string;
  readonly #onState: (states: AppleTvState[]) => void;
  #process: ChildProcessWithoutNullStreams | null = null;
  #devices: AppleTvConfig[] = [];
  #states = new Map<string, AppleTvState>();
  #pending = new Map<number, { resolve: (error: string | null) => void; timer: ReturnType<typeof setTimeout> }>();
  #sequence = 0;
  #restart: ReturnType<typeof setTimeout> | undefined;
  #stopping = false;

  constructor(storageFile: string, onState: (states: AppleTvState[]) => void) {
    this.#storageFile = storageFile;
    this.#onState = onState;
  }

  get snapshot(): AppleTvState[] {
    return this.#devices.map((device) => this.#states.get(device.id) ?? {
      id: device.id, name: device.name, reachable: false, paired: false, pairing: 'idle',
      power: 'unknown', playback: 'idle', mediaType: 'unknown', title: null, artist: null,
      album: null, app: null, elapsed: null, duration: null, elapsedAt: null,
      error: this.#process ? null : 'Apple TV bridge is starting',
    });
  }

  configure(devices: AppleTvConfig[]): void {
    this.#devices = devices;
    const ids = new Set(devices.map((d) => d.id));
    for (const id of this.#states.keys()) if (!ids.has(id)) this.#states.delete(id);
    this.#onState(this.snapshot);
    if (devices.length === 0) {
      this.#stopProcess();
      return;
    }
    this.#ensureProcess();
    void this.#request({ t: 'configure', devices }, 20_000);
  }

  command(device: string, op: AppleTvCommand): Promise<string | null> {
    if (!this.#devices.some((item) => item.id === device)) return Promise.resolve('Apple TV is not configured');
    return this.#request({ t: 'command', device, op });
  }

  pair(device: string, op: 'begin' | 'pin' | 'cancel', pin?: string): Promise<string | null> {
    if (!this.#devices.some((item) => item.id === device)) return Promise.resolve('Apple TV is not configured');
    return this.#request({ t: `pair-${op}`, device, ...(pin ? { pin } : {}) }, 20_000);
  }

  stop(): void {
    this.#stopping = true;
    clearTimeout(this.#restart);
    this.#stopProcess();
  }

  #ensureProcess(): void {
    if (this.#process || this.#stopping) return;
    const script = fileURLToPath(new URL('./apple-tv-bridge.py', import.meta.url));
    const child = spawn(process.env['PYTHON'] || 'python3', [script, this.#storageFile], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#process = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => log.warn(chunk.trim()));
    createInterface({ input: child.stdout }).on('line', (line) => this.#handleLine(line));
    child.on('error', (error) => log.warn('Could not start Apple TV bridge:', error));
    child.on('exit', (code) => {
      if (this.#process !== child) return;
      this.#process = null;
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.resolve('Apple TV bridge stopped');
      }
      this.#pending.clear();
      if (!this.#stopping && this.#devices.length > 0) {
        log.warn(`Apple TV bridge exited (${code ?? 'signal'}); restarting`);
        this.#restart = setTimeout(() => {
          this.#ensureProcess();
          void this.#request({ t: 'configure', devices: this.#devices }, 20_000);
        }, 3000);
      }
    });
  }

  #stopProcess(): void {
    const child = this.#process;
    this.#process = null;
    child?.kill('SIGTERM');
  }

  #handleLine(line: string): void {
    let message: BridgeReply | BridgeState;
    try { message = JSON.parse(line) as BridgeReply | BridgeState; }
    catch { log.warn('Ignored invalid Apple TV bridge response'); return; }
    if (message.t === 'state') {
      this.#states.set(message.state.id, message.state);
      this.#onState(this.snapshot);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    pending.resolve(message.ok ? null : (message.error || 'Apple TV command failed'));
  }

  #request(payload: Record<string, unknown>, timeout = 12_000): Promise<string | null> {
    this.#ensureProcess();
    const child = this.#process;
    if (!child) return Promise.resolve('Apple TV bridge is unavailable');
    const id = ++this.#sequence;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve('Apple TV did not respond');
      }, timeout);
      this.#pending.set(id, { resolve, timer });
      child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
    });
  }
}
