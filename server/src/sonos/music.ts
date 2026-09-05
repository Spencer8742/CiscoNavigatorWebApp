import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

import { logger } from '~/lib/log.ts';
import { MusicServiceCatalog, canSearch, type MusicService } from '~/sonos/services.ts';
import {
  SmapiClient,
  SmapiError,
  servicePlayable,
  SEARCH_CATEGORIES,
  type LinkPrompt,
  type ServiceToken,
  type SmapiItem,
} from '~/sonos/smapi.ts';
import type { SonosClient } from '~/sonos/client.ts';

const log = logger('music-services');

/**
 * A service refused because this app is not linked to it.
 *
 * Typed rather than a message, because the panel has to DO something about it
 * — draw a Connect button — and matching on the text of an error to decide
 * that is the kind of thing that quietly stops working when the wording
 * changes. "Connect SoundCloud first" with no way to connect is the bug this
 * class exists to prevent.
 */
export class NeedsLink extends Error {
  readonly sid: number;

  constructor(sid: number, name: string) {
    super(`Connect ${name} to browse it`);
    this.name = 'NeedsLink';
    this.sid = sid;
  }
}

/**
 * The household's music services, linked and ready to browse.
 *
 * This is the layer between `smapi.ts` (which knows the protocol) and
 * `browse.ts` (which knows the panel). It owns three things the other two
 * should not: which services exist, the tokens that let us call them, and the
 * half-finished device links somebody is in the middle of confirming.
 *
 * ## Tokens on disk
 *
 * A link survives a restart, because being asked to re-pair four services
 * every time a container is redeployed would make the feature not worth
 * having. They go next to the config, in the same place as the TV pairing
 * keys, and they are service credentials — the file is written 0600.
 *
 * ## Failure is expected and must stay local
 *
 * A service can be down, a token can expire, a catalog row can be a shape
 * nothing here anticipated. None of that may stop favourites and the local
 * library from working, so every entry point returns empty or throws a
 * message meant for a person, and nothing here can take the rest of the
 * integration with it.
 */

/** How long a device-link prompt stays valid before it is forgotten. */
const LINK_TTL_MS = 10 * 60 * 1000;

/** Re-read the catalog no more often than this. */
const CATALOG_TTL_MS = 60 * 60 * 1000;

interface PendingLink {
  sid: number;
  linkCode: string;
  linkDeviceId: string | null;
  prompt: LinkPrompt;
  startedAt: number;
}

interface StoredTokens {
  /** Keyed by sid, as a string because JSON object keys are strings. */
  [sid: string]: ServiceToken;
}

export class MusicServices {
  readonly #catalog: MusicServiceCatalog;
  readonly #client: SonosClient;
  readonly #path: string;

  #tokens = new Map<number, ServiceToken>();
  #selected = new Set<number>();
  /** Last connection error, retained until retry or success. */
  #lastLinkError = new Map<number, string>();
  #pending = new Map<number, PendingLink>();
  #operations = new Map<number, Promise<unknown>>();
  #saving: Promise<void> = Promise.resolve();
  #deviceId: string;
  #refreshedAt = 0;
  #loading: Promise<void> | null = null;

  /** Told whenever the set of services changes. */
  #onChange: (() => void) | null = null;

  constructor(client: SonosClient, tokenPath: string) {
    this.#client = client;
    this.#catalog = new MusicServiceCatalog(client);
    this.#path = tokenPath;
    this.#deviceId = randomUUID();
  }

  /**
   * Be told when the services change.
   *
   * The catalog loads LAZILY — the first browse of the source list triggers
   * it — so the `hello` frame a panel connected with is written before any
   * service is known. Without this the panel keeps that empty list until it
   * reconnects, and the Search chips stay missing for a household that has
   * five services.
   */
  onChange(fn: () => void): void {
    this.#onChange = fn;
  }

  /* ── Lifecycle ─────────────────────────────────────────────────────────*/

  async start(): Promise<void> {
    await this.#load();
  }

  /**
   * Make sure the catalog is loaded, at most one load at a time.
   *
   * Every browse of a service tab lands here, and a household with seven
   * speakers can have several panels asking at once — so the in-flight promise
   * is shared rather than the work being done again.
   */
  async ready(): Promise<void> {
    const fresh = Date.now() - this.#refreshedAt < CATALOG_TTL_MS;
    if (fresh && this.#catalog.loaded) return;
    if (this.#loading) return this.#loading;

    this.#loading = this.#catalog
      .refresh()
      .then(() => {
        this.#refreshedAt = Date.now();
        this.#onChange?.();
      })
      .catch((err: unknown) => {
        log.warn(`Could not load music services: ${message(err)}`);
      })
      .finally(() => {
        this.#loading = null;
      });

    return this.#loading;
  }

  /**
   * Services worth offering, from the household's list plus our own.
   *
   * The union matters: a service THIS APP has a token for is one somebody
   * connected here on purpose, and it must keep appearing even if the
   * household's own account detection later comes up empty — a firmware that
   * stops serving `/status/accounts`, a favourite that got deleted.
   */
  list(): MusicService[] {
    const out = this.#catalog.list();
    const seen = new Set(out.map((s) => s.sid));

    for (const sid of new Set([...this.#tokens.keys(), ...this.#selected])) {
      if (seen.has(sid)) continue;
      const service = this.#catalog.get(sid);
      if (service) out.push(service);
    }

    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Keep a manually chosen catalog service available to the Connect UI. */
  select(sid: number): void {
    if (!this.#catalog.get(sid) || this.#selected.has(sid)) return;
    this.#selected.add(sid);
    this.#onChange?.();
  }

  /** Sonos's whole catalog, for adding a service detection missed. */
  all(): MusicService[] {
    return this.#catalog.all();
  }

  /** Services that are usable right now — anonymous, or linked to us. */
  available(): MusicService[] {
    return this.list().filter((s) => s.auth === 'Anonymous' || this.#tokens.has(s.sid));
  }

  get(sid: number): MusicService | null {
    return this.#catalog.get(sid);
  }

  /** Tell the catalog about an `sn` seen in a URI a speaker wrote. */
  observe(sid: number, sn: number): void {
    this.#catalog.observe(sid, sn);
  }

  /* ── Browsing ──────────────────────────────────────────────────────────*/

  /**
   * One page of a service container. `'root'` is its top level.
   *
   * Throws a message meant to be read on the panel — "connect Plex first" is
   * something somebody can act on, where a SOAP fault is not.
   */
  async browse(sid: number, id: string, offset: number): Promise<SmapiItem[]> {
    const client = this.#clientFor(sid);
    try {
      const page = await client.getMetadata(id, offset);
      return page.items;
    } catch (err) {
      throw this.#explain(err, sid);
    }
  }

  /**
   * Search one service, across whatever categories it accepts.
   *
   * All four go at once and the ones that fail are dropped. A service is
   * entitled to offer none of them, and a category it does not know answers
   * with a fault rather than an empty list — which is not a failed search.
   */
  async search(
    sid: number,
    term: string,
  ): Promise<{ name: string; items: SmapiItem[] }[]> {
    const service = this.#catalog.get(sid);
    const client = this.#clientFor(sid);

    if (service && !canSearch(service)) {
      throw new Error(`${service.name} cannot be searched`);
    }

    let refused: unknown = null;
    let answered = 0;

    const groups = await Promise.all(
      SEARCH_CATEGORIES.map(async (category) => {
        try {
          const page = await client.search(category.id, term);
          answered++;
          return { name: category.name, items: page.items };
        } catch (err) {
          // Kept so that "every category failed" can be reported as the auth
          // problem it usually is, rather than as an empty result.
          refused = err;
          return { name: category.name, items: [] };
        }
      }),
    );

    const hits = groups.filter((g) => g.items.length > 0);
    if (answered === 0 && refused !== null) throw this.#explain(refused, sid);
    return hits;
  }

  /** A catalog row → what a speaker needs to play it. */
  playable(sid: number, item: SmapiItem): ReturnType<typeof servicePlayable> {
    const service = this.#catalog.get(sid);
    if (!service) return null;
    return servicePlayable(item, service);
  }

  /* ── Linking ───────────────────────────────────────────────────────────*/

  /**
   * Start linking a service, or report the link already in progress.
   *
   * Idempotent within the TTL: tapping "connect" twice must not invalidate the
   * code somebody is already halfway through typing.
   */
  beginLink(sid: number): Promise<LinkPrompt> {
    return this.#serial(sid, () => this.#beginLink(sid));
  }

  async #beginLink(sid: number): Promise<LinkPrompt> {
    await this.ready();
    const existing = this.#pending.get(sid);
    if (existing && Date.now() - existing.startedAt < LINK_TTL_MS) return existing.prompt;

    const service = this.#catalog.get(sid);
    if (!service) throw new Error('That service is not available here');
    if (service.auth === 'Anonymous') throw new Error(`${service.name} needs no connecting`);
    if (service.auth === 'UserId') {
      throw new Error(`${service.name} needs a username and password, which cannot be entered here`);
    }

    try {
      // An old account token must not authorize a new linking attempt.
      const client = this.#clientFor(sid);
      client.setToken(null);
      const { prompt, linkCode, linkDeviceId } = await client.beginLink();
      this.#pending.set(sid, { sid, linkCode, linkDeviceId, prompt, startedAt: Date.now() });
      // A link that started is the current truth about this service; whatever
      // it said last time no longer describes it.
      this.#clearLinkError(sid);
      log.info(`Linking ${service.name}`);
      return prompt;
    } catch (err) {
      /*
       * NOT `#explain`. That answers "this needs connecting", which is
       * circular here — connecting is precisely what just failed — and it
       * threw away the only thing worth having: what the service said.
       *
       * A person reading "Connect SoundCloud to browse it" on the Connect
       * sheet learns nothing and has nowhere to go. The service's own fault
       * is ugly and it is the difference between a dead end and a lead.
       */
      throw this.#linkFailure(err, sid, service.name);
    }
  }

  /**
   * A link that would not start, said in a way that can be acted on.
   *
   * The fault string is passed through rather than summarised. It is the only
   * account of what actually happened, it is the thing worth putting in a bug
   * report, and no paraphrase of it can be more useful than it is.
   */
  #linkFailure(err: unknown, sid: number, name: string): Error {
    const fault = err instanceof SmapiError && err.fault.trim().length > 0 ? err.fault.trim() : '';
    log.warn(`${name} refused to start a link: ${message(err)}${fault ? ` — ${fault}` : ''}`);

    // A refusal is evidence about this request, not proof of a permanent ban.
    // Keep retry available, including after a malformed or expired link.
    const explained = /NOT_AUTHORIZED|Unauthorized|FORBIDDEN/i.test(fault)
      ? `${name} rejected this connection. Try again, or play its saved favourites from the Sonos app. (${fault})`
      : fault
        ? `${name} would not connect: ${fault}`
        : `${name} could not connect: ${message(err)}`;
    this.#lastLinkError.set(sid, explained);
    this.#onChange?.();
    return new Error(explained);
  }

  /**
   * Has the person confirmed the link yet?
   *
   * Returns false while the service says "not yet", which is its normal answer
   * for most of the flow rather than a failure. Anything else throws.
   */
  pollLink(sid: number): Promise<boolean> {
    return this.#serial(sid, () => this.#pollLink(sid));
  }

  async #pollLink(sid: number): Promise<boolean> {
    const pending = this.#pending.get(sid);
    if (!pending) {
      if (this.linked(sid)) return true;
      throw new Error('That link is no longer in progress — start again');
    }
    if (Date.now() - pending.startedAt > LINK_TTL_MS) {
      this.#pending.delete(sid);
      throw new Error('That link expired — start again');
    }

    try {
      const client = this.#clientFor(sid);
      client.setToken(null);
      const token = await client.finishLink(pending.linkCode, pending.linkDeviceId);
      token.sn = this.#catalog.get(sid)?.sn ?? null;

      const previous = this.#tokens.get(sid);
      this.#tokens.set(sid, token);
      try {
        await this.#save();
      } catch (err) {
        if (previous) this.#tokens.set(sid, previous);
        else this.#tokens.delete(sid);
        throw err;
      }
      this.#pending.delete(sid);
      this.#clearLinkError(sid);
      this.#onChange?.();

      log.info(`Connected ${this.#catalog.get(sid)?.name ?? sid}`);
      return true;
    } catch (err) {
      if (err instanceof SmapiError && err.pending) return false;
      this.#pending.delete(sid);
      // Same reasoning as `beginLink`: mid-link, "please link" says nothing.
      throw this.#linkFailure(err, sid, this.#catalog.get(sid)?.name ?? 'That service');
    }
  }

  /** Forget the token, pending link, and last connection error. */
  unlink(sid: number): Promise<void> {
    return this.#serial(sid, () => this.#unlink(sid));
  }

  async #unlink(sid: number): Promise<void> {
    this.#tokens.delete(sid);
    this.#pending.delete(sid);
    this.#lastLinkError.delete(sid);
    await this.#save();
    this.#onChange?.();
    log.info(`Disconnected ${this.#catalog.get(sid)?.name ?? sid}`);
  }

  linked(sid: number): boolean {
    return this.#tokens.has(sid);
  }

  lastLinkError(sid: number): string | null {
    return this.#lastLinkError.get(sid) ?? null;
  }

  #clearLinkError(sid: number): void {
    if (this.#lastLinkError.delete(sid)) this.#onChange?.();
  }

  /* ── Plumbing ──────────────────────────────────────────────────────────*/

  #clientFor(sid: number): SmapiClient {
    const service = this.#catalog.get(sid);
    if (!service) throw new Error('That service is not available here');

    const household = this.#catalog.householdId;
    if (!household) throw new Error('Sonos has not reported a household id yet');

    /*
     * The household's own serial when the speakers gave one, and a stable
     * generated id only as a fallback. `deviceId` means "which device is
     * asking"; a UUID we invented is a placeholder standing where a real
     * answer exists, and the reference implementation uses the serial.
     */
    const deviceId = this.#catalog.deviceSerial ?? this.#deviceId;

    let original = this.#tokens.get(sid) ?? null;
    return new SmapiClient(service, household, deviceId, original, async (token) => {
      // A refresh finishing after an explicit disconnect must not restore it.
      if (this.#tokens.get(sid) !== original) return;
      const previous = original;
      this.#tokens.set(sid, token);
      try {
        await this.#save();
        original = token;
      } catch (err) {
        if (previous) this.#tokens.set(sid, previous);
        else this.#tokens.delete(sid);
        throw err;
      }
    });
  }

  /**
   * Turn a SMAPI failure into something worth showing a person.
   *
   * An expired token is dropped here rather than reported as a mystery: the
   * next thing the panel does is offer to connect again, and leaving a dead
   * token in place would make that offer fail too.
   */
  #explain(err: unknown, sid: number): Error {
    const service = this.#catalog.get(sid);
    const name = service?.name ?? 'That service';

    if (err instanceof SmapiError && err.expired) {
      /*
       * A refused credential and a missing one are the same fault, and both
       * mean the same thing to whoever is standing at the panel: this needs
       * connecting. Dropping a dead token here is what stops the next attempt
       * failing the same way.
       *
       * It also catches a service whose catalog entry claims `Anonymous` and
       * which then demands a login anyway — SoundCloud does exactly this, and
       * believing the catalog left the panel with an error and no button.
       */
      if (this.#tokens.has(sid)) void this.#dropToken(sid).catch((error: unknown) => log.warn(message(error)));
      return new NeedsLink(sid, name);
    }

    if (err instanceof SmapiError && !this.#clientFor(sid).ready) {
      return new NeedsLink(sid, name);
    }

    log.warn(`${name}: ${message(err)}`);
    return new Error(`${name} could not answer that`);
  }

  async #dropToken(sid: number): Promise<void> {
    this.#tokens.delete(sid);
    this.#onChange?.();
    await this.#save();
  }

  /* ── Persistence ───────────────────────────────────────────────────────*/

  async #load(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.#path, 'utf8'));
      if (typeof raw !== 'object' || raw === null) return;

      const stored = raw as { deviceId?: unknown; tokens?: unknown };

      /*
       * The device id is part of the identity a token was issued to. A new one
       * would not be an inconvenience, it would invalidate every link — so it
       * is stored with them and only minted when there is nothing to keep.
       */
      if (typeof stored.deviceId === 'string' && stored.deviceId.length > 0) {
        this.#deviceId = stored.deviceId;
      }

      const tokens = stored.tokens;
      if (typeof tokens !== 'object' || tokens === null) return;

      for (const [key, value] of Object.entries(tokens as StoredTokens)) {
        const sid = Number.parseInt(key, 10);
        if (!Number.isFinite(sid) || typeof value?.token !== 'string') continue;
        this.#tokens.set(sid, {
          token: value.token,
          key: typeof value.key === 'string' ? value.key : '',
          sn: typeof value.sn === 'number' ? value.sn : null,
        });
      }

      if (this.#tokens.size > 0) {
        log.info(`Restored ${this.#tokens.size} music service connection(s)`);
      }
    } catch (err) {
      // No file is the normal first-run state.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`Could not read stored service connections: ${message(err)}`);
      }
    }
  }

  #serial<T>(sid: number, action: () => Promise<T>): Promise<T> {
    const previous = this.#operations.get(sid) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(action);
    this.#operations.set(sid, operation);
    void operation.finally(() => {
      if (this.#operations.get(sid) === operation) this.#operations.delete(sid);
    }).catch(() => {});
    return operation;
  }

  #save(): Promise<void> {
    const operation = this.#saving.catch(() => {}).then(() => this.#writeTokens());
    this.#saving = operation;
    return operation;
  }

  async #writeTokens(): Promise<void> {
    const tokens: StoredTokens = {};
    for (const [sid, token] of this.#tokens) tokens[String(sid)] = token;

    const body = `${JSON.stringify({ deviceId: this.#deviceId, tokens }, null, 2)}\n`;

    try {
      await mkdir(dirname(this.#path), { recursive: true });
      // Written then renamed, so a crash mid-write cannot leave a truncated
      // file where working credentials were. 0600: these are credentials.
      const tmp = `${this.#path}.${process.pid}.tmp`;
      await writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.#path);
    } catch (err) {
      log.warn(`Could not store service connections: ${message(err)}`);
      throw new Error('The connection could not be saved. Check that the server can write to its configuration folder, then try again.');
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
