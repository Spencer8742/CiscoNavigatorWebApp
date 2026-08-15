import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { speakers, type SpeakerInfo } from '~/state/selectors.ts';

/**
 * Which speaker the Media screen is showing.
 *
 * A list, not a row of chips. A real house has more speakers than fit across
 * a panel — twenty-seven in the case that prompted this — and wrapping them
 * cost three rows of the screen before you could see what was playing. It
 * also scaled badly in the wrong direction: the more speakers you own, the
 * less of the actual media player you could see.
 *
 * Anything making noise is listed first, because that is what you walked over
 * to deal with.
 */
export function PlayerPicker({
  activeId,
  onSelect,
  onClose,
}: {
  activeId: string;
  onSelect: (entityId: string) => void;
  onClose: () => void;
}) {
  const all = speakers.value;
  const players = all.filter((s) => !s.isGroup);
  const groups = all.filter((s) => s.isGroup);

  const byActivity = (list: SpeakerInfo[]): SpeakerInfo[] => {
    const rank = (s: SpeakerInfo): number => {
      if (s.state === 'playing') return 0;
      if (s.state === 'paused' || s.state === 'buffering') return 1;
      if (!s.available) return 3;
      return 2;
    };
    return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  };

  const row = (s: SpeakerInfo) => (
    <Pressable
      key={s.id}
      as="div"
      class={s.id === activeId ? 'speaker-row is-selected' : 'speaker-row'}
      onPress={() => {
        onSelect(s.id);
        onClose();
      }}
      ariaPressed={s.id === activeId}
      ariaLabel={s.name}
      disabled={!s.available}
    >
      <div class="speaker-icon" data-on={s.state === 'playing' ? '' : undefined}>
        <Icon name="speaker" size="1.4rem" weight={1.7} />
      </div>
      <div class="speaker-meta">
        <div class="speaker-name truncate">{s.name}</div>
        <div class="speaker-sub truncate">{describeState(s)}</div>
      </div>
      {s.id === activeId ? (
        <div class="speaker-check">
          <Icon name="check" size="1.2rem" weight={2.4} />
        </div>
      ) : null}
    </Pressable>
  );

  return (
    <div class="sheet-scrim" onPointerDown={onClose}>
      <div
        class="sheet group-sheet"
        role="dialog"
        aria-label="Choose a player"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div class="sheet-head">
          <h2 class="sheet-title">Players</h2>
          <Pressable class="sheet-close p-sm" onPress={onClose} ariaLabel="Close">
            <Icon name="close" size="1.3rem" weight={2} />
          </Pressable>
        </div>

        <div class="sheet-body scroll">
          {groups.length > 0 ? (
            <>
              <div class="group-section">Groups</div>
              {byActivity(groups).map(row)}
            </>
          ) : null}

          <div class="group-section">Speakers</div>
          {byActivity(players).map(row)}
        </div>
      </div>
    </div>
  );
}

/** "Playing · 35%", "Idle", "Unavailable". */
function describeState(s: SpeakerInfo): string {
  if (!s.available) return 'Unavailable';

  const what =
    s.state === 'playing'
      ? 'Playing'
      : s.state === 'paused'
        ? 'Paused'
        : s.state === 'off'
          ? 'Off'
          : 'Idle';

  const parts = [what];
  if (s.members.length > 1) parts.push(`${s.members.length} rooms`);
  if (s.volume != null) parts.push(`${Math.round(s.volume * 100)}%`);
  return parts.join(' · ');
}
