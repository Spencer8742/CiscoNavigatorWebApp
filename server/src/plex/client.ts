import { createHash } from 'node:crypto';
import { logger } from '~/lib/log.ts';
import type { MediaArt } from '~/http/media-art.ts';
import type { AppleTvConfig, SshHostConfig } from '@shared/config.ts';
import type { IinaListener, IinaStatus } from '~/iina/index.ts';
import type { AppleTvState, PlexItem, PlexKind, PlexRequest, PlexResult, PlexTarget } from '@shared/protocol.ts';
import { PLEX_PAGE } from '@shared/protocol.ts';

const log = logger('plex');

/**
 * Plex, for the Apple TV screen: browse a Plex Media Server, then send what
 * was picked to a player.
 *
 * ## Browsing
 *
 * Plain PMS REST with `Accept: application/json`. Nothing is cached: like the
 * Sonos browser, the panel never disagrees with Plex about what exists.
 * Artwork goes through `MediaArt`, so the panel gets an opaque key and never
 * sees the server's address or its token.
 *
 * ## Playing
 *
 * Plex does not stream TO a player. It tells a player to go and fetch
 * something: create a play queue on the server, then send the player
 * `/player/playback/playMedia` naming the server, the queue and a token. That
 * is the "Plex Companion" remote-control protocol every Plex app uses to cast
 * to another, and it is why playback lands in the real Plex app — with
 * resume, subtitles and watched state — rather than in an AirPlay window.
 *
 * The catch on an Apple TV is that tvOS apps do not run in the background, so
 * the Plex app is only a player while it is open. Sending to an Apple TV
 * therefore opens Plex on it first (over the existing pyatv bridge) and waits
 * for the app to show up as a player before sending the command.
 *
 * Players are found three ways, because each one misses cases:
 *  - asking the player port on the Apple TV's own address directly
 *  - the server's `/clients` list, which is what the server heard over GDM
 *  - plex.tv's resource list, which is how current Plex apps announce
 *    themselves, and the only one that sees a player on another VLAN
 *
 * ## Playing on a Mac, in IINA
 *
 * Remote control is something each Plex app chooses to offer, and Plex has
 * been withdrawing it. A Mac in `controls.ssh` marked `iina: true` does not
 * depend on that: the backend logs in over SSH and opens the file itself, as
 * an `iina://` link handed to `open`. IINA plays the original file straight
 * from the server — no transcoding, any container mpv reads.
 *
 * The command is built here from nothing but the item's part key, which must
 * look like one, and a title that is percent-encoded; the panel only ever
 * names an item and a Mac. The link carries a transient token from the
 * server rather than PLEX_TOKEN, so what lands in IINA's history expires.
 *
 * IINA does not tell Plex how far it got, so the backend does. After opening
 * the file it follows IINA's mpv socket (see `~/iina`) and reports the
 * position to the server's `/:/timeline` as any Plex player would — so resume
 * points move and the item shows under Now Playing — and scrobbles it as
 * watched once 90% has been seen, Plex's own threshold. That needs IINA's
 * `input-ipc-server` set; without it playback still works and Plex simply is
 * not told.
 *
 * ## Music
 *
 * Not offered. The page is for watching; music lives on the Sonos screens.
 */

const TIMEOUT_MS = 8_000;
const PROBE_TIMEOUT_MS = 2_500;
/** How long an Apple TV gets to open Plex and announce itself as a player. */
const APPLE_TV_READY_MS = 25_000;
const POLL_MS = 1_500;
/** A Plex part key: the original file, as the server serves it. */
const PART_RE = /^\/library\/parts\/\d{1,12}(\/\d{1,12})?\/file(\.[A-Za-z0-9]{1,8})?$/;
/** What IINA is handed: one file at a time. */
const MAC_PLAYABLE = new Set<PlexKind>(['movie', 'episode', 'clip', 'track']);
/** How often a position is reported while it plays. Pauses report at once. */
const REPORT_MS = 15_000;
/** Plex's own default for "watched". */
const WATCHED_AT = 0.9;
/** The Plex Companion port every Plex player listens on. */
const PLAYER_PORT = 32500;
const PLEX_TV = 'https://plex.tv';
const PLEX_BUNDLE = 'com.plexapp.plex';

/** ratingKeys and section keys are integers; nothing else is ever sent upstream. */
const ID_RE = /^\d{1,12}$/;
const MACHINE_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

const LIBRARY_TYPES = new Set(['movie', 'show']);
const PLAYABLE = new Set<PlexKind>(['movie', 'episode', 'clip', 'track', 'season', 'album']);
const BROWSABLE = new Set<PlexKind>(['library', 'show', 'season', 'artist', 'album', 'folder']);
const AUDIO = new Set<PlexKind>(['artist', 'album', 'track']);

export interface PlexEnv {
  url: string;
  token: string;
  enabled: boolean;
}

export interface PlexDeps {
  art: MediaArt;
  /** The configured Apple TVs, current as of now. */
  appleTvs: () => AppleTvConfig[];
  /** Their live state, for power. */
  appleTvStates: () => AppleTvState[];
  /** Ask the bridge to do something to an Apple TV. Null on success. */
  appleTvCommand: (device: string, op: 'power_on') => Promise<string | null>;
  openApp: (device: string, bundleId: string) => Promise<string | null>;
  /** Hosts in `controls.ssh`, current as of now. Those marked `iina` are Plex targets. */
  sshHosts?: () => SshHostConfig[];
  /** Run a command on one of them. Null on success. */
  runSsh?: (host: string, command: string) => Promise<string | null>;
  /** Follow IINA on a Mac after something is opened there, for watch state. */
  iinaWatch?: (host: string, listener: IinaListener) => void;
  /** Overridable for tests: where plex.tv lives. */
  plexTv?: string;
  /** Overridable for tests: the Companion port players listen on. */
  playerPort?: number;
  /** Overridable for tests: how long to wait for an Apple TV. */
  readyMs?: number;
}

/** A player as found, before it becomes a `PlexTarget`. */
interface Player {
  id: string;
  name: string;
  product: string;
  host: string;
  port: number;
  scheme: 'http' | 'https';
}

/** Plex's metadata, only the fields used here. */
interface PlexMetadata {
  ratingKey?: string;
  key?: string;
  type?: string;
  title?: string;
  parentTitle?: string;
  grandparentTitle?: string;
  parentIndex?: number;
  index?: number;
  year?: number;
  thumb?: string;
  parentThumb?: string;
  grandparentThumb?: string;
  duration?: number;
  viewOffset?: number;
  viewCount?: number;
  leafCount?: number;
  childCount?: number;
  playQueueItemID?: number;
  Media?: { Part?: { key?: string }[] }[];
}

interface PlexDirectory {
  key?: string;
  title?: string;
  type?: string;
  thumb?: string;
  composite?: string;
}

interface MediaContainer {
  size?: number;
  totalSize?: number;
  offset?: number;
  friendlyName?: string;
  machineIdentifier?: string;
  playQueueID?: number;
  playQueueSelectedItemID?: number;
  /** From `/security/token`. */
  token?: string;
  Metadata?: PlexMetadata[];
  Directory?: PlexDirectory[];
  Server?: {
    name?: string;
    host?: string;
    address?: string;
    port?: number | string;
    machineIdentifier?: string;
    product?: string;
    protocol?: string;
  }[];
}

interface PlexTvResource {
  name?: string;
  product?: string;
  clientIdentifier?: string;
  provides?: string;
  presence?: boolean;
  connections?: { protocol?: string; address?: string; port?: number; local?: boolean }[];
}

export class PlexClient {
  readonly #env: PlexEnv;
  readonly #deps: PlexDeps;
  /** Stable per install, so players see one controller rather than a new one per restart. */
  readonly #clientId: string;
  #machineId: string | null = null;
  #serverName = 'Plex';
  #commandId = 0;

  constructor(env: PlexEnv, deps: PlexDeps) {
    this.#env = env;
    this.#deps = deps;
    this.#clientId = `navigator-panel-${createHash('sha256').update(env.url).digest('hex').slice(0, 16)}`;
  }

  get enabled(): boolean {
    return this.#env.enabled;
  }

  /** Answer a panel request, or throw with a sentence meant for the panel. */
  async handle(req: PlexRequest): Promise<PlexResult> {
    if (!this.#env.enabled) throw new Error('Plex is not configured. Set PLEX_URL and PLEX_TOKEN.');
    switch (req?.kind) {
      case 'home':
        return this.#home();
      case 'open': {
        if (typeof req.id !== 'string' || !ID_RE.test(req.id)) throw new Error('Not a Plex item');
        const offset = Number.isInteger(req.offset) && (req.offset ?? 0) > 0 ? (req.offset as number) : 0;
        return this.#open(req.id, req.library === true, offset);
      }
      case 'targets':
        return { kind: 'targets', targets: await this.targets() };
      case 'play': {
        if (typeof req.id !== 'string' || !ID_RE.test(req.id)) throw new Error('Not a Plex item');
        if (typeof req.target !== 'string') throw new Error('Choose where to play it');
        await this.play(req.id, req.target, req.resume !== false);
        return { kind: 'played', target: req.target };
      }
      default:
        throw new Error('Unknown Plex request');
    }
  }

  /* ── Browsing ────────────────────────────────────────────────────────── */

  async #home(): Promise<PlexResult> {
    const [identity, sections, onDeck, recent] = await Promise.allSettled([
      this.#identity(),
      this.#get('/library/sections'),
      this.#get('/library/onDeck', { 'X-Plex-Container-Start': '0', 'X-Plex-Container-Size': '20' }),
      this.#get('/library/recentlyAdded', { 'X-Plex-Container-Start': '0', 'X-Plex-Container-Size': '20' }),
    ]);
    // The libraries are the page. Without them there is nothing to show, and
    // the reason is almost always the server or the token, so say which.
    if (sections.status === 'rejected') throw sections.reason;
    if (identity.status === 'rejected') log.debug('Plex identity failed:', identity.reason);

    const out: { title: string; items: PlexItem[] }[] = [];
    const video = (item: PlexItem): boolean => !AUDIO.has(item.kind);
    const deck = onDeck.status === 'fulfilled' ? this.#items(onDeck.value.Metadata).filter(video) : [];
    if (deck.length) out.push({ title: 'Continue Watching', items: deck });
    const added = recent.status === 'fulfilled' ? this.#items(recent.value.Metadata).filter(video) : [];
    if (added.length) out.push({ title: 'Recently Added', items: added });
    const libraries = (sections.value.Directory ?? [])
      .filter((dir) => typeof dir.key === 'string' && ID_RE.test(dir.key) && LIBRARY_TYPES.has(dir.type ?? ''))
      .map((dir) => this.#library(dir));
    out.push({ title: 'Libraries', items: libraries });
    return { kind: 'home', server: this.#serverName, sections: out };
  }

  async #open(id: string, library: boolean, offset: number): Promise<PlexResult> {
    const path = library ? `/library/sections/${id}/all` : `/library/metadata/${id}/children`;
    const body = await this.#get(path, {
      'X-Plex-Container-Start': String(offset),
      'X-Plex-Container-Size': String(PLEX_PAGE),
    });
    const items = this.#items(body.Metadata ?? (body.Directory as PlexMetadata[] | undefined));
    const total = typeof body.totalSize === 'number' ? body.totalSize : offset + items.length;
    return { kind: 'list', items, offset, more: offset + items.length < total && items.length > 0 };
  }

  #library(dir: PlexDirectory): PlexItem {
    const label = dir.type === 'movie' ? 'Movies' : 'TV Shows';
    return {
      id: dir.key as string,
      kind: 'library',
      title: dir.title ?? label,
      subtitle: label,
      art: this.#art(dir.composite ?? dir.thumb),
      browsable: true,
      playable: false,
      duration: null,
      resume: null,
    };
  }

  #items(list: PlexMetadata[] | undefined): PlexItem[] {
    const out: PlexItem[] = [];
    for (const meta of list ?? []) {
      const item = this.#item(meta);
      if (item) out.push(item);
    }
    return out;
  }

  #item(meta: PlexMetadata): PlexItem | null {
    const id = meta.ratingKey;
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    const kind = kindOf(meta.type);
    const single = kind === 'movie' || kind === 'episode' || kind === 'clip' || kind === 'track';
    const viewOffset = typeof meta.viewOffset === 'number' ? meta.viewOffset : 0;
    const video = single && kind !== 'track';
    return {
      id,
      kind,
      title: meta.title ?? 'Untitled',
      subtitle: subtitleOf(kind, meta),
      art: this.#art(
        kind === 'episode' ? (meta.grandparentThumb ?? meta.thumb) : (meta.thumb ?? meta.parentThumb),
        AUDIO.has(kind) ? 'square' : 'poster',
      ),
      browsable: BROWSABLE.has(kind),
      playable: PLAYABLE.has(kind),
      duration: single && typeof meta.duration === 'number' ? Math.round(meta.duration / 1000) : null,
      resume: single && viewOffset > 5_000 ? Math.round(viewOffset / 1000) : null,
      ...(video ? { watched: (meta.viewCount ?? 0) > 0 } : {}),
    };
  }

  /**
   * A thumbnail path on the server, resized by the server, behind an opaque key.
   *
   * Films, shows and episodes come back at poster proportions (2:3) and large
   * enough to fill a poster card; music and libraries stay square.
   */
  #art(path: string | undefined, shape: 'poster' | 'square' = 'square'): string | null {
    if (typeof path !== 'string' || !path.startsWith('/')) return null;
    const url = new URL('/photo/:/transcode', this.#env.url);
    url.searchParams.set('width', shape === 'poster' ? '320' : '240');
    url.searchParams.set('height', shape === 'poster' ? '480' : '240');
    url.searchParams.set('minSize', '1');
    url.searchParams.set('upscale', '1');
    url.searchParams.set('url', path);
    url.searchParams.set('X-Plex-Token', this.#env.token);
    return this.#deps.art.register(url.href);
  }

  /* ── Players ─────────────────────────────────────────────────────────── */

  /**
   * Everywhere something could be sent.
   *
   * Every configured Apple TV is listed whether or not Plex is open on it —
   * opening it is part of playing there. Other Plex players are listed when
   * they are running and reachable on the LAN.
   */
  async targets(): Promise<PlexTarget[]> {
    const appleTvs = this.#deps.appleTvs();
    const out: PlexTarget[] = appleTvs.map((tv) => ({
      id: `atv:${tv.id}`,
      name: tv.name,
      product: 'Apple TV',
      appleTv: tv.id,
    }));
    for (const mac of this.#macs()) {
      out.push({ id: `mac:${mac.id}`, name: mac.name, product: 'IINA on Mac', appleTv: null });
    }
    const hosts = new Set(appleTvs.map((tv) => tv.host));
    for (const player of await this.#players()) {
      if (hosts.has(player.host)) continue;
      out.push({ id: `plex:${player.id}`, name: player.name, product: player.product, appleTv: null });
    }
    return out;
  }

  async play(id: string, target: string, resume: boolean): Promise<void> {
    if (target.startsWith('mac:')) return this.#playOnMac(id, target.slice(4), resume);
    const [meta, player] = await Promise.all([
      this.#metadata(id),
      this.#resolveTarget(target),
    ]);
    const kind = kindOf(meta.type);
    if (!PLAYABLE.has(kind)) throw new Error(`${meta.title ?? 'That'} cannot be played directly`);
    await this.#identity();
    const type = AUDIO.has(kind) ? 'music' : 'video';

    const queue = await this.#post('/playQueues', {
      type: type === 'music' ? 'audio' : 'video',
      uri: `server://${this.#machineId}/com.plexapp.plugins.library/library/metadata/${id}`,
      shuffle: '0',
      repeat: '0',
      continuous: kind === 'episode' ? '1' : '0',
      includeChapters: '1',
    });
    const selected = queue.Metadata?.find((item) => item.playQueueItemID === queue.playQueueSelectedItemID)
      ?? queue.Metadata?.[0];
    if (typeof queue.playQueueID !== 'number' || !selected?.ratingKey) {
      throw new Error('Plex did not create a play queue for that');
    }

    const server = new URL(this.#env.url);
    const offset = resume && kind !== 'season' && kind !== 'album' && typeof meta.viewOffset === 'number'
      ? meta.viewOffset : 0;
    const params: Record<string, string> = {
      key: `/library/metadata/${selected.ratingKey}`,
      offset: String(offset),
      machineIdentifier: this.#machineId ?? '',
      address: server.hostname,
      port: server.port || (server.protocol === 'https:' ? '443' : '80'),
      protocol: server.protocol.replace(':', ''),
      token: this.#env.token,
      type,
      containerKey: `/playQueues/${queue.playQueueID}?window=100&own=1`,
      providerIdentifier: 'com.plexapp.plugins.library',
    };
    await this.#command(player, target, params);
    log.info(`Playing "${meta.title ?? id}" on ${player.name}`);
  }

  /**
   * Open the item's file in IINA on a Mac, over SSH.
   *
   * `caffeinate -u` first, so a Mac with its display asleep shows the film
   * rather than playing it to a dark screen. `open` exits non-zero when no
   * app takes `iina://` links, which is the one failure worth naming.
   */
  async #playOnMac(id: string, macId: string, resume: boolean): Promise<void> {
    const mac = this.#macs().find((host) => host.id === macId);
    if (!mac || !this.#deps.runSsh) throw new Error('That Mac is not set up to play Plex. Mark it iina: true under controls.ssh.');
    const meta = await this.#metadata(id);
    const kind = kindOf(meta.type);
    if (!MAC_PLAYABLE.has(kind)) {
      const one = kind === 'season' || kind === 'show' ? 'an episode' : kind === 'album' || kind === 'artist' ? 'a track' : 'a single item';
      throw new Error(`IINA plays one file at a time. Choose ${one}.`);
    }
    const part = meta.Media?.[0]?.Part?.[0]?.key;
    if (!part || !PART_RE.test(part)) throw new Error(`Plex has no playable file for ${meta.title ?? 'that'}`);

    const media = new URL(part, this.#env.url);
    media.searchParams.set('X-Plex-Token', await this.#transientToken());
    const start = resume && typeof meta.viewOffset === 'number' ? Math.floor(meta.viewOffset / 1000) : 0;
    const problem = await this.#deps.runSsh(mac.id, iinaCommand(media.href, start));
    if (problem) {
      throw new Error(/exited 1$/.test(problem)
        ? `${mac.name} could not open IINA. Is it installed, and is someone logged in to the Mac?`
        : `Could not reach ${mac.name}: ${problem}`);
    }
    log.info(`Playing "${meta.title ?? id}" in IINA on ${mac.name}`);
    this.#deps.iinaWatch?.(mac.id, this.#iinaSync(id, part, meta, mac, kind === 'track' ? 'music' : 'video'));
  }

  /**
   * Report what IINA plays back to Plex, for one item.
   *
   * It is recognised by its part path in what mpv opened, so something else
   * opened in the same IINA afterwards ends this item's reporting rather
   * than being reported as it. Reports are fire-and-forget: a server that
   * misses one hears the position again a few seconds later.
   */
  #iinaSync(id: string, part: string, meta: PlexMetadata, mac: SshHostConfig, type: 'video' | 'music'): IinaListener {
    const marker = part.slice(0, part.lastIndexOf('/') + 1);
    const title = meta.grandparentTitle ? `${meta.grandparentTitle} – ${meta.title ?? ''}` : meta.title ?? null;
    const as = {
      'X-Plex-Client-Identifier': `${this.#clientId}-iina-${mac.id}`,
      'X-Plex-Product': 'IINA',
      'X-Plex-Device-Name': mac.name,
      'X-Plex-Platform': 'macOS',
      'X-Plex-Provides': 'player',
    };
    let seen = false;
    let done = false;
    let watched = false;
    let last: IinaStatus | null = null;
    let lastState = '';
    let lastSent = 0;

    const timeline = (state: 'playing' | 'paused' | 'stopped', status: IinaStatus): void => {
      if (status.position === null) return;
      const query: Record<string, string> = {
        ratingKey: id,
        key: `/library/metadata/${id}`,
        identifier: 'com.plexapp.plugins.library',
        type,
        state,
        time: String(Math.round(status.position * 1000)),
      };
      if (status.duration) query['duration'] = String(Math.round(status.duration * 1000));
      void this.#report('/:/timeline', query, as);
    };
    const finish = (): void => {
      if (done) return;
      done = true;
      if (seen && last) timeline('stopped', last);
    };
    const mine = (status: IinaStatus): boolean => status.path.includes(marker);

    return {
      status: (status) => {
        if (done) return;
        if (!mine(status)) {
          if (seen) finish();
          return;
        }
        seen = true;
        last = status;
        const state = status.paused ? 'paused' : 'playing';
        const now = Date.now();
        if (state !== lastState || now - lastSent >= REPORT_MS) {
          lastState = state;
          lastSent = now;
          timeline(state, status);
        }
        if (!watched && status.position !== null && status.duration && status.position / status.duration >= WATCHED_AT) {
          watched = true;
          void this.#report('/:/scrobble', { key: id, identifier: 'com.plexapp.plugins.library' }, as);
          log.info(`Marked "${meta.title ?? id}" watched in Plex (IINA on ${mac.name})`);
        }
      },
      titleFor: (status) => (mine(status) ? title : null),
      end: finish,
    };
  }

  /** A report to the server whose answer does not matter beyond its status. */
  async #report(path: string, query: Record<string, string>, as: Record<string, string>): Promise<void> {
    const url = new URL(path, this.#env.url);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    try {
      const res = await fetchWithTimeout(url.href, { headers: { ...this.#headers(), ...as } }, TIMEOUT_MS);
      if (!res.ok) log.debug(`Plex answered ${path} with HTTP ${res.status}`);
    } catch (error) {
      log.debug(`Could not report ${path} to Plex: ${messageOf(error)}`);
    }
  }

  /**
   * A token that stops working on its own, for links that leave this backend
   * as plain text. Older servers without `/security/token` get the real one.
   */
  async #transientToken(): Promise<string> {
    try {
      const body = await this.#get('/security/token', { type: 'delegation', scope: 'all' });
      if (body.token) return body.token;
    } catch (error) {
      log.debug(`No transient token from Plex: ${messageOf(error)}`);
    }
    return this.#env.token;
  }

  #macs(): SshHostConfig[] {
    return (this.#deps.sshHosts?.() ?? []).filter((host) => host.iina);
  }

  /**
   * Send playMedia, retrying while an Apple TV is still waking into Plex.
   *
   * A just-launched app can be found (plex.tv remembers it from last time)
   * a moment before it is ready to take commands; one refused command there
   * is timing, not an answer.
   */
  async #command(player: Player, target: string, params: Record<string, string>): Promise<void> {
    const deadline = Date.now() + (target.startsWith('atv:') ? this.#readyMs() / 2 : 0);
    let last: unknown = null;
    for (;;) {
      try {
        await this.#sendDirect(player, params);
        return;
      } catch (error) {
        last = error;
      }
      // The server relays commands to players it heard over GDM, which covers
      // a player whose own port this container cannot reach.
      try {
        await this.#sendViaServer(player, params);
        return;
      } catch (error) {
        log.debug(`Relay through the server failed: ${messageOf(error)}`);
      }
      if (Date.now() >= deadline) break;
      await sleep(POLL_MS);
    }
    throw new Error(`${player.name} did not accept the command (${messageOf(last)})`);
  }

  async #sendDirect(player: Player, params: Record<string, string>): Promise<void> {
    const url = new URL(`${player.scheme}://${hostPart(player.host)}:${player.port}/player/playback/playMedia`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('commandID', String(++this.#commandId));
    const res = await fetchWithTimeout(url.href, { headers: this.#headers(player.id) }, PROBE_TIMEOUT_MS * 2);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  async #sendViaServer(player: Player, params: Record<string, string>): Promise<void> {
    const url = new URL('/player/playback/playMedia', this.#env.url);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('commandID', String(++this.#commandId));
    const res = await fetchWithTimeout(url.href, { headers: this.#headers(player.id) }, TIMEOUT_MS);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  async #resolveTarget(target: string): Promise<Player> {
    if (target.startsWith('atv:')) {
      const id = target.slice(4);
      const tv = this.#deps.appleTvs().find((item) => item.id === id);
      if (!tv) throw new Error('That Apple TV is not configured');
      return this.#readyAppleTv(tv);
    }
    if (target.startsWith('plex:')) {
      const id = target.slice(5);
      if (!MACHINE_RE.test(id)) throw new Error('Not a Plex player');
      const player = (await this.#players()).find((item) => item.id === id);
      if (!player) throw new Error('That Plex player is no longer available. Open Plex on it and try again.');
      return player;
    }
    throw new Error('Choose where to play it');
  }

  /**
   * Wake the Apple TV, bring Plex to the front, and wait for it to be a player.
   *
   * Opening Plex is attempted even if it seems to be open already: it is
   * harmless when it is, and on tvOS "open" is the only state in which the app
   * listens at all.
   */
  async #readyAppleTv(tv: AppleTvConfig): Promise<Player> {
    const state = this.#deps.appleTvStates().find((item) => item.id === tv.id);
    if (state?.power === 'off') {
      const problem = await this.#deps.appleTvCommand(tv.id, 'power_on');
      if (problem) log.debug(`Waking ${tv.name} before Plex: ${problem}`);
    }
    const opened = await this.#deps.openApp(tv.id, PLEX_BUNDLE);
    if (opened) log.warn(`Could not open Plex on ${tv.name}: ${opened}`);

    const deadline = Date.now() + this.#readyMs();
    let round = 0;
    for (;;) {
      // The direct probe is cheap and exact; the lists are slower and are
      // only worth asking every other round.
      const direct = await this.#probe(tv.host, tv.name);
      if (direct) return direct;
      if (round % 2 === 0) {
        const found = (await this.#players()).find((player) => player.host === tv.host);
        if (found) return { ...found, name: tv.name };
      }
      round += 1;
      if (Date.now() >= deadline) break;
      await sleep(POLL_MS);
    }
    throw new Error(
      opened
        ? `Could not open Plex on ${tv.name} (${opened}), and it is not showing up as a Plex player.`
        : `Plex opened on ${tv.name}, but it did not show up as a Plex player. In Plex on the Apple TV, ` +
          'check that the setting allowing other Plex apps to control it is on, and that it is signed ' +
          'in to the same Plex account as the server.',
    );
  }

  /** Ask the Companion port at an address who is there. */
  async #probe(host: string, name: string): Promise<Player | null> {
    const port = this.#deps.playerPort ?? PLAYER_PORT;
    try {
      const res = await fetchWithTimeout(
        `http://${hostPart(host)}:${port}/resources`,
        { headers: this.#headers() },
        PROBE_TIMEOUT_MS,
      );
      if (!res.ok) return null;
      const text = await res.text();
      const id = /machineIdentifier="([^"]+)"/.exec(text)?.[1] ?? /"machineIdentifier"\s*:\s*"([^"]+)"/.exec(text)?.[1];
      if (!id || !MACHINE_RE.test(id)) return null;
      const product = /product="([^"]+)"/.exec(text)?.[1] ?? 'Plex';
      return { id, name, product, host, port, scheme: 'http' };
    } catch {
      return null;
    }
  }

  /** Every running player the server or plex.tv knows about, one entry each. */
  async #players(): Promise<Player[]> {
    const [clients, resources] = await Promise.allSettled([this.#serverClients(), this.#plexTvPlayers()]);
    const byId = new Map<string, Player>();
    for (const list of [clients, resources]) {
      if (list.status !== 'fulfilled') {
        log.debug('Plex player lookup failed:', list.reason);
        continue;
      }
      for (const player of list.value) if (!byId.has(player.id)) byId.set(player.id, player);
    }
    byId.delete(this.#clientId);
    return [...byId.values()];
  }

  async #serverClients(): Promise<Player[]> {
    const body = await this.#get('/clients');
    const out: Player[] = [];
    for (const item of body.Server ?? []) {
      const id = item.machineIdentifier;
      const host = item.address ?? item.host;
      const port = Number(item.port) || PLAYER_PORT;
      if (!id || !MACHINE_RE.test(id) || !host) continue;
      out.push({
        id, name: item.name ?? 'Plex player', product: item.product ?? 'Plex',
        host, port, scheme: item.protocol === 'https' ? 'https' : 'http',
      });
    }
    return out;
  }

  async #plexTvPlayers(): Promise<Player[]> {
    const url = new URL('/api/v2/resources', this.#deps.plexTv ?? PLEX_TV);
    url.searchParams.set('includeHttps', '1');
    const res = await fetchWithTimeout(url.href, { headers: this.#headers() }, TIMEOUT_MS);
    if (!res.ok) throw new Error(`plex.tv answered HTTP ${res.status}`);
    const list = (await res.json()) as PlexTvResource[];
    const out: Player[] = [];
    for (const item of Array.isArray(list) ? list : []) {
      const provides = (item.provides ?? '').split(',');
      if (!provides.includes('player') || item.presence === false) continue;
      const id = item.clientIdentifier;
      const local = (item.connections ?? []).find((c) => c.local && c.address);
      if (!id || !MACHINE_RE.test(id) || !local?.address) continue;
      out.push({
        id, name: item.name ?? 'Plex player', product: item.product ?? 'Plex',
        host: local.address, port: local.port || PLAYER_PORT,
        scheme: local.protocol === 'https' ? 'https' : 'http',
      });
    }
    return out;
  }

  /* ── HTTP ────────────────────────────────────────────────────────────── */

  async #identity(): Promise<void> {
    if (this.#machineId) return;
    const body = await this.#get('/');
    if (!body.machineIdentifier) throw new Error('That does not look like a Plex Media Server');
    this.#machineId = body.machineIdentifier;
    this.#serverName = body.friendlyName || 'Plex';
  }

  async #metadata(id: string): Promise<PlexMetadata> {
    const body = await this.#get(`/library/metadata/${id}`);
    const meta = body.Metadata?.[0];
    if (!meta) throw new Error('That is no longer in Plex');
    return meta;
  }

  #get(path: string, query: Record<string, string> = {}): Promise<MediaContainer> {
    return this.#request('GET', path, query);
  }

  #post(path: string, query: Record<string, string>): Promise<MediaContainer> {
    return this.#request('POST', path, query);
  }

  async #request(method: string, path: string, query: Record<string, string>): Promise<MediaContainer> {
    const url = new URL(path, this.#env.url);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetchWithTimeout(url.href, { method, headers: this.#headers() }, TIMEOUT_MS);
    } catch (error) {
      throw new Error(`Plex is not answering at ${this.#env.url} (${messageOf(error)})`);
    }
    if (res.status === 401) throw new Error('Plex refused the token. Check PLEX_TOKEN.');
    if (res.status === 404) throw new Error('That is no longer in Plex');
    if (!res.ok) throw new Error(`Plex answered HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { MediaContainer?: MediaContainer } | null;
    if (!body?.MediaContainer) throw new Error('Plex sent something unreadable');
    return body.MediaContainer;
  }

  #headers(target?: string): Record<string, string> {
    return {
      accept: 'application/json',
      'X-Plex-Token': this.#env.token,
      'X-Plex-Client-Identifier': this.#clientId,
      'X-Plex-Product': 'Navigator Panel',
      'X-Plex-Device-Name': 'Navigator Panel',
      'X-Plex-Platform': 'Node.js',
      'X-Plex-Version': '1.0',
      'X-Plex-Provides': 'controller',
      ...(target ? { 'X-Plex-Target-Client-Identifier': target } : {}),
    };
  }

  #readyMs(): number {
    return this.#deps.readyMs ?? APPLE_TV_READY_MS;
  }
}

function kindOf(type: string | undefined): PlexKind {
  switch (type) {
    case 'movie': case 'show': case 'season': case 'episode':
    case 'artist': case 'album': case 'track': case 'clip':
      return type;
    default:
      return 'folder';
  }
}

function subtitleOf(kind: PlexKind, meta: PlexMetadata): string | null {
  const parts: string[] = [];
  switch (kind) {
    case 'episode': {
      if (meta.grandparentTitle) parts.push(meta.grandparentTitle);
      const s = typeof meta.parentIndex === 'number' ? `S${meta.parentIndex}` : '';
      const e = typeof meta.index === 'number' ? `E${meta.index}` : '';
      if (s || e) parts.push(`${s}${s && e ? ' ' : ''}${e}`);
      break;
    }
    case 'season':
      if (meta.parentTitle) parts.push(meta.parentTitle);
      if (typeof meta.leafCount === 'number') parts.push(`${meta.leafCount} episodes`);
      break;
    case 'show':
      if (meta.year) parts.push(String(meta.year));
      if (typeof meta.childCount === 'number') parts.push(`${meta.childCount} season${meta.childCount === 1 ? '' : 's'}`);
      break;
    case 'movie':
      if (meta.year) parts.push(String(meta.year));
      if (typeof meta.duration === 'number') parts.push(`${Math.round(meta.duration / 60_000)} min`);
      break;
    case 'album':
      if (meta.parentTitle) parts.push(meta.parentTitle);
      if (meta.year) parts.push(String(meta.year));
      break;
    case 'track':
      if (meta.grandparentTitle) parts.push(meta.grandparentTitle);
      if (meta.parentTitle) parts.push(meta.parentTitle);
      break;
    case 'artist':
      parts.push('Artist');
      break;
    default:
      break;
  }
  return parts.length ? parts.join(' · ') : null;
}

/**
 * The shell command that opens a file in IINA.
 *
 * No title is sent: IINA only accepts the mpv options on its own safe list
 * from a link, and `force-media-title` is not one of them.
 *
 * Every value is percent-encoded — including the `!'()*` that
 * encodeURIComponent leaves alone — so the link is plain URL characters and
 * a single-quoted argument cannot be broken out of. Checked again anyway,
 * because this string reaches a shell.
 */
export function iinaCommand(media: string, startSeconds: number): string {
  const query = [`url=${encodeAll(media)}`];
  if (startSeconds > 0) query.push(`mpv_start=${Math.floor(startSeconds)}`);
  const link = `iina://open?${query.join('&')}`;
  if (!/^[A-Za-z0-9%._~:/?&=-]+$/.test(link)) throw new Error('Refusing an unsafe link');
  return `caffeinate -u -t 1; open '${link}'`;
}

function encodeAll(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** IPv6 literals need brackets in a URL. */
function hostPart(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
  } finally {
    clearTimeout(timer);
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.name === 'AbortError' ? 'timed out' : error.message;
  return 'unknown error';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
