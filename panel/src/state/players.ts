import { signal } from '@preact/signals';
import type { MassPlayer, MassQueue } from '@shared/protocol.ts';

/**
 * Music Assistant's speakers and queues, as the backend last described them.
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

export const players = signal<MassPlayer[]>([]);
export const queues = signal<MassQueue[]>([]);

export function setPlayers(next: MassPlayer[], nextQueues: MassQueue[]): void {
  players.value = next;
  queues.value = nextQueues;
}

/** The queue driving a player, if we know it. */
export function queueOf(player: MassPlayer | undefined): MassQueue | null {
  if (!player?.queueId) return null;
  return queues.value.find((q) => q.id === player.queueId) ?? null;
}
