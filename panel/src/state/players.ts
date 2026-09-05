import { signal } from '@preact/signals';
import type { Player, PlayerQueue } from '@shared/protocol.ts';

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

export function setPlayers(next: Player[], nextQueues: PlayerQueue[]): void {
  players.value = next;
  queues.value = nextQueues;
}

/** The queue driving a player, if we know it. */
export function queueOf(player: Player | undefined): PlayerQueue | null {
  if (!player?.queueId) return null;
  return queues.value.find((q) => q.id === player.queueId) ?? null;
}
