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

export interface SshTarget {
  id: string;
  host: string;
  username: string;
  /** Private key text, when the host is reached by key. */
  privateKey?: string;
  password?: string;
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
  async run(target: SshTarget, command: string): Promise<string | null> {
    if (!target.privateKey && !target.password) {
      return `No SSH credential for ${target.id} — set SSH_KEY_FILE_${target.id.toUpperCase()}`;
    }

    const { host, port } = splitHost(target.host, 22);
    const pinKey = `${host}:${port}`;
    const pinned = (await this.#load())[pinKey];
    let seen: string | undefined;

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

      if (pinned === undefined && seen) {
        await this.#pin(pinKey, seen);
        log.info(`${target.id}: pinned host key ${seen}`);
      }

      const code = await exec(client, command);
      if (code !== 0) {
        log.warn(`${target.id}: \`${command}\` exited ${code}`);
        return `${target.id}: command exited ${code}`;
      }
      log.debug(`${target.id}: ran \`${command}\``);
      return null;
    } catch (err) {
      if (pinned !== undefined && seen !== undefined && seen !== pinned) {
        log.warn(
          `${target.id}: host key changed (${seen}, pinned ${pinned}) — refusing. ` +
            `If the machine was reinstalled, delete "${pinKey}" from ${this.#knownHostsFile}.`,
        );
        return `${target.id}: host key changed`;
      }
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`${target.id}: ${message}`);
      return `${target.id}: ${message}`;
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

function exec(client: Client, command: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the command did not finish')), RUN_TIMEOUT_MS);
    client.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      // Output is not wanted, but a stream nobody reads can stall the
      // channel once its window fills.
      stream.on('data', () => {});
      stream.stderr.on('data', () => {});
      stream.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve(code ?? 0);
      });
    });
  });
}
