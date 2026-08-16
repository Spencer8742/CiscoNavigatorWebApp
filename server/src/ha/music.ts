import { logger } from '~/lib/log.ts';
import type { HaClient } from '~/ha/client.ts';
import type { HaStore } from '~/ha/store.ts';
import type { MediaArt } from '~/http/media-art.ts';
import {
  BROWSE_PAGE,
  MEDIA_KINDS,
  SEARCH_LIMIT,
  type BrowseRequest,
  type BrowseResult,
  type MediaItem,
  type MediaKind,
} from '@shared/protocol.ts';

const log = logger('ma-browse');

/**
 * Browsing, backed entirely by Music Assistant's own Home Assistant services.
 *
 * As with grouping, this app opens no second connection and keeps no library
 * of its own. Music Assistant already exposes everything needed:
 *
 *   music_assistant.get_library  → albums, artists, playlists, radio, tracks
 *   music_assistant.search       → everything, by name
 *   music_assistant.get_queue    → what is playing and what is next
 *   music_assistant.play_media   → play it
 *
 * The first three are `SupportsResponse.ONLY`, which is why the HA client
 * needed `return_response` before any of this could work: the rest of this
 * backend fires service calls and never reads a reply.
 *
 * ## The config entry id
 *
 * `search` and `get_library` are not entity services. They target a Music
 * Assistant *config entry*, which is an id the panel has no way to know and
 * the user should not have to find and paste into `dashboard.yaml`.
 *
 * So it is discovered: take any entity carrying `mass_player_type`, ask the
 * entity registry which config entry owns it, and keep the answer. That
 * command needs no admin rights (unlike `config_entries/get`), so it works
 * with an ordinary long-lived access token.
 */

/** Sections of a search result, in the order they are worth showing. */
const SEARCH_ORDER: { key: string; kind: MediaKind; name: string }[] = [
  { key: 'tracks', kind: 'track', name: 'Songs' },
  { key: 'albums', kind: 'album', name: 'Albums' },
  { key: 'artists', kind: 'artist', name: 'Artists' },
  { key: 'playlists', kind: 'playlist', name: 'Playlists' },
  { key: 'radio', kind: 'radio', name: 'Radio' },
  { key: 'podcasts', kind: 'podcast', name: 'Podcasts' },
  { key: 'audiobooks', kind: 'audiobook', name: 'Audiobooks' },
];

const MAX_SEARCH_TEXT = 120;

export class MusicBrowser {
  readonly #client: HaClient;
  readonly #store: HaStore;
  readonly #art: MediaArt;

  #configEntryId: string | null = null;
  /** In-flight discovery, so ten panels connecting at once ask HA once. */
  #discovering: Promise<string | null> | null = null;

  constructor(client: HaClient, store: HaStore, art: MediaArt) {
    this.#client = client;
    this.#store = store;
    this.#art = art;
  }

  /** True once we know how to reach Music Assistant's library. */
  get ready(): boolean {
    return this.#configEntryId !== null;
  }

  /** Forget the config entry, so the next browse rediscovers it. */
  reset(): void {
    this.#configEntryId = null;
    this.#discovering = null;
  }

  /**
   * Handle one browse request.
   *
   * Throws with a message meant for the panel — these are user-visible and
   * actionable ("Music Assistant is not set up"), unlike the service guard's
   * deliberately vague refusals.
   */
  async browse(req: BrowseRequest): Promise<BrowseResult> {
    switch (req.kind) {
      case 'queue':
        return this.#queue(req.entity);
      case 'search':
        return this.#search(req.text);
      case 'library':
        return this.#library(req);
    }
  }

  /* ── Discovery ─────────────────────────────────────────────────────────*/

  async #entryId(): Promise<string> {
    if (this.#configEntryId) return this.#configEntryId;
    this.#discovering ??= this.#discover().finally(() => {
      this.#discovering = null;
    });
    const found = await this.#discovering;
    if (!found) throw new Error('Music Assistant is not set up in Home Assistant');
    return found;
  }

  async #discover(): Promise<string | null> {
    const entity = this.#store.anyMusicAssistantEntity();
    if (!entity) {
      log.warn('No Music Assistant players found — cannot browse');
      return null;
    }

    let entry: unknown;
    try {
      entry = await this.#client.command('config/entity_registry/get', { entity_id: entity });
    } catch (err) {
      log.warn(`Entity registry lookup for "${entity}" failed:`, err);
      return null;
    }

    const id =
      entry && typeof entry === 'object' ? (entry as Record<string, unknown>)['config_entry_id'] : null;
    if (typeof id !== 'string' || id.length === 0) {
      log.warn(`Entity "${entity}" has no config entry — cannot browse`);
      return null;
    }

    log.info(`Music Assistant library available (config entry ${id})`);
    this.#configEntryId = id;
    return id;
  }

  /* ── Library ───────────────────────────────────────────────────────────*/

  async #library(req: Extract<BrowseRequest, { kind: 'library' }>): Promise<BrowseResult> {
    if (!MEDIA_KINDS.includes(req.media)) throw new Error('Unknown media type');

    const offset = clampOffset(req.offset);
    const data: Record<string, unknown> = {
      config_entry_id: await this.#entryId(),
      media_type: req.media,
      limit: BROWSE_PAGE,
      offset,
      // Sorting by last played is what makes "Recently Played" a view of the
      // library rather than a separate history Music Assistant does not offer.
      order_by: req.recent ? 'last_played_desc' : 'name',
    };
    if (req.favorite) data['favorite'] = true;

    const raw = await this.#call('get_library', data);
    const items = asArray(pick(raw, 'items')).map((x) => this.#item(x, req.media));

    return {
      kind: 'list',
      items,
      offset,
      // Music Assistant does not report a total, so a full page is the only
      // evidence there might be more. A library that is an exact multiple of
      // the page size costs one empty request; that is the whole downside.
      more: items.length === BROWSE_PAGE,
    };
  }

  /* ── Search ────────────────────────────────────────────────────────────*/

  async #search(text: string): Promise<BrowseResult> {
    const query = typeof text === 'string' ? text.trim().slice(0, MAX_SEARCH_TEXT) : '';
    if (query.length === 0) return { kind: 'groups', groups: [] };

    const raw = await this.#call('search', {
      config_entry_id: await this.#entryId(),
      name: query,
      limit: SEARCH_LIMIT,
    });

    const groups: { name: string; items: MediaItem[] }[] = [];
    for (const section of SEARCH_ORDER) {
      const items = asArray(pick(raw, section.key)).map((x) => this.#item(x, section.kind));
      if (items.length > 0) groups.push({ name: section.name, items });
    }
    return { kind: 'groups', groups };
  }

  /* ── Queue ─────────────────────────────────────────────────────────────*/

  async #queue(entityId: string): Promise<BrowseResult> {
    // Same allow-list as every other command aimed at a player. Browsing must
    // not become a way to read the state of a speaker the config never named.
    if (!entityId.startsWith('media_player.') || !this.#store.isAllowed(entityId)) {
      throw new Error('Not permitted');
    }

    const raw = await this.#client.callWithResponse(
      'music_assistant',
      'get_queue',
      { entity_id: entityId },
      {},
    );

    // A platform entity service answers per entity: { "media_player.x": {…} }.
    const body = unwrapEntityResponse(raw, entityId);

    return {
      kind: 'queue',
      name: str(pick(body, 'name')) ?? 'Queue',
      items: num(pick(body, 'items')) ?? 0,
      index: num(pick(body, 'current_index')),
      shuffle: pick(body, 'shuffle_enabled') === true,
      repeat: str(pick(body, 'repeat_mode')) ?? 'off',
      current: this.#queueItem(pick(body, 'current_item')),
      next: this.#queueItem(pick(body, 'next_item')),
    };
  }

  #queueItem(raw: unknown): MediaItem | null {
    if (!raw || typeof raw !== 'object') return null;
    const media = pick(raw, 'media_item');
    // A queue item wraps a media item, except for radio streams and one-off
    // URLs, where the queue item's own name is all there is.
    if (media && typeof media === 'object') return this.#item(media, 'track');

    const name = str(pick(raw, 'name'));
    if (!name) return null;

    const item: MediaItem = { u: '', n: name, k: 'track' };
    const stream = str(pick(raw, 'stream_title'));
    if (stream) item.s = stream;
    return item;
  }

  /* ── Plumbing ──────────────────────────────────────────────────────────*/

  async #call(service: string, data: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.#client.callWithResponse('music_assistant', service, {}, data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`music_assistant.${service} failed: ${message}`);

      // An entry that no longer exists means Music Assistant was removed and
      // re-added — a fresh id will be found on the next attempt rather than
      // every browse failing until the backend restarts.
      if (/config entry|not found|unknown/i.test(message)) this.reset();

      if (message.includes('not connected')) throw new Error('Home Assistant is offline');
      if (message.includes('did not respond')) throw new Error('Music Assistant did not respond');
      throw new Error('Music Assistant could not answer');
    }
  }

  /**
   * Music Assistant's media item → the four fields a row draws.
   *
   * The artwork URL is swapped for a key on our own origin here, which is the
   * single place a Music Assistant URL is ever allowed to enter the registry.
   */
  #item(raw: unknown, fallbackKind: MediaKind): MediaItem {
    const uri = str(pick(raw, 'uri')) ?? '';
    const name = str(pick(raw, 'name')) ?? 'Unknown';
    const kindRaw = str(pick(raw, 'media_type'));
    const kind = (MEDIA_KINDS as readonly string[]).includes(kindRaw ?? '')
      ? (kindRaw as MediaKind)
      : fallbackKind;

    const item: MediaItem = { u: uri, n: name, k: kind };

    const sub = subtitle(raw, kind);
    if (sub) item.s = sub;

    const art = this.#art.register(pick(raw, 'image'));
    if (art) item.a = art;

    return item;
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────────*/

/** "Artist · Album" for a track, "Artist" for an album, nothing for the rest. */
function subtitle(raw: unknown, kind: MediaKind): string | null {
  if (kind === 'artist') return null;

  const artists = asArray(pick(raw, 'artists'))
    .map((a) => str(pick(a, 'name')))
    .filter((n): n is string => !!n);

  const album = str(pick(pick(raw, 'album'), 'name'));
  const parts = [artists.join(', '), kind === 'track' ? album : null].filter(
    (p): p is string => !!p,
  );

  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * A platform entity service's response is keyed by entity id. Older versions
 * answered with the body directly, so both shapes are accepted.
 */
function unwrapEntityResponse(raw: unknown, entityId: string): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const byEntity = (raw as Record<string, unknown>)[entityId];
  return byEntity !== undefined ? byEntity : raw;
}

function clampOffset(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  // Music Assistant's own upper bound. Beyond it the call is rejected.
  return Math.min(Math.max(0, Math.floor(raw)), 1_000_000);
}

function pick(raw: unknown, key: string): unknown {
  if (!raw || typeof raw !== 'object') return undefined;
  return (raw as Record<string, unknown>)[key];
}

function asArray(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

function str(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function num(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}
