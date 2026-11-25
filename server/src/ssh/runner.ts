import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Client } from 'ssh2';
import { logger } from '~/lib/log.ts';
import { splitHost } from '~/cast/keeper.ts';

const log = logger('ssh');

/** Connecting and authenticating on a LAN is quick, or it is not happening. */
const CONNECT_TIMEOUT_MS = 8000;
/** The commands are one-liners like `caffeinate -u -t 1`. */
const RUN_TIMEOUT_MS = 15_000;
/** Between connection attempts while waiting for a host to wake. */
const RETRY_MS = 2000;

export interface SshTarget {
  id: string;
  host: string;
  username: string;
  /** Private key text, when the host is reached by key. */
  privateKey?: string;
  password?: string;
}

export interface SshOptions {
  /**
   * Keep trying to CONNECT for this long while the host does not answer.
   *
   * For a key step on a machine the same key has just woken: "Office Power"
   * presses the Mac's Wake-on-LAN and, in the same instant, SSHes in to
   * light its display. Every step starts at once, so the Mac is still
   * asleep when the connection is tried, and one attempt is a step that
   * always fails. Only "nobody answered" is retried — a refused login or a
   * changed host key is not a machine that is still waking up.
   *
   * 0, the default: one attempt.
   */
  waitForHostMs?: number;
  /**
   * The caller reports failures itself — a background read that logs a
   * change of state once — so this logs them at debug rather than warn. A
   * Mac asleep all night is otherwise a warning every poll until morning.
   */
  quiet?: boolean;
  /** Once connected, how long the command may take. Default RUN_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** What `capture` hands back: a reason it failed, or null, and every line printed. */
export interface SshCapture {
  problem: string | null;
  lines: string[];
}

/**
 * Runs one fixed command on one host, over SSH, and hangs up.
 *
 * A connection per press rather than one held open: these keys are pressed a
 * couple of times a day, a Mac asleep drops idle connections anyway, and a
 * fresh connection cannot be a stale one.
 *
 * **The host key is pinned on first use.** The first successful connection
 * records the host's key fingerprint in `knownHostsFile`; every later one
 * must present the same key or is refused before any credential is sent.
 * That is the same trust `ssh` itself gives an unknown host, without a
 * prompt nobody is there to answer. A Mac reinstalled with a new key is
 * fixed by deleting its line from that file.
 */
export class SshRunner {
  readonly #knownHostsFile: string;

  constructor(knownHostsFile: string) {
    this.#knownHostsFile = knownHostsFile;
  }

  /** Resolves to an error for the panel, or null when the command exited 0. */
  run(target: SshTarget, command: string, opts: SshOptions = {}): Promise<string | null> {
    const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
    return this.#session(target, command, opts, (client) => exec(client, command, timeoutMs, () => {}));
  }

  /**
   * Run a command and collect what it prints, stdout and stderr both, line
   * by line. For a command whose output is the answer — a DDC monitor's
   * reads — or whose error text says more than its exit code.
   */
  async capture(target: SshTarget, command: string, opts: SshOptions = {}): Promise<SshCapture> {
    const lines: string[] = [];
    const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
    const problem = await this.#session(target, command, opts, (client) =>
      exec(client, command, timeoutMs, (line) => lines.push(line)),
    );
    return { problem, lines };
  }

  /**
   * Run a long-lived command and hand back each line it prints.
   *
   * For a loop on the far side that reports as it goes — one connection for
   * as long as it runs, rather than one per question. No timeout: it ends
   * when the command does, or when `signal` aborts.
   */
  stream(
    target: SshTarget,
    command: string,
    onLine: (line: string) => void,
    signal: AbortSignal,
    opts: SshOptions = {},
  ): Promise<string | null> {
    return this.#session(target, command, opts, (client) => execLines(client, command, onLine, signal));
  }

  async #session(
    target: SshTarget,
    command: string,
    opts: SshOptions,
    body: (client: Client) => Promise<number>,
  ): Promise<string | null> {
    const warn = (message: string): void => {
      if (opts.quiet) log.debug(message);
      else log.warn(message);
    };

    if (!target.privateKey && !target.password) {
      return `No SSH credential for ${target.id} — set SSH_KEY_FILE_${target.id.toUpperCase()}`;
    }

    const deadline = Date.now() + Math.max(0, opts.waitForHostMs ?? 0);
    let waited = false;
    for (;;) {
      const outcome = await this.#attempt(target, command, body);
      if (outcome.kind === 'done') {
        if (waited) log.info(`${target.id}: answered after waiting for it to wake`);
        return null;
      }
      if (outcome.kind === 'unreachable' && Date.now() + RETRY_MS < deadline) {
        if (!waited) log.info(`${target.id}: not answering yet (${outcome.message}) — waiting for it to wake`);
        waited = true;
        await delay(RETRY_MS);
        continue;
      }
      warn(outcome.log);
      return `${target.id}: ${outcome.message}`;
    }
  }

  /** One connection: connect, check the host key, run `body`, hang up. */
  async #attempt(
    target: SshTarget,
    command: string,
    body: (client: Client) => Promise<number>,
  ): Promise<
    | { kind: 'done' }
    | { kind: 'unreachable'; message: string; log: string }
    | { kind: 'failed'; message: string; log: string }
  > {
    const { host, port } = splitHost(target.host, 22);
    const pinKey = `${host}:${port}`;
    const pinned = (await this.#load())[pinKey];
    let seen: string | undefined;
    let connected = false;

    const client = new Client();
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', () => resolve());
        client.once('error', reject);
        client.connect({
          host,
          port,
          username: target.username,
          ...(target.privateKey ? { privateKey: target.privateKey } : {}),
          ...(target.password ? { password: target.password } : {}),
          readyTimeout: CONNECT_TIMEOUT_MS,
          hostVerifier: (key: Buffer) => {
            seen = fingerprint(key);
            return pinned === undefined || pinned === seen;
          },
        });
      });
      connected = true;

      if (pinned === undefined && seen) {
        await this.#pin(pinKey, seen);
        log.info(`${target.id}: pinned host key ${seen}`);
      }

      const code = await body(client);
      if (code !== 0) {
        return {
          kind: 'failed',
          message: `command exited ${code}`,
          log: `${target.id}: \`${command}\` exited ${code}`,
        };
      }
      log.debug(`${target.id}: ran \`${command}\``);
      return { kind: 'done' };
    } catch (err) {
      if (pinned !== undefined && seen !== undefined && seen !== pinned) {
        return {
          kind: 'failed',
          message: 'host key changed',
          log:
            `${target.id}: host key changed (${seen}, pinned ${pinned}) — refusing. ` +
            `If the machine was reinstalled, delete "${pinKey}" from ${this.#knownHostsFile}.`,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      // Nobody answered: no route, refused, or no handshake in time. Those are
      // a machine that is asleep or still waking. A rejected login, or any
      // failure once connected, is not, and waiting would not change it.
      const level = (err as { level?: unknown }).level;
      const unanswered = !connected && (level === 'client-socket' || level === 'client-timeout');
      return { kind: unanswered ? 'unreachable' : 'failed', message, log: `${target.id}: ${message}` };
    } finally {
      client.end();
    }
  }

  async #load(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.#knownHostsFile, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async #pin(hostKey: string, fp: string): Promise<void> {
    const all = await this.#load();
    all[hostKey] = fp;
    try {
      await mkdir(dirname(this.#knownHostsFile), { recursive: true });
      await writeFile(this.#knownHostsFile, JSON.stringify(all, null, 2));
    } catch (err) {
      // Not fatal: the command still runs. The cost is that the next
      // connection pins again rather than checking — so say so.
      log.warn(`Could not write ${this.#knownHostsFile}:`, err);
    }
  }
}

function fingerprint(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execLines(client: Client, command: string, onLine: (line: string) => void, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve(0);
      return;
    }
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      let pending = '';
      const stop = (): void => {
        stream.close();
      };
      signal.addEventListener('abort', stop, { once: true });
      stream.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (line) onLine(line);
          newline = pending.indexOf('\n');
        }
        // A line that never ends is not a report; do not let it grow forever.
        if (pending.length > 64 * 1024) pending = '';
      });
      stream.stderr.on('data', () => {});
      stream.on('close', (code: number | null) => {
        signal.removeEventListener('abort', stop);
        resolve(signal.aborted ? 0 : code ?? 0);
      });
    });
  });
}

/**
 * Run a command to completion, with a time limit that starts once connected.
 * Every line it prints, stdout or stderr, goes to `onLine`; a stream nobody
 * reads can stall the channel once its window fills, so both are drained
 * either way.
 */
function exec(client: Client, command: string, timeoutMs: number, onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the command did not finish')), timeoutMs);
    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      // One per stream, so stdout and stderr never splice into one line.
      const reader = (): { data: (chunk: Buffer) => void; flush: () => void } => {
        let pending = '';
        return {
          data: (chunk) => {
            pending += chunk.toString('utf8');
            let newline = pending.indexOf('\n');
            while (newline >= 0) {
              const line = pending.slice(0, newline).trim();
              pending = pending.slice(newline + 1);
              if (line) onLine(line);
              newline = pending.indexOf('\n');
            }
            if (pending.length > 64 * 1024) pending = '';
          },
          // A last line printed without a newline is still a line.
          flush: () => {
            const line = pending.trim();
            pending = '';
            if (line) onLine(line);
          },
        };
      };
      const out = reader();
      const errors = reader();
      stream.on('data', out.data);
      stream.stderr.on('data', errors.data);
      stream.on('close', (code: number | null) => {
        clearTimeout(timer);
        out.flush();
        errors.flush();
        resolve(code ?? 0);
      });
    });
  });
}
