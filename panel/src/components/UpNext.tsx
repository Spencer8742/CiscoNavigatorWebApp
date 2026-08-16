import { useEffect, useState } from 'preact/hooks';
import { Icon } from '~/components/Icon.tsx';
import { browse } from '~/net/socket.ts';
import { attrString } from '~/domains/registry.ts';
import { isMusicAssistantPlayer, type EntityState, type QueueInfo } from '@shared/protocol.ts';

/**
 * What is queued after the current track.
 *
 * ## Why this is not a full queue screen
 *
 * Music Assistant's Home Assistant integration exposes `get_queue`, and that
 * service returns the queue's *summary*: how many items it holds, which one is
 * playing, and which one is next. It does not return the list, and there is no
 * service to reorder, remove or jump within it — those live only on Music
 * Assistant's own WebSocket API, which this app deliberately does not open a
 * second connection to.
 *
 * So rather than fake a queue that could be shown but not edited, this shows
 * exactly what Home Assistant actually knows: what is next, and how much is
 * left. Everything on it is real.
 */
export function UpNext({ playerId, state }: { playerId: string; state: EntityState }) {
  const [queue, setQueue] = useState<QueueInfo | null>(null);

  /*
   * Refetch when the track changes, not on a timer.
   *
   * `media_content_id` moving is the signal that the queue advanced, and it
   * arrives on the existing entity subscription — so this costs one request
   * per track rather than one every few seconds forever on a panel that is
   * mostly showing a screensaver.
   */
  const track = attrString(state, 'media_content_id') ?? attrString(state, 'media_title') ?? '';
  const playing = state.s === 'playing' || state.s === 'paused' || state.s === 'buffering';
  const isMa = isMusicAssistantPlayer(playerId, state);

  useEffect(() => {
    if (!isMa || !playing) {
      setQueue(null);
      return;
    }

    let stale = false;
    browse({ kind: 'queue', entity: playerId })
      .then((r) => {
        if (!stale && r.kind === 'queue') setQueue(r);
      })
      .catch(() => {
        // Silent. This is a supplementary readout, and a player that cannot
        // answer should leave the Now Playing screen exactly as it was rather
        // than putting an error under it.
        if (!stale) setQueue(null);
      });

    return () => {
      stale = true;
    };
  }, [playerId, track, playing, isMa]);

  if (!queue || !queue.next) return null;

  // "3 items" while the count includes the one playing would read as a lie
  // once you have counted the rows you can see.
  const remaining = queue.index === null ? queue.items : Math.max(0, queue.items - queue.index - 1);

  return (
    <div class="up-next">
      <div class="up-next-head">
        <Icon name="list" size="1rem" weight={1.9} />
        <span>Up next</span>
        {remaining > 1 ? <span class="up-next-count">{remaining} in queue</span> : null}
      </div>
      <div class="up-next-title truncate">{queue.next.n}</div>
      {queue.next.s ? <div class="up-next-sub truncate">{queue.next.s}</div> : null}
    </div>
  );
}
