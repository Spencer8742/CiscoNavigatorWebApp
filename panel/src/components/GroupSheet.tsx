import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Slider } from '~/components/Slider.tsx';
import { entity } from '~/state/entities.ts';
import { joinableSpeakers, speakerGroups, type SpeakerInfo } from '~/state/selectors.ts';
import { groupMembers } from '@shared/protocol.ts';
import * as act from '~/state/actions.ts';

/**
 * Speaker grouping, Sonos-style.
 *
 * Every join and unjoin here is a standard Home Assistant service call that
 * Music Assistant implements. This component holds **no grouping state of its
 * own** — what it draws comes from the `group_members` attribute Music
 * Assistant maintains, which is why grouping the same speakers from a Home
 * Assistant dashboard, the Music Assistant app or a voice assistant shows up
 * here immediately and without a refresh.
 *
 * `media_player.join` replaces the membership rather than appending to it, so
 * both adding and removing a speaker are the same call with a different list.
 * That is also why there is no Save button: each tap is already a complete,
 * self-contained instruction.
 */
export function GroupSheet({
  leader,
  onSelect,
  onClose,
}: {
  leader: string;
  /** Make another player (or a Music Assistant group) the active one. */
  onSelect: (entityId: string) => void;
  onClose: () => void;
}) {
  const leaderState = entity(leader).value;
  const members = groupMembers(leaderState);
  // A player on its own reports no members at all rather than a list of one.
  const active = members.length > 0 ? members : [leader];

  const candidates = joinableSpeakers.value;
  const groups = speakerGroups.value;

  const toggle = (speaker: SpeakerInfo): void => {
    if (speaker.id === leader) return; // the leader cannot leave its own group

    if (active.includes(speaker.id)) {
      // Removing: unjoin the speaker itself. Sending the leader a shorter
      // list would work too, but unjoin is what Music Assistant models as
      // "this speaker leaves", and it does the right thing if the leader has
      // changed underneath us.
      act.unjoinPlayer(speaker.id);
    } else {
      act.joinPlayers(leader, [...active, speaker.id]);
    }
  };

  return (
    <div class="sheet-scrim" onPointerDown={onClose}>
      <div
        class="sheet group-sheet"
        role="dialog"
        aria-label="Group players"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div class="sheet-head">
          <h2 class="sheet-title">Group Players</h2>
          <Pressable class="sheet-close p-sm" onPress={onClose} ariaLabel="Close">
            <Icon name="close" size="1.3rem" weight={2} />
          </Pressable>
        </div>

        <div class="sheet-body scroll">
          <div class="group-section">Playing on</div>
          {active.map((id) => {
            const speaker = candidates.find((s) => s.id === id);
            return (
              <SpeakerRow
                key={id}
                id={id}
                speaker={speaker}
                selected
                isLeader={id === leader}
                onToggle={() => speaker && toggle(speaker)}
              />
            );
          })}

          {candidates.some((s) => !active.includes(s.id)) ? (
            <>
              <div class="group-section">Add speakers</div>
              {candidates
                .filter((s) => !active.includes(s.id))
                .map((s) => (
                  <SpeakerRow
                    key={s.id}
                    id={s.id}
                    speaker={s}
                    selected={false}
                    isLeader={false}
                    onToggle={() => toggle(s)}
                  />
                ))}
            </>
          ) : null}

          {active.length > 1 ? (
            <>
              <div class="group-section">Volume</div>
              <GroupVolume members={active} />
              {active.map((id) => (
                <MemberVolume key={id} id={id} />
              ))}
            </>
          ) : null}

          {groups.length > 0 ? (
            <>
              <div class="group-section">Music Assistant groups</div>
              {groups.map((g) => (
                <Pressable
                  key={g.id}
                  as="div"
                  class="speaker-row"
                  onPress={() => {
                    onSelect(g.id);
                    onClose();
                  }}
                  ariaLabel={g.name}
                  disabled={!g.available}
                >
                  <div class="speaker-icon">
                    <Icon name="speaker" size="1.4rem" weight={1.7} />
                  </div>
                  <div class="speaker-meta">
                    <div class="speaker-name truncate">{g.name}</div>
                    <div class="speaker-sub truncate">
                      {g.members.length > 0 ? `${g.members.length} speakers` : 'Group'}
                    </div>
                  </div>
                  <Icon name="next" size="1.1rem" weight={2} />
                </Pressable>
              ))}
            </>
          ) : null}

        </div>
      </div>
    </div>
  );
}

/**
 * One speaker, as a full-width row.
 *
 * A row rather than a checkbox: this is a wall panel, and a 44px tick box is
 * a miss waiting to happen. The whole row is the target, and the tick on the
 * right is feedback rather than the thing you aim at.
 */
function SpeakerRow({
  id,
  speaker,
  selected,
  isLeader,
  onToggle,
}: {
  id: string;
  speaker: SpeakerInfo | undefined;
  selected: boolean;
  isLeader: boolean;
  onToggle: () => void;
}) {
  const state = entity(id).value;
  const name = speaker?.name ?? id.replace('media_player.', '').replace(/_/g, ' ');
  const available = speaker?.available ?? state !== null;
  const volume = speaker?.volume;

  const detail = !available
    ? 'Unavailable'
    : [
        isLeader ? 'Playing from here' : selected ? 'Grouped' : 'Available',
        volume != null ? `${Math.round(volume * 100)}%` : null,
      ]
        .filter(Boolean)
        .join(' · ');

  return (
    <Pressable
      as="div"
      class={selected ? 'speaker-row is-selected' : 'speaker-row'}
      onPress={onToggle}
      ariaPressed={selected}
      ariaLabel={name}
      // The leader is not removable — you would be asking the group to stop
      // playing from the thing you are looking at.
      disabled={!available || isLeader}
    >
      <div class="speaker-icon" data-on={selected ? '' : undefined}>
        <Icon name="speaker" size="1.4rem" weight={1.7} />
      </div>
      <div class="speaker-meta">
        <div class="speaker-name truncate">{name}</div>
        <div class="speaker-sub truncate">{detail}</div>
      </div>
      {selected ? (
        <div class="speaker-check">
          <Icon name="check" size="1.2rem" weight={2.4} />
        </div>
      ) : null}
    </Pressable>
  );
}

/**
 * One slider for the whole group.
 *
 * Music Assistant only publishes a `group_volume` for its *permanent* group
 * players; an ad-hoc join has no such entity, so there is nothing to point a
 * slider at. This moves every member by the same OFFSET instead, which is
 * what Sonos does and the only version that is any use: setting them all to
 * one level would flatten a balance the user just spent time setting.
 *
 * The readout is the average, so the handle sits where the group "is".
 */
function GroupVolume({ members }: { members: string[] }) {
  const levels = members.map((id) => {
    const v = entity(id).value?.a['volume_level'];
    return typeof v === 'number' ? v : 0;
  });
  const average = levels.reduce((a, b) => a + b, 0) / (levels.length || 1);

  return (
    <div class="member-volume is-group">
      <div class="member-volume-name truncate">All speakers</div>
      <Slider
        value={average}
        min={0}
        max={1}
        step={0.01}
        ariaLabel="Group volume"
        readout={`${Math.round(average * 100)}%`}
        onChange={(v, final) => {
          const delta = v - average;
          members.forEach((id, i) => {
            const next = Math.min(1, Math.max(0, (levels[i] ?? 0) + delta));
            act.setVolume(id, next, final);
          });
        }}
      />
    </div>
  );
}

/** Per-speaker volume, so a group can be balanced without breaking it. */
function MemberVolume({ id }: { id: string }) {
  const state = entity(id).value;
  const level = typeof state?.a['volume_level'] === 'number' ? state.a['volume_level'] : 0;
  const name = state ? (state.a['friendly_name'] as string | undefined) : undefined;

  return (
    <div class="member-volume">
      <div class="member-volume-name truncate">
        {name ?? id.replace('media_player.', '').replace(/_/g, ' ')}
      </div>
      <Slider
        value={level}
        min={0}
        max={1}
        step={0.01}
        ariaLabel={`${name ?? id} volume`}
        readout={`${Math.round(level * 100)}%`}
        onChange={(v, final) => act.setVolume(id, v, final)}
      />
    </div>
  );
}
