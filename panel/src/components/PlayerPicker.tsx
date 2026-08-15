import { useState } from 'preact/hooks';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { mediaConfig } from '~/config/index.ts';
import { prefs } from '~/state/ui.ts';
import { setPlayerLayout } from '~/net/socket.ts';
import {
  hiddenSpeakers,
  speakerSections,
  type SpeakerInfo,
} from '~/state/selectors.ts';
import type { PlayerLayout } from '@shared/protocol.ts';

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
  const [editing, setEditing] = useState(false);
  const sections = speakerSections.value;
  const hidden = hiddenSpeakers.value;
  const names = mediaConfig.value.sections;

  /**
   * Move a speaker to a section, to Hidden, or up/down within its section.
   *
   * Every one of these produces a COMPLETE layout and sends that. Building the
   * whole arrangement each time is a few lines and removes an entire class of
   * bug: there is no incremental state on either side to drift.
   */
  const rearrange = (fn: (draft: PlayerLayout) => void): void => {
    const current = prefs.value.players;
    // Start from what is on screen, not from the stored layout: unfiled
    // speakers are only implicitly in the first section, and a move would
    // otherwise silently reshuffle everything that had never been filed.
    const draft: PlayerLayout = {
      sections: Object.fromEntries(names.map((n) => [n, [] as string[]])),
      hidden: [...current.hidden],
    };
    for (const section of sections) {
      draft.sections[section.name] = section.players.map((p) => p.id);
    }
    fn(draft);
    setPlayerLayout(draft);
  };

  const remove = (draft: PlayerLayout, id: string): void => {
    for (const key of Object.keys(draft.sections)) {
      draft.sections[key] = (draft.sections[key] ?? []).filter((x) => x !== id);
    }
    draft.hidden = draft.hidden.filter((x) => x !== id);
  };

  const moveTo = (id: string, section: string | null): void =>
    rearrange((draft) => {
      remove(draft, id);
      if (section === null) draft.hidden.push(id);
      else (draft.sections[section] ??= []).push(id);
    });

  const nudge = (id: string, section: string, by: -1 | 1): void =>
    rearrange((draft) => {
      const list = draft.sections[section] ?? [];
      const i = list.indexOf(id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j] as string, list[i] as string];
    });

  return (
    <div class="sheet-scrim" onPointerDown={onClose}>
      <div
        class="sheet group-sheet"
        role="dialog"
        aria-label="Choose a player"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div class="sheet-head">
          <h2 class="sheet-title">{editing ? 'Organize' : 'Players'}</h2>
          <Pressable
            class="sheet-edit p-sm"
            onPress={() => setEditing((v) => !v)}
            ariaLabel={editing ? 'Done organizing' : 'Organize players'}
          >
            {editing ? 'Done' : 'Organize'}
          </Pressable>
          <Pressable class="sheet-close p-sm" onPress={onClose} ariaLabel="Close">
            <Icon name="close" size="1.3rem" weight={2} />
          </Pressable>
        </div>

        <div class="sheet-body scroll">
          {sections.map((section) => (
            <div key={section.name}>
              <div class="group-section">{section.name}</div>
              {section.players.map((s) => (
                <SpeakerRow
                  key={s.id}
                  speaker={s}
                  activeId={activeId}
                  editing={editing}
                  sectionNames={names}
                  currentSection={section.name}
                  onPick={() => {
                    onSelect(s.id);
                    onClose();
                  }}
                  onMove={(to) => moveTo(s.id, to)}
                  onNudge={(by) => nudge(s.id, section.name, by)}
                />
              ))}
            </div>
          ))}

          {editing && hidden.length > 0 ? (
            <>
              <div class="group-section">Hidden</div>
              {hidden.map((s) => (
                <SpeakerRow
                  key={s.id}
                  speaker={s}
                  activeId={activeId}
                  editing
                  sectionNames={names}
                  currentSection={null}
                  onPick={() => undefined}
                  onMove={(to) => moveTo(s.id, to)}
                  onNudge={() => undefined}
                />
              ))}
            </>
          ) : null}

          {editing ? (
            <p class="picker-hint">
              Tap a section name to move a speaker there, or <strong>Hide</strong> for
              anything that is not a speaker. Section names come from{' '}
              <code>media.sections</code> in <code>dashboard.yaml</code>.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * One speaker. Tapping picks it; in edit mode the row expands to show where
 * it can go.
 *
 * Assignment is tapping rather than dragging on purpose. RoomOS's touch layer
 * reorders events unpredictably (docs/ROOMOS.md §5) and HTML drag-and-drop
 * does not fire on touch at all, so a drag has to be hand-tracked and can
 * lose the gesture halfway — while standing at a wall, reaching up.
 */
function SpeakerRow({
  speaker,
  activeId,
  editing,
  sectionNames,
  currentSection,
  onPick,
  onMove,
  onNudge,
}: {
  speaker: SpeakerInfo;
  activeId: string;
  editing: boolean;
  sectionNames: string[];
  currentSection: string | null;
  onPick: () => void;
  onMove: (section: string | null) => void;
  onNudge: (by: -1 | 1) => void;
}) {
  const s = speaker;
  const active = s.id === activeId;

  if (!editing) {
    return (
      <Pressable
        as="div"
        class={active ? 'speaker-row is-selected' : 'speaker-row'}
        onPress={onPick}
        ariaPressed={active}
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
        {active ? (
          <div class="speaker-check">
            <Icon name="check" size="1.2rem" weight={2.4} />
          </div>
        ) : null}
      </Pressable>
    );
  }

  return (
    <div class="speaker-row is-editing">
      <div class="speaker-edit-head">
        <div class="speaker-icon">
          <Icon name="speaker" size="1.4rem" weight={1.7} />
        </div>
        <div class="speaker-meta">
          <div class="speaker-name truncate">{s.name}</div>
          <div class="speaker-sub truncate">{describeState(s)}</div>
        </div>
        {currentSection ? (
          <div class="speaker-nudge">
            <Pressable class="nudge-btn p-sm" onPress={() => onNudge(-1)} ariaLabel="Move up">
              <Icon name="chevronUp" size="1.1rem" weight={2.2} />
            </Pressable>
            <Pressable class="nudge-btn p-sm" onPress={() => onNudge(1)} ariaLabel="Move down">
              <Icon name="chevronDown" size="1.1rem" weight={2.2} />
            </Pressable>
          </div>
        ) : null}
      </div>

      <div class="speaker-move">
        {sectionNames.map((name) => (
          <Pressable
            key={name}
            class={name === currentSection ? 'move-chip is-active' : 'move-chip'}
            onPress={() => onMove(name)}
            ariaPressed={name === currentSection}
            ariaLabel={`Move to ${name}`}
          >
            {name}
          </Pressable>
        ))}
        <Pressable
          class={currentSection === null ? 'move-chip is-active' : 'move-chip'}
          onPress={() => onMove(null)}
          ariaPressed={currentSection === null}
          ariaLabel="Hide"
        >
          Hide
        </Pressable>
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
