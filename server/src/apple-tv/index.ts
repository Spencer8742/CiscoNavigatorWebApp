import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { ServerResponse } from 'node:http';
import { logger } from '~/lib/log.ts';
import type { AppleTvConfig } from '@shared/config.ts';
import type { AppleTvCommand, AppleTvState, AppleTvSwipe } from '@shared/protocol.ts';

const log = logger('apple-tv');

interface BridgeReply { t: 'response'; id: number; ok: boolean; error?: string }
interface BridgeState { t: 'state'; state: AppleTvState }
interface BridgeArtwork { t: 'artwork'; device: string; version: string | null; mimetype: string | null; data: string | null }
interface CachedArtwork { version: string; mimetype: string; bytes: Buffer }

export function swipeBridgeRequest(device: string, gesture: AppleTvSwipe): Record<string, unknown> {
  return {
    t: 'swipe',
    device,
    startX: gesture.startX,
    startY: gesture.startY,
    endX: gesture.endX,
    endY: gesture.endY,
    durationMs: gesture.durationMs,
  };
}

export class AppleTvBridge {
  readonly #storageFile: string;
  readonly #onState: (states: AppleTvState[]) => void;
  #process: ChildProcessWithoutNullStreams | null = null;
  #devices: AppleTvConfig[] = [];
  #states = new Map<string, AppleTvState>();
  #artworks = new Map<string, CachedArtwork>();
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
      pairingTarget: null, power: 'unknown', playback: 'idle', mediaType: 'unknown', title: null, artist: null,
      album: null, app: null, artwork: null, elapsed: null, duration: null, elapsedAt: null,
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

  swipe(device: string, gesture: AppleTvSwipe): Promise<string | null> {
    if (!this.#devices.some((item) => item.id === device)) return Promise.resolve('Apple TV is not configured');
    const coordinates = [gesture.startX, gesture.startY, gesture.endX, gesture.endY];
    if (!coordinates.every((value) => Number.isInteger(value) && value >= 0 && value <= 1000)) {
      return Promise.resolve('Apple TV swipe coordinates are invalid');
    }
    if (!Number.isInteger(gesture.durationMs) || gesture.durationMs < 100 || gesture.durationMs > 2000) {
      return Promise.resolve('Apple TV swipe duration is invalid');
    }
    return this.#request(swipeBridgeRequest(device, gesture));
  }

  launchApp(device: string, bundleId: string): Promise<string | null> {
    const configured = this.#devices.find((item) => item.id === device);
    const shortcut = configured?.shortcuts.find((item) => item.bundleId === bundleId);
    if (!shortcut) return Promise.resolve('That Apple TV app is not configured as a shortcut');
    return this.#request({
      t: 'launch-app',
      device,
      app: shortcut.bundleId,
      name: shortcut.name,
    });
  }

  pair(device: string, op: 'begin' | 'pin' | 'cancel', pin?: string): Promise<string | null> {
    if (!this.#devices.some((item) => item.id === device)) return Promise.resolve('Apple TV is not configured');
    return this.#request({ t: `pair-${op}`, device, ...(pin ? { pin } : {}) }, 20_000);
  }

  serveArtwork(res: ServerResponse, device: string | null): void {
    const artwork = device ? this.#artworks.get(device) : undefined;
    if (!artwork || !this.#devices.some((item) => item.id === device)) {
      res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end('Artwork unavailable');
      return;
    }
    res.writeHead(200, {
      'content-type': artwork.mimetype,
      'content-length': String(artwork.bytes.length),
      'cache-control': 'private, max-age=86400, immutable',
      'x-content-type-options': 'nosniff',
    });
    res.end(artwork.bytes);
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
    let message: BridgeReply | BridgeState | BridgeArtwork;
    try { message = JSON.parse(line) as BridgeReply | BridgeState | BridgeArtwork; }
    catch { log.warn('Ignored invalid Apple TV bridge response'); return; }
    if (message.t === 'artwork') {
      if (!message.data || !message.version || !message.mimetype || !/^image\/(jpeg|png|webp)$/.test(message.mimetype)) {
        this.#artworks.delete(message.device);
      } else {
        const bytes = Buffer.from(message.data, 'base64');
        if (bytes.length <= 4 * 1024 * 1024) {
          this.#artworks.set(message.device, { version: message.version, mimetype: message.mimetype, bytes });
        }
      }
      const state = this.#states.get(message.device);
      if (state) {
        this.#states.set(message.device, { ...state, artwork: this.#artworkPath(message.device) });
        this.#onState(this.snapshot);
      }
      return;
    }
    if (message.t === 'state') {
      this.#states.set(message.state.id, {
        ...message.state,
        artwork: this.#artworkPath(message.state.id),
      });
      this.#onState(this.snapshot);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    pending.resolve(message.ok ? null : (message.error || 'Apple TV command failed'));
  }

  #artworkPath(device: string): string | null {
    const artwork = this.#artworks.get(device);
    return artwork
      ? `/api/apple-tv-artwork?id=${encodeURIComponent(device)}&v=${encodeURIComponent(artwork.version)}`
      : null;
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
