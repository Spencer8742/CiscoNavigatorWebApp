import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Slider } from '~/components/Slider.tsx';
import * as act from '~/state/actions.ts';
import type { SpeakerInfo } from '~/state/selectors.ts';

/**
 * The rest of what the Sonos app can do to a speaker.
 *
 * Everything here is real but occasional — you set the bass in a room once and
 * then never again, and the sleep timer at bedtime. Putting them behind one
 * more tap keeps the Media screen to the things somebody reaches for while
 * standing in front of it: what is playing, how loud, and where.
 *
 * ## What is per speaker and what is per group
 *
 * Tone is per SPEAKER, because it describes the room the speaker stands in —
 * a kitchen and a bathroom grouped together want different bass and the same
 * music. Sleep, crossfade and group volume are per GROUP, because they are
 * facts about the music rather than about a room. The headings say so rather
 * than leaving somebody to discover it by being surprised.
 */

/** The offers on the sleep row. Sonos's own app uses roughly these. */
const SLEEP_MINUTES = [15, 30, 45, 60];

export function SpeakerSheet({
  player,
  grouped,
  onClose,
}: {
  player: SpeakerInfo;
  /** True when this speaker leads or belongs to a group of more than one. */
  grouped: boolean;
  onClose: () => void;
}) {
  const sleeping = player.sleepAt !== null && player.sleepAt > Date.now();

  return (
    <div class="sheet-layer">
      <div class="sheet-scrim" onPointerDown={onClose} />
      <div class="sheet" role="dialog" aria-label={`${player.name} settings`} aria-modal="true">
        <div class="sheet-head">
          <div class="sheet-titles">
            <h2 class="sheet-title truncate">{player.name}</h2>
            <div class="sheet-subtitle truncate">Sound and timers</div>
          </div>
          <Pressable class="sheet-close p-sm" onPress={onClose} ariaLabel="Close">
            <Icon name="close" size="1.4rem" weight={2} />
          </Pressable>
        </div>

        <div class="sheet-body scroll">
          {/*
            Group volume, only when there is a group. Sonos scales the members
            proportionally, so a speaker somebody turned down on purpose stays
            quieter than the rest — which is exactly what setting each one in
            turn would destroy.
          */}
          {grouped && player.groupVolume !== null ? (
            <>
              <h3 class="section-title">All rooms</h3>
              <div class="tone-row">
                <Icon name="volume" size="1.2rem" />
                <Slider
                  value={player.groupVolume}
                  ariaLabel="Group volume"
                  readout={`${player.groupVolume}%`}
                  onChange={(v, final) => act.setGroupVolume(player.id, v, final)}
                />
              </div>
            </>
          ) : null}

          <h3 class="section-title">Sound in this room</h3>

          <div class="tone-row">
            <span class="tone-label">Bass</span>
            <Slider
              value={player.bass ?? 0}
              min={-10}
              max={10}
              ariaLabel="Bass"
              readout={signed(player.bass)}
              onChange={(v, final) => act.setTone(player.id, 'bass', v, final)}
            />
          </div>

          <div class="tone-row">
            <span class="tone-label">Treble</span>
            <Slider
              value={player.treble ?? 0}
              min={-10}
              max={10}
              ariaLabel="Treble"
              readout={signed(player.treble)}
              onChange={(v, final) => act.setTone(player.id, 'treble', v, final)}
            />
          </div>

          <Pressable
            class={player.loudness ? 'sheet-toggle is-on' : 'sheet-toggle'}
            onPress={() => act.setLoudness(player.id, !player.loudness)}
            ariaPressed={player.loudness ?? false}
            ariaLabel="Loudness"
          >
            <span>Loudness</span>
            <span class="sheet-toggle-state">{player.loudness ? 'On' : 'Off'}</span>
          </Pressable>

          <h3 class="section-title">Sleep timer</h3>

          <div class="sleep-row">
            {SLEEP_MINUTES.map((m) => (
              <Pressable
                key={m}
                class="sleep-option"
                onPress={() => act.setSleep(player.id, m)}
                ariaLabel={`Sleep in ${m} minutes`}
              >
                {m}m
              </Pressable>
            ))}
            <Pressable
              class={sleeping ? 'sleep-option is-on' : 'sleep-option'}
              onPress={() => act.setSleep(player.id, 0)}
              ariaLabel="Cancel sleep timer"
            >
              Off
            </Pressable>
          </div>

          {sleeping ? (
            <p class="sleep-hint">Stops in about {minutesLeft(player.sleepAt)} minutes.</p>
          ) : null}

          {/*
            Physical inputs. Offered to every speaker rather than only to the
            ones that have them, because knowing which do would mean a table of
            every Sonos model ever made — the speaker's own refusal is both
            accurate and permanently up to date.
          */}
          <h3 class="section-title">Input</h3>

          <div class="sleep-row">
            <Pressable
              class="sleep-option"
              onPress={() => act.setInput(player.id, 'tv')}
              ariaLabel="Play the TV input"
            >
              TV
            </Pressable>
            <Pressable
              class="sleep-option"
              onPress={() => act.setInput(player.id, 'line')}
              ariaLabel="Play the line-in input"
            >
              Line-in
            </Pressable>
            <Pressable
              class="sleep-option"
              onPress={() => act.setInput(player.id, 'queue')}
              ariaLabel="Back to the queue"
            >
              Queue
            </Pressable>
          </div>
        </div>
      </div>
    </div>
  );
}

/** `+3`, `−4`, `0`. The sign is the whole information in a tone control. */
function signed(value: number | null): string {
  if (value === null) return '—';
  if (value === 0) return '0';
  // A real minus sign, not a hyphen: it lines up with the digits.
  return value > 0 ? `+${value}` : `−${Math.abs(value)}`;
}

function minutesLeft(at: number | null): number {
  if (at === null) return 0;
  return Math.max(1, Math.round((at - Date.now()) / 60_000));
}
