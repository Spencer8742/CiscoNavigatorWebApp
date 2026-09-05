import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '~/lib/log.ts';
import { MEDIA_KINDS, type MediaItem, type MediaKind } from '@shared/protocol.ts';
import type { Playable, PlayStyle, UriRegistry } from '~/sonos/uris.ts';

const log = logger('media-shelf');
const MAX_RECENT = 30;
const MAX_PINNED = 30;

interface SavedMedia {
  item: Omit<MediaItem, 'u' | 'a' | 'p'>;
  playable: Playable;
}

export class MediaShelf {
  readonly #path: string;
  readonly #uris: UriRegistry;
  #recent: SavedMedia[] = [];
  #pinned: SavedMedia[] = [];

  constructor(path: string, uris: UriRegistry) {
    this.#path = path;
    this.#uris = uris;
    this.#load();
  }

  list(which: 'recent' | 'pinned'): MediaItem[] {
    return (which === 'recent' ? this.#recent : this.#pinned).flatMap((saved) => {
      const u = this.#uris.restore(saved.playable);
      return u ? [{ ...saved.item, u, ...(which === 'pinned' ? { p: true } : {}) }] : [];
    });
  }

  remember(key: string, raw: MediaItem | undefined): void {
    const saved = this.#entry(key, raw);
    if (!saved) return;
    const id = identity(saved.playable);
    this.#recent = [saved, ...this.#recent.filter((item) => identity(item.playable) !== id)].slice(
      0,
      MAX_RECENT,
    );
    this.#save();
  }

  pin(key: string, raw: MediaItem, on: boolean): string | null {
    const playable = this.#uris.get(key);
    if (!playable) return 'That item is no longer loaded — browse to it again';
    const id = identity(playable);
    if (!on) {
      this.#pinned = this.#pinned.filter((item) => identity(item.playable) !== id);
    } else {
      const saved = this.#entry(key, raw);
      if (!saved) return 'That item cannot be pinned';
      this.#pinned = [saved, ...this.#pinned.filter((item) => identity(item.playable) !== id)].slice(
        0,
        MAX_PINNED,
      );
    }
    this.#save();
    return null;
  }

  #entry(key: string, raw: MediaItem | undefined): SavedMedia | null {
    const playable = this.#uris.get(key);
    const item = sanitizeItem(raw);
    return playable && item ? { playable: { ...playable }, item } : null;
  }

  #load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.#path, 'utf8')) as Record<string, unknown>;
      this.#recent = sanitizeList(raw['recent'], MAX_RECENT);
      this.#pinned = sanitizeList(raw['pinned'], MAX_PINNED);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('Could not load media shelf:', err);
    }
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ recent: this.#recent, pinned: this.#pinned }, null, 2)}\n`);
      renameSync(tmp, this.#path);
    } catch (err) {
      log.warn('Could not persist media shelf:', err);
    }
  }
}

function sanitizeList(raw: unknown, max: number): SavedMedia[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, max).flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const record = value as Record<string, unknown>;
    const item = sanitizeItem(record['item']);
    const playable = sanitizePlayable(record['playable']);
    return item && playable ? [{ item, playable }] : [];
  });
}

function sanitizeItem(raw: unknown): SavedMedia['item'] | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (typeof item['n'] !== 'string' || item['n'].length === 0 || item['n'].length > 300) return null;
  if (typeof item['k'] !== 'string' || !MEDIA_KINDS.includes(item['k'] as MediaKind)) return null;
  const out: SavedMedia['item'] = { n: item['n'], k: item['k'] as MediaKind };
  if (typeof item['s'] === 'string') out.s = item['s'].slice(0, 500);
  if (item['o'] === true) out.o = true;
  if (item['b'] === false) out.b = false;
  if (typeof item['sid'] === 'number' && Number.isInteger(item['sid'])) out.sid = item['sid'];
  return out;
}

function sanitizePlayable(raw: unknown): Playable | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const style = p['style'];
  if (style !== 'stream' && style !== 'container' && style !== 'track') return null;
  const text = (value: unknown, max: number): string | null =>
    typeof value === 'string' && value.length <= max ? value : null;
  const uri = p['uri'] === null ? null : text(p['uri'], 2000);
  const objectId = p['objectId'] === null ? null : text(p['objectId'], 2000);
  const metadata = text(p['metadata'], 20_000);
  if ((!uri && !objectId) || metadata === null) return null;
  const sid = p['sid'] === null ? null : Number.isInteger(p['sid']) ? (p['sid'] as number) : null;
  return { uri, objectId, metadata, style: style as PlayStyle, sid };
}

function identity(playable: Playable): string {
  return `${playable.uri ?? ''}\u0000${playable.objectId ?? ''}\u0000${playable.sid ?? ''}`;
}
