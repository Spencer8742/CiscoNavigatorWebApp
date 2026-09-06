import { signal } from '@preact/signals';
import type { MusicSource, Player, PlayerQueue } from '@shared/protocol.ts';

/**
 * The speakers and queues, as the backend last described them.
 *
 * Two flat signals rather than one-per-player, which is the opposite of what
 * `state/entities.ts` does for Home Assistant — and deliberately so. A house
 * has hundreds of entities and a handful of speakers, so the per-entity signal
 * that stops a temperature sensor waking the whole dashboard is unnecessary
 * here, and a player's now-playing metadata changes as a unit anyway.
 *
 * The backend already coalesces bursts, so these update at most every ~120 ms
 * even while six speakers start together.
 */

export const players = signal<Player[]>([]);
export const queues = signal<PlayerQueue[]>([]);

/**
 * Music services the household has — Sonos Radio, Plex, SoundCloud, Spotify.
 *
 * Given by the backend rather than discovered here: which services exist and
 * whether each is connected are facts about the household and about stored
 * credentials, and a wall panel should be told them rather than work them out.
 */
export const sources = signal<MusicSource[]>([]);

export function setPlayers(next: Player[], nextQueues: PlayerQueue[]): void {
  players.value = next;
  queues.value = nextQueues;
}

/** The queue driving a player, if we know it. */
export function queueOf(player: Player | undefined): PlayerQueue | null {
  if (!player?.queueId) return null;
  return queues.value.find((q) => q.id === player.queueId) ?? null;
}
