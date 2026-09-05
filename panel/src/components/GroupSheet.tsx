import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Slider } from '~/components/Slider.tsx';
import { speakers, speakerGroups, type SpeakerInfo } from '~/state/selectors.ts';
import * as act from '~/state/actions.ts';

/**
 * Speaker grouping, Sonos-style.
 *
 * Every join and separate here is a command sent straight to the speakers.
 * This component holds **no grouping state of its own** — what it draws is
 * what the household says the groups are, which is why grouping done in the
 * Sonos app, a Home Assistant dashboard or by
 * voice shows up here immediately and without a refresh.
 *
 * `players/cmd/set_members` replaces the membership rather than appending to
 * it, so adding and removing a speaker are the same call with a different
 * list. That is also why there is no Save button: each tap is already a
 * complete, self-contained instruction.
 *
 * Which speakers may be grouped is the household's answer, not a guess:
 * `can_group_with` is exact, and a Chromecast that genuinely cannot sync with
 * a Sonos is never offered.
 */
export function GroupSheet({
  leader,
  onSelect,
  onClose,
}: {
  leader: string;
  /** Make another player (or a group) the active one. */
  onSelect: (playerId: string) => void;
  onClose: () => void;
}) {
  const all = speakers.value;
  const leaderInfo = all.find((s) => s.id === leader);
  // A player on its own reports no members at all rather than a list of one.
  const active = leaderInfo && leaderInfo.members.length > 0 ? leaderInfo.members : [leader];

  /*
   * Only speakers the household says this leader can sync with. An entire
   * provider may be named instead of individual players, which is Music
   * Assistant's shorthand for "everything of this kind groups together".
   */
  const canGroupWith = new Set(leaderInfo?.canGroupWith ?? []);
  const candidates = all.filter(
    (s) => !s.isGroup && s.id !== leader && (canGroupWith.has(s.id) || canGroupWith.size === 0),
  );

  const groups = speakerGroups.value;

  const toggle = (speaker: SpeakerInfo): void => {
    if (speaker.id === leader) return; // the leader cannot leave its own group

    if (active.includes(speaker.id)) {
      // Removing: take that speaker out. Sending the leader a shorter list
      // works too, but ungroup is what the backend models as "this
      // speaker leaves" and does the right thing if the leader changed
      // underneath us.
      act.unjoinPlayer(speaker.id);
    } else {
      act.setGroupMembers(leader, [...active, speaker.id]);
    }
  };

  const byId = (id: string): SpeakerInfo | undefined => all.find((s) => s.id === id);

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
          {active.map((id) => (
            <SpeakerRow
              key={id}
              id={id}
              speaker={byId(id)}
              selected
              isLeader={id === leader}
              onToggle={() => {
                const s = byId(id);
                if (s) toggle(s);
              }}
            />
          ))}

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
              <GroupVolume members={active.map(byId).filter((s): s is SpeakerInfo => !!s)} />
              {active.map((id) => {
                const s = byId(id);
                return s ? <MemberVolume key={id} speaker={s} /> : null;
              })}
            </>
          ) : null}

          {groups.length > 0 ? (
            <>
              <div class="group-section">Groups</div>
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
  const name = speaker?.name ?? id;
  const available = speaker?.available ?? false;

  const detail = !available
    ? 'Unavailable'
    : [
        isLeader ? 'Playing from here' : selected ? 'Grouped' : 'Available',
        speaker?.volume != null ? `${speaker.volume}%` : null,
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
 * Moves every member by the same OFFSET rather than setting them all to one
 * level, which is what Sonos does and the only version that is any use:
 * setting them all to the same number would flatten a balance the user just
 * spent time getting right.
 *
 * The readout is the average, so the handle sits where the group "is".
 */
function GroupVolume({ members }: { members: SpeakerInfo[] }) {
  const levels = members.map((s) => s.volume ?? 0);
  const average = levels.reduce((a, b) => a + b, 0) / (levels.length || 1);

  return (
    <div class="member-volume is-group">
      <div class="member-volume-name truncate">All speakers</div>
      <Slider
        value={Math.round(average)}
        ariaLabel="Group volume"
        readout={`${Math.round(average)}%`}
        onChange={(v, final) => {
          const delta = v - average;
          members.forEach((s, i) => {
            act.setVolume(s.id, Math.min(100, Math.max(0, (levels[i] ?? 0) + delta)), final);
          });
        }}
      />
    </div>
  );
}

/** Per-speaker volume, so a group can be balanced without breaking it. */
function MemberVolume({ speaker }: { speaker: SpeakerInfo }) {
  const level = speaker.volume ?? 0;

  return (
    <div class="member-volume">
      <div class="member-volume-name truncate">{speaker.name}</div>
      <Slider
        value={level}
        ariaLabel={`${speaker.name} volume`}
        readout={`${level}%`}
        onChange={(v, final) => act.setVolume(speaker.id, v, final)}
      />
    </div>
  );
}
