import type { MediaItem, MediaKind } from '@shared/protocol.ts';

/**
 * What a browsed item is called and drawn as, shared by the list rows and
 * Cover Flow so the two views can never disagree about what a thing is.
 */

export const KIND_LABEL: Record<MediaKind, string> = {
  artist: 'Artist',
  album: 'Album',
  track: 'Song',
  playlist: 'Playlist',
  radio: 'Radio',
  podcast: 'Podcast',
  audiobook: 'Audiobook',
};

export const KIND_ICON: Record<MediaKind, string> = {
  artist: 'media',
  album: 'disc',
  track: 'media',
  playlist: 'list',
  radio: 'radio',
  podcast: 'media',
  audiobook: 'media',
};

/** Kinds whose contents can be opened rather than only played. */
const EXPANDABLE = new Set<MediaKind>(['album', 'artist', 'playlist', 'podcast']);

/**
 * Whether tapping this opens it (an album's tracks, an artist's albums)
 * rather than playing it. `o` marks a place rather than a record — a source,
 * a category — which can only ever be opened.
 */
export function isExpandable(item: MediaItem): boolean {
  return item.o === true || (item.b !== false && EXPANDABLE.has(item.k) && item.u !== '');
}
