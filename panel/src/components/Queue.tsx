import { useCallback, useEffect, useState } from 'preact/hooks';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { browse } from '~/net/socket.ts';
import { Artwork } from '~/components/Artwork.tsx';
import { queues } from '~/state/players.ts';
import { formatDuration } from '~/lib/format.ts';
import * as act from '~/state/actions.ts';
import { BROWSE_PAGE, type QueueEntry, type QueuePage } from '@shared/protocol.ts';

/**
 * The queue — the thing this app opened a direct Music Assistant connection
 * for.
 *
 * Home Assistant's Music Assistant integration can tell you the current track,
 * the next track and a count. It cannot list the queue, and it has no service
 * to reorder, remove or jump within it. All of that lives on Music Assistant's
 * own API, so all of it lives here.
 *
 * ## Reordering without dragging
 *
 * Up, down and "play next" as buttons, for the same reason the player list
 * uses tap-to-assign: RoomOS reorders touch events unpredictably
 * (docs/ROOMOS.md §5) and HTML drag-and-drop never fires on touch, so a drag
 * has to be hand-tracked and can lose the gesture halfway — while standing at
 * a wall, reaching up. A button cannot be half-done.
 */
export function Queue({
  playerId,
  queueId,
  onClose,
}: {
  /** The speaker. Every command is addressed to it, never to the queue. */
  playerId: string;
  /** The queue to LIST. Only browsing needs this; see state/actions.ts. */
  queueId: string;
  onClose: () => void;
}) {
  const [page, setPage] = useState<QueuePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);

  /*
   * Reload whenever Music Assistant says this queue changed.
   *
   * `count` and `index` come from the players push, which Music Assistant
   * sends the instant anything touches the queue — including from the phone
   * in someone else's hand. Keying the effect on them means an edit made
   * anywhere refreshes these rows, with no polling.
   */
  const live = queues.value.find((q) => q.id === queueId);
  const version = `${live?.count ?? 0}:${live?.index ?? -1}`;

  const load = useCallback(
    (at: number, stale?: () => boolean) => {
      setLoading(true);
      browse({ kind: 'queue', queueId, offset: at })
        .then((r) => {
          if (stale?.()) return;
          if (r.kind === 'queuePage') setPage(r);
          setError(null);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (stale?.()) return;
          setError(err instanceof Error ? err.message : 'Could not load the queue');
          setLoading(false);
        });
    },
    [queueId],
  );

  useEffect(() => {
    let dead = false;
    load(offset, () => dead);
    return () => {
      dead = true;
    };
  }, [load, offset, version]);

  const entries = page?.entries ?? [];
  const total = page?.total ?? 0;
  const current = page?.current ?? null;

  return (
    <div class="sheet-layer">
      <div class="sheet-scrim" onPointerDown={onClose} />

      <div class="sheet queue-sheet" role="dialog" aria-label="Queue" aria-modal="true">
        <div class="sheet-head">
          <div class="sheet-titles">
            <h2 class="sheet-title truncate">Queue</h2>
            <div class="sheet-subtitle truncate">
              {total === 1 ? '1 track' : `${total} tracks`}
            </div>
          </div>
          {total > 0 ? (
            <Pressable
              class="sheet-edit p-sm"
              onPress={() => setConfirmClear(true)}
              ariaLabel="Clear the queue"
            >
              Clear
            </Pressable>
          ) : null}
          <Pressable class="sheet-close p-sm" onPress={onClose} ariaLabel="Close">
            <Icon name="close" size="1.4rem" weight={2} />
          </Pressable>
        </div>

        <div class="sheet-body scroll">
          {loading && entries.length === 0 ? (
            <div class="browse-state">
              <div class="spinner" aria-label="Loading" />
            </div>
          ) : error ? (
            <div class="browse-state">
              <Icon name="alert" size="2rem" weight={1.6} />
              <p class="browse-state-title">{error}</p>
            </div>
          ) : entries.length === 0 ? (
            <div class="browse-state">
              <Icon name="list" size="2rem" weight={1.6} />
              <p class="browse-state-title">Nothing queued</p>
              <p class="browse-state-hint">Anything you play from Browse lands here.</p>
            </div>
          ) : (
            entries.map((entry) => (
              <QueueRow
                key={entry.id}
                entry={entry}
                playing={entry.index === current}
                playerId={playerId}
              />
            ))
          )}
        </div>

        {offset > 0 || total > offset + entries.length ? (
          <div class="browse-pager">
            <Pressable
              class="pager-btn"
              onPress={() => setOffset(Math.max(0, offset - BROWSE_PAGE))}
              disabled={offset === 0}
              ariaLabel="Previous page"
            >
              <Icon name="chevronLeft" size="1.1rem" weight={2.2} />
              <span>Back</span>
            </Pressable>
            <span class="pager-count">
              {offset + 1}–{offset + entries.length} of {total}
            </span>
            <Pressable
              class="pager-btn"
              onPress={() => setOffset(offset + BROWSE_PAGE)}
              disabled={total <= offset + entries.length}
              ariaLabel="Next page"
            >
              <span>More</span>
              <Icon name="chevronRight" size="1.1rem" weight={2.2} />
            </Pressable>
          </div>
        ) : null}
      </div>

      {confirmClear ? (
        <div class="sheet-layer is-nested">
          <div class="sheet-scrim" onPointerDown={() => setConfirmClear(false)} />
          <div class="sheet play-sheet" role="dialog" aria-label="Clear the queue" aria-modal="true">
            <div class="sheet-head">
              <div class="sheet-titles">
                <h2 class="sheet-title">Clear the queue?</h2>
                <div class="sheet-subtitle">
                  {total === 1 ? '1 track' : `${total} tracks`} will be removed and playback stops.
                </div>
              </div>
            </div>
            <div class="sheet-body">
              {/* Confirmed rather than immediate: it is one tap from a list you
                  were scrolling, it stops the music, and there is no undo. */}
              <Pressable
                class="play-option is-danger"
                onPress={() => {
                  act.clearQueue(playerId);
                  setConfirmClear(false);
                  onClose();
                }}
                ariaLabel="Clear the queue"
              >
                <Icon name="close" size="1.3rem" weight={2.2} />
                <span>Clear the queue</span>
              </Pressable>
              <Pressable
                class="play-option"
                onPress={() => setConfirmClear(false)}
                ariaLabel="Keep the queue"
              >
                <span>Keep it</span>
              </Pressable>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function QueueRow({
  entry,
  playing,
  playerId,
}: {
  entry: QueueEntry;
  playing: boolean;
  playerId: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div class={playing ? 'queue-row is-playing' : 'queue-row'}>
      <Pressable
        as="div"
        class="queue-main"
        onPress={() => act.playQueueIndex(playerId, entry.index)}
        ariaLabel={`Play ${entry.name}`}
      >
        <Artwork src={entry.art} icon={playing ? 'play' : 'media'} />

        <div class="browse-meta">
          <div class="browse-name truncate">{entry.name}</div>
          <div class="browse-sub truncate">{entry.sub ?? ' '}</div>
        </div>

        {entry.duration ? (
          <span class="queue-time">{formatDuration(entry.duration)}</span>
        ) : null}
      </Pressable>

      <Pressable
        class="queue-more p-sm"
        onPress={() => setOpen((v) => !v)}
        ariaPressed={open}
        ariaLabel={`Options for ${entry.name}`}
      >
        <Icon name="dots" size="1.2rem" weight={2} />
      </Pressable>

      {open ? (
        <div class="queue-actions">
          <Pressable
            class="move-chip"
            onPress={() => act.moveQueueItem(playerId, entry.id, -1)}
            ariaLabel="Move up"
          >
            <Icon name="chevronUp" size="1rem" weight={2.2} />
            <span>Up</span>
          </Pressable>
          <Pressable
            class="move-chip"
            onPress={() => act.moveQueueItem(playerId, entry.id, 1)}
            ariaLabel="Move down"
          >
            <Icon name="chevronDown" size="1rem" weight={2.2} />
            <span>Down</span>
          </Pressable>
          <Pressable
            class="move-chip"
            onPress={() => act.moveQueueItemNext(playerId, entry.id)}
            ariaLabel="Play next"
          >
            <Icon name="next" size="1rem" weight={2} />
            <span>Play next</span>
          </Pressable>
          <Pressable
            class="move-chip is-danger"
            onPress={() => act.removeQueueItem(playerId, entry.id)}
            ariaLabel={`Remove ${entry.name}`}
          >
            <Icon name="close" size="1rem" weight={2.2} />
            <span>Remove</span>
          </Pressable>
        </div>
      ) : null}
    </div>
  );
}
