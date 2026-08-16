import { logger } from '~/lib/log.ts';
import type { MassClient } from '~/mass/client.ts';
import type { MassStore } from '~/mass/store.ts';
import type { MediaArt } from '~/http/media-art.ts';
import {
  BROWSE_PAGE,
  MEDIA_KINDS,
  SEARCH_LIMIT,
  type BrowseRequest,
  type BrowseResult,
  type MediaItem,
  type MediaKind,
  type QueueEntry,
} from '@shared/protocol.ts';

const log = logger('mass-browse');

/**
 * Browsing and the queue, straight from Music Assistant.
 *
 * This replaces the version that went through Home Assistant's
 * `music_assistant.*` services. Three things became possible by dropping the
 * middleman, and each of them is a thing the panel could not previously do:
 *
 *  - **drill down.** `music/albums/album_tracks` and friends mean tapping an
 *    album can show its tracks rather than only playing all of it.
 *  - **the real queue.** `player_queues/items` returns the rows, paged.
 *  - **real history.** `music/recently_played_items` is what was played, not
 *    the library sorted by when it was last played — so a radio station or a
 *    track you do not own still appears.
 */

/** Which Music Assistant command lists each library type. */
const LIBRARY_COMMAND: Record<MediaKind, string> = {
  artist: 'music/artists/library_items',
  album: 'music/albums/library_items',
  track: 'music/tracks/library_items',
  playlist: 'music/playlists/library_items',
  radio: 'music/radios/library_items',
  podcast: 'music/podcasts/library_items',
  audiobook: 'music/audiobooks/library_items',
};

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
const MAX_URI = 512;

export class MassBrowser {
  readonly #client: MassClient;
  readonly #store: MassStore;
  readonly #art: MediaArt;

  constructor(client: MassClient, store: MassStore, art: MediaArt) {
    this.#client = client;
    this.#store = store;
    this.#art = art;
  }

  /**
   * Handle one browse request.
   *
   * Throws with a message meant to be read on the panel — these are
   * user-visible and actionable, unlike the command guard's deliberately vague
   * refusals.
   */
  async browse(req: BrowseRequest): Promise<BrowseResult> {
    if (!this.#client.enabled) {
      throw new Error('Music Assistant is not configured');
    }
    if (this.#client.state !== 'connected') {
      throw new Error(this.#client.lastError ?? 'Music Assistant is offline');
    }

    switch (req.kind) {
      case 'library':
        return this.#library(req);
      case 'search':
        return this.#search(req.text);
      case 'item':
        return this.#item(req.uri, clampOffset(req.offset));
      case 'queue':
        return this.#queue(req.queueId, clampOffset(req.offset));
    }
  }

  /* ── Library ───────────────────────────────────────────────────────────*/

  async #library(req: Extract<BrowseRequest, { kind: 'library' }>): Promise<BrowseResult> {
    if (!MEDIA_KINDS.includes(req.media)) throw new Error('Unknown media type');
    const offset = clampOffset(req.offset);

    /*
     * "Recent" is a genuine play history here, not the library sorted by last
     * played. It is a different command with a different answer: something
     * streamed once and never added to the library appears in one and not the
     * other, and on a wall panel the thing you played yesterday is exactly
     * what you are reaching for.
     */
    if (req.recent) {
      const raw = await this.#call('music/recently_played_items', {
        limit: BROWSE_PAGE,
        // Skipping partial listens keeps "recent" meaning "things I listened
        // to", not "things that were on for four seconds while I skipped".
        fully_played_only: false,
      });
      const items = asArray(raw).map((x) => this.#shape(x, 'track'));
      return { kind: 'list', items, offset: 0, more: false };
    }

    const command = LIBRARY_COMMAND[req.media];
    const raw = await this.#call(command, {
      limit: BROWSE_PAGE,
      offset,
      order_by: 'sort_name',
      ...(req.favorite ? { favorite: true } : {}),
    });

    const items = asArray(raw).map((x) => this.#shape(x, req.media));
    return {
      kind: 'list',
      items,
      offset,
      // Music Assistant does not report a total on these, so a full page is
      // the only evidence there might be another. A library that is an exact
      // multiple of the page size costs one empty request.
      more: items.length === BROWSE_PAGE,
    };
  }

  /* ── Search ────────────────────────────────────────────────────────────*/

  async #search(text: string): Promise<BrowseResult> {
    const query = typeof text === 'string' ? text.trim().slice(0, MAX_SEARCH_TEXT) : '';
    if (query.length === 0) return { kind: 'groups', groups: [] };

    const raw = await this.#call('music/search', {
      search_query: query,
      limit: SEARCH_LIMIT,
    });

    const groups: { name: string; items: MediaItem[] }[] = [];
    for (const section of SEARCH_ORDER) {
      const items = asArray(pick(raw, section.key)).map((x) => this.#shape(x, section.kind));
      if (items.length > 0) groups.push({ name: section.name, items });
    }
    return { kind: 'groups', groups };
  }

  /* ── Drilling into one item ────────────────────────────────────────────*/

  /**
   * An album's tracks, an artist's albums, a playlist's tracks.
   *
   * Music Assistant addresses items by `(item_id, provider)` rather than by
   * URI for these, so the URI is resolved first. That is one extra round trip
   * per drill-down and it is worth it: the alternative is the panel holding
   * provider ids, which would leak Music Assistant's internal shape into the
   * wire protocol for no benefit.
   */
  async #item(uri: string, offset: number): Promise<BrowseResult> {
    if (typeof uri !== 'string' || uri.length === 0 || uri.length > MAX_URI) {
      throw new Error('Not a valid item');
    }

    const item = await this.#call('music/item_by_uri', { uri });
    const itemId = str(pick(item, 'item_id'));
    const provider = str(pick(item, 'provider'));
    const kind = str(pick(item, 'media_type'));

    if (!itemId || !provider) throw new Error('Music Assistant does not know that item');

    const args = { item_id: itemId, provider_instance_id_or_domain: provider };

    let raw: unknown;
    let childKind: MediaKind;
    if (kind === 'album') {
      raw = await this.#call('music/albums/album_tracks', args);
      childKind = 'track';
    } else if (kind === 'artist') {
      raw = await this.#call('music/artists/artist_albums', args);
      childKind = 'album';
    } else if (kind === 'playlist') {
      raw = await this.#call('music/playlists/playlist_tracks', { ...args, offset, limit: BROWSE_PAGE });
      childKind = 'track';
    } else if (kind === 'podcast') {
      raw = await this.#call('music/podcasts/podcast_episodes', args);
      childKind = 'track';
    } else {
      throw new Error('Nothing to open');
    }

    const all = asArray(raw).map((x) => this.#shape(x, childKind));

    /*
     * Only playlists page upstream; album and artist listings come back
     * whole. Slicing here keeps one page-size rule for the panel rather than
     * making it remember which kinds paginate.
     */
    if (kind === 'playlist') {
      return { kind: 'list', items: all, offset, more: all.length === BROWSE_PAGE };
    }
    const page = all.slice(offset, offset + BROWSE_PAGE);
    return { kind: 'list', items: page, offset, more: offset + page.length < all.length };
  }

  /* ── The queue ─────────────────────────────────────────────────────────*/

  async #queue(queueId: string, offset: number): Promise<BrowseResult> {
    // The same check every command gets: a queue id has to be one Music
    // Assistant told us about, so browsing cannot become a way to read the
    // state of something the panel was never shown.
    if (typeof queueId !== 'string' || !this.#store.hasQueue(queueId)) {
      throw new Error('Not permitted');
    }

    const raw = await this.#call('player_queues/items', {
      queue_id: queueId,
      limit: BROWSE_PAGE,
      offset,
    });

    const entries: QueueEntry[] = asArray(raw).map((item, i) => this.#entry(item, offset + i));

    const queue = this.#store.snapshot().queues.find((q) => q.id === queueId);
    return {
      kind: 'queuePage',
      queueId,
      entries,
      offset,
      total: queue?.count ?? entries.length,
      current: queue?.index ?? null,
    };
  }

  #entry(raw: unknown, index: number): QueueEntry {
    const media = pick(raw, 'media_item');
    const shaped = media ? this.#shape(media, 'track') : null;

    return {
      id: str(pick(raw, 'queue_item_id')) ?? String(index),
      // A queue item's own name is the fallback for radio and one-off streams,
      // which have no library item behind them.
      name: shaped?.n ?? str(pick(raw, 'name')) ?? 'Unknown',
      sub: shaped?.s ?? str(pick(raw, 'stream_title')) ?? null,
      art: shaped?.a ?? null,
      duration: num(pick(raw, 'duration')),
      index,
    };
  }

  /* ── Plumbing ──────────────────────────────────────────────────────────*/

  async #call(command: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.#client.command(command, args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`${command} failed: ${message}`);
      if (message.includes('not connected')) throw new Error('Music Assistant is offline');
      if (message.includes('did not respond')) throw new Error('Music Assistant did not respond');
      throw new Error('Music Assistant could not answer');
    }
  }

  /**
   * A Music Assistant media item → the four fields a row draws.
   *
   * The artwork URL is swapped for a key on our own origin here, which is the
   * only place a Music Assistant address is allowed into the registry.
   */
  #shape(raw: unknown, fallbackKind: MediaKind): MediaItem {
    const kindRaw = str(pick(raw, 'media_type'));
    const kind = (MEDIA_KINDS as readonly string[]).includes(kindRaw ?? '')
      ? (kindRaw as MediaKind)
      : fallbackKind;

    const item: MediaItem = {
      u: str(pick(raw, 'uri')) ?? '',
      n: str(pick(raw, 'name')) ?? 'Unknown',
      k: kind,
    };

    const sub = subtitle(raw, kind);
    if (sub) item.s = sub;

    // Only full media items carry this; a lightweight mapping does not, and
    // "absent" has to stay distinguishable from "not a favourite" so the panel
    // does not offer to un-favourite something it knows nothing about.
    if (typeof pick(raw, 'favorite') === 'boolean') item.f = pick(raw, 'favorite') as boolean;

    const art = this.#art.register(this.#client.imageUrl(imageOf(raw)));
    if (art) item.a = art;

    return item;
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────────*/

/**
 * Find an item's artwork.
 *
 * Music Assistant puts it in one of two places depending on how complete the
 * object is: a lightweight `ItemMapping` carries a single `image`, while a
 * full media item carries `metadata.images` — a list where the thumbnail is
 * not necessarily first, since fanart and logos live there too.
 */
function imageOf(raw: unknown): unknown {
  const direct = pick(raw, 'image');
  if (direct) return direct;

  const images = asArray(pick(pick(raw, 'metadata'), 'images'));
  return images.find((img) => str(pick(img, 'type')) === 'thumb') ?? images[0] ?? null;
}

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

function clampOffset(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
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
