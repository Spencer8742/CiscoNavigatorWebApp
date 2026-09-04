import { Icon, hasIcon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Slider } from '~/components/Slider.tsx';
import { entity } from '~/state/entities.ts';
import { toggle, pressButton, setEntityNumber } from '~/state/actions.ts';
import { pressed } from '~/state/controls.ts';
import { pressControl } from '~/net/socket.ts';
import {
  dismissedJoin,
  health,
  kiosk,
  markActivity,
  openDeviceAlerts,
  openDeviceSource,
} from '~/state/ui.ts';
import { timeOpts } from '~/config/index.ts';
import { now } from '~/state/clock.ts';
import { formatTime, formatMeridiem, type TimeOpts } from '~/lib/format.ts';
import type { ControlButton, ControlDevice, DeviceEntities } from '@shared/config.ts';
import type { EntityState } from '@shared/protocol.ts';

/**
 * A RoomOS device — Desk Pro, Room Bar — as one tile.
 *
 * This is the one control on the panel that is not fire-and-forget. Every
 * Companion key says "the press was sent"; this reads the device back, so a
 * mute key can honestly show that the mic IS muted and the meeting list is
 * the device's own calendar rather than a guess. That is the whole reason it
 * replaces the Companion call keys instead of sitting beside them.
 *
 * The layout is the Home Assistant tile re-laid for a 1325x681 landscape
 * panel rather than copied: the meeting list is the tall thing and takes the
 * height, the controls sit to the right under the hand, and device
 * diagnostics go in a footer strip where they can be glanced at and ignored.
 *
 * Every control is independent and optional. A device with no calendar shows
 * no meeting list; one with no selfview shows three toggles. Nothing here
 * assumes a fully populated `entities` block, because a Room Kit Mini is not
 * a Desk Pro.
 */
export function DeviceTile({ item, compact }: { item: ControlDevice; compact?: boolean }) {
  const e = item.entities;
  const ids = Object.values(e);

  /*
   * True when Home Assistant is up and has NONE of this device's entities.
   *
   * The `health` test comes first deliberately, and not only for correctness:
   * `every` short-circuits, so a working tile reads exactly one entity signal
   * here and re-renders no more often than that one entity changes. Only the
   * broken case pays for reading all twenty-five.
   */
  const blind =
    ids.length > 0 &&
    health.value?.ha === 'connected' &&
    ids.every((id) => entity(id).value === null);

  return (
    <div class="devtile" data-compact={compact ? '' : undefined}>
      <Head item={item} />

      {/* When the tile is blind the meeting list is dropped rather than left
          saying "Waiting for Home Assistant" — it is not waiting, nothing is
          coming, and the space is better spent on the notice than on a
          placeholder that pushes the page's keys under the nav. */}
      {blind ? <Missing first={ids[0]!} /> : null}

      <div class="devtile-body">
        {e.meetings && !blind ? <Meetings entities={e} /> : null}
        <Controls entities={e} keys={item.keys} soloed={!e.meetings || blind} />
      </div>

      <Foot entities={e} />

      {/* Rendered by the tile, so it exists only while this device's page is
          the one on screen — a prompt about the Desk Pro has no business
          appearing over the Lights page. It covers the screen area rather
          than the whole viewport, which leaves the nav reachable when the
          panel is not locked. */}
      {blind ? null : <JoinPrompt entities={e} />}
    </div>
  );
}

/**
 * The five-minutes-to-go prompt.
 *
 * A badge on a row in a list is easy to walk past. This is the same offer
 * made unmissable, for the one moment it matters: somebody is at the desk and
 * a meeting is about to start.
 *
 * It takes itself away rather than needing to be managed. Four things close
 * it, and only one of them is the dismiss button:
 *
 *  - the meeting starts being joined (`inCall` goes on),
 *  - the meeting ends,
 *  - the device stops offering it as the joinable one,
 *  - or somebody says not now.
 *
 * The same honesty rule as the row badge applies: `join_next_meeting` takes
 * no argument, so if the device would dial a meeting that has already
 * finished, this offers nothing at all rather than naming one meeting and
 * starting another.
 */
function JoinPrompt({ entities: e }: { entities: DeviceEntities }) {
  const meetings = readMeetings(useState(e.meetings));
  const inCall = useState(e.inCall);
  const dismissed = dismissedJoin.value;
  const at = now.value;
  const t = timeOpts.value;

  if (!e.join || inCall?.s === 'on') return null;

  const target = meetings.find((m) => m.joinable);
  if (!target || isOver(target, at) || !isDue(target, at)) return null;
  if (dismissed === keyOf(target)) return null;

  return (
    <div class="joinprompt">
      <div class="joinprompt-card">
        <div class="joinprompt-when">
          <Icon name="clock" size="1rem" weight={1.9} />
          <span>{startsIn(target, at, t)}</span>
        </div>

        <div class="joinprompt-title">{target.title}</div>
        {target.organizer ? (
          <div class="joinprompt-org truncate">{target.organizer}</div>
        ) : null}

        <div class="joinprompt-actions">
          <Pressable
            class="joinprompt-join"
            tone="ok"
            onPress={() => {
              pressButton(e.join!);
              // Waved away as well as joined: the device takes a moment to
              // report the call, and the prompt should not sit there through
              // it looking as though the press did nothing.
              dismissedJoin.value = keyOf(target);
              markActivity();
            }}
            ariaLabel={`Join ${target.title}`}
          >
            <Icon name="camera" size="1.25rem" weight={1.8} />
            <span>Join</span>
          </Pressable>

          <Pressable
            class="joinprompt-later"
            onPress={() => {
              dismissedJoin.value = keyOf(target);
              markActivity();
            }}
            ariaLabel="Dismiss"
          >
            <span>Not now</span>
          </Pressable>
        </div>
      </div>
    </div>
  );
}

/** "Starts in 4 min" / "Started 10:30 AM" — never a bare countdown to zero. */
function startsIn(m: Meeting, at: Date, t: TimeOpts): string {
  const start = m.start_time ? Date.parse(m.start_time) : NaN;
  if (!Number.isFinite(start)) return 'Starting now';

  const mins = Math.round((start - at.getTime()) / 60_000);
  if (mins > 1) return `Starts in ${mins} min`;
  if (mins >= 0) return 'Starts now';
  // Already running. The clock is more use than "3 minutes ago" for somebody
  // working out whether they are the one holding it up.
  return `Started ${clockOf(m.start_time, t)}`;
}

/**
 * The "none of these entities exist" notice.
 *
 * The failure this exists for looks exactly like a tile that is still
 * loading: every control renders, nothing has state, and the meeting list
 * says "Waiting for Home Assistant" forever. The usual cause is a `prefix:`
 * that does not match the device's name in Home Assistant — the integration
 * builds entity ids from the device name, which is whatever the codec reports
 * as SystemUnit.Name, or its host address when that was never set.
 *
 * One id is named rather than all of them. It is the one thing that makes the
 * message actionable — it can be pasted into Developer Tools and compared —
 * and twenty-five of them would be a wall of text on a wall-mounted panel.
 */
function Missing({ first }: { first: string }) {
  return (
    <div class="devtile-missing">
      <Icon name="alert" size="1.125rem" weight={1.9} />
      {/* Kept to one line on a 1325px panel. The tile below is already at
          the height the screen allows, so every extra line of this notice
          pushes the page's own keys under the nav. */}
      <div>
        No entities for this device — no <code class="devtile-missing-id">{first}</code>.
        Set <code>prefix:</code> in <code>dashboard.yaml</code> to the device's name in
        Home Assistant.
      </div>
    </div>
  );
}

/* ── Header ───────────────────────────────────────────────────────────────*/

function Head({ item }: { item: ControlDevice }) {
  const e = item.entities;
  const standby = useState(e.standby);
  const noise = useState(e.noise);
  const people = useState(e.people);
  const sharing = useState(e.sharing);

  const awake = standby ? standby.s.toLowerCase() !== 'standby' : null;

  // Power is one key, not two: which button it presses is decided by what the
  // device says it is doing. Two keys labelled Wake and Standby would leave
  // one of them always wrong.
  const powerTarget = awake === false ? e.wake : e.sleep;
  const powerLabel = awake === false ? 'Wake' : 'Standby';

  const bits: string[] = [];
  if (standby && !unavailable(standby)) bits.push(titleCase(standby.s));
  if (noise && !unavailable(noise)) bits.push(`${noise.s} dBA`);

  return (
    <div class="devtile-head">
      <div class="devtile-name truncate">{item.name}</div>

      {bits.length > 0 ? (
        <div class="devtile-state">
          <span class="devtile-dot" data-awake={awake ? '' : undefined} />
          <span class="truncate">{bits.join(' · ')}</span>
        </div>
      ) : null}

      <div class="devtile-head-right">
        {people && !unavailable(people) ? (
          <div class="devtile-pill">
            <Icon name="people" size="1.0625rem" />
            <span class="tnum">{people.s}</span>
          </div>
        ) : null}

        {sharing?.s === 'on' ? (
          <div class="devtile-pill" data-on>
            <Icon name="share" size="1.0625rem" />
            <span>Sharing</span>
          </div>
        ) : null}

        {/* Full-screen lock, beside power because both are about the panel
            as a whole rather than about the call. Always rendered — it is
            the ONLY way back out once it is on, so it must never depend on
            anything the device happens to be reporting. */}
        <Pressable
          class="devtile-lock"
          onPress={() => {
            kiosk.value = !kiosk.value;
            markActivity();
          }}
          ariaLabel={kiosk.value ? 'Leave full screen' : 'Full screen, locked to this page'}
          ariaPressed={kiosk.value}
        >
          <Icon name={kiosk.value ? 'collapse' : 'expand'} size="1.375rem" weight={1.9} />
        </Pressable>

        {powerTarget ? (
          <Pressable
            class="devtile-power"
            onPress={() => {
              pressButton(powerTarget);
              markActivity();
            }}
            ariaLabel={powerLabel}
          >
            <Icon name="power" size="1.375rem" weight={1.9} />
          </Pressable>
        ) : null}
      </div>
    </div>
  );
}

/* ── Meetings ─────────────────────────────────────────────────────────────*/

interface Meeting {
  title: string;
  start_time?: string;
  /** Published by the integration alongside `start_time`; may be absent
      depending on which calendar service the device is paired with. */
  end_time?: string;
  organizer?: string;
  /**
   * NOT a statement about time. The integration sets this from whether the
   * booking carries a dialable callback number — a plain calendar block with
   * no video meeting is listed but not joinable. A meeting that finished
   * hours ago stays `joinable: true` for as long as the device lists it.
   */
  joinable?: boolean;
}

function Meetings({ entities: e }: { entities: DeviceEntities }) {
  const state = useState(e.meetings);
  const all = readMeetings(state);

  /*
   * Meetings that have already finished are dropped.
   *
   * The device lists a wide window — the integration asks for 100 days and
   * takes what the calendar has — and does not prune what has passed. So by
   * mid-morning the list still opens with the 9am booking, which is both
   * clutter and, worse, where the Join badge used to land: `joinable` means
   * "has a dial-in number", not "is happening", so a finished meeting held
   * the badge for the rest of the day.
   *
   * Ticks with the shared minute clock, so a meeting drops off the list as it
   * ends rather than whenever Home Assistant next says something.
   */
  const at = now.value;
  const meetings = all.filter((m) => !isOver(m, at));

  /*
   * Which row gets the Join badge — and whether one is honest at all.
   *
   * `join_next_meeting` is a single button with no argument. The integration
   * points it at the earliest booking in the DEVICE's list that carries a
   * number, with no regard for the time, so the panel cannot choose which
   * meeting it starts. All the panel can do is put the badge on the row that
   * button will actually dial.
   *
   * When that booking has already finished, the button is pointed at
   * something nobody wants to join. Moving the badge to the meeting that IS
   * happening would not change where it dials — it would just make the panel
   * lie more convincingly. So no badge, and a line saying why.
   */
  const deviceTarget = all.find((m) => m.joinable);
  const stale = deviceTarget !== undefined && isOver(deviceTarget, at);
  // And not until it is nearly time. A Join that has been sitting there since
  // breakfast is furniture; one that appears five minutes out is a prompt.
  const joinRow =
    deviceTarget && !stale && isDue(deviceTarget, at) ? meetings.indexOf(deviceTarget) : -1;

  const t = timeOpts.value;

  return (
    <div class="card devtile-meetings">
      <div class="devtile-card-head">
        <span class="devtile-card-title">Meetings</span>
        {meetings.length > 0 ? <span class="devtile-count tnum">{meetings.length}</span> : null}
        {e.refreshMeetings ? (
          <Pressable
            class="devtile-refresh"
            onPress={() => {
              pressButton(e.refreshMeetings!);
              markActivity();
            }}
            ariaLabel="Refresh meetings"
          >
            <Icon name="refresh" size="1rem" weight={1.9} />
          </Pressable>
        ) : null}
      </div>

      {meetings.length === 0 ? (
        <div class="devtile-empty">
          {!state
            ? 'Waiting for Home Assistant.'
            : all.length > 0
              ? 'Nothing left today. Every booking the device knows about has finished.'
              : 'Nothing booked. The device reports its own calendar, so this needs it paired with a calendar service.'}
        </div>
      ) : (
        <div class="devtile-list scroll">
          {stale ? (
            <div class="devtile-stale">
              <Icon name="alert" size="0.875rem" weight={1.9} />
              <span>
                Join is pointed at a meeting that has already finished — refresh to move it
                on.
              </span>
            </div>
          ) : null}
          {meetings.map((m, i) => (
            <div class="devtile-meeting" key={`${m.start_time ?? ''}-${i}`}>
              <div class="devtile-time tnum">{clockOf(m.start_time, t)}</div>
              <div class="devtile-meeting-text">
                <div class="devtile-meeting-title truncate">{m.title}</div>
                {m.organizer ? (
                  <div class="devtile-meeting-org truncate">{m.organizer}</div>
                ) : null}
              </div>
              {/*
                Join only on the FIRST joinable booking. The integration
                exposes `join_next_meeting` and nothing per-booking, so a Join
                on the 12:00 row would join the 9:00 one — a button that lies
                about which meeting it starts is worse than no button.
              */}
              {e.join && i === joinRow ? (
                <Pressable
                  class="devtile-join"
                  onPress={() => {
                    pressButton(e.join!);
                    markActivity();
                  }}
                  ariaLabel={`Join ${m.title}`}
                >
                  <Icon name="camera" size="1rem" weight={1.8} />
                  <span>Join</span>
                </Pressable>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * How long before a meeting starts its Join offer appears.
 *
 * Five minutes: long enough to be in the room and ready, short enough that
 * the button on screen always means the meeting you are about to walk into.
 * A Join sitting there all morning is the thing that made it ignorable.
 */
const JOIN_LEAD_MS = 5 * 60_000;

/** The meetings a device is reporting, newest parse of a live attribute. */
function readMeetings(state: EntityState | null): Meeting[] {
  const raw = state?.a['meetings'];
  return Array.isArray(raw) ? (raw.filter((m) => m && typeof m === 'object') as Meeting[]) : [];
}

/**
 * Is this meeting close enough to start that Join should be offered?
 *
 * An unreadable or missing start time counts as due, for the same reason a
 * missing end time counts as not-over: a meeting we cannot place in time
 * should be joinable rather than silently un-joinable.
 */
function isDue(m: Meeting, at: Date): boolean {
  if (!m.start_time) return true;
  const start = Date.parse(m.start_time);
  if (!Number.isFinite(start)) return true;
  return start - at.getTime() <= JOIN_LEAD_MS;
}

/** Identity for "this exact booking", for remembering a dismissal. */
function keyOf(m: Meeting): string {
  return `${m.start_time ?? ''}|${m.title}`;
}

/**
 * Has this booking already finished?
 *
 * Unknown when the calendar service did not give an end time, and unknown
 * means NOT over: hiding a meeting we cannot reason about would be worse than
 * showing one that has passed.
 */
function isOver(m: Meeting, at: Date): boolean {
  if (!m.end_time) return false;
  const end = Date.parse(m.end_time);
  return Number.isFinite(end) && end <= at.getTime();
}

/* ── Controls ─────────────────────────────────────────────────────────────*/

function Controls({
  entities: e,
  keys,
  soloed,
}: {
  entities: DeviceEntities;
  keys: ControlButton[];
  soloed: boolean;
}) {
  const inCall = useState(e.inCall);
  const sharing = useState(e.sharing);
  const calling = inCall?.s === 'on';

  // Which share button to offer. Sharing to a call when there is no call is
  // rejected by the device, so offering it would be offering a failure.
  const shareTarget = sharing?.s === 'on' ? e.stopSharing : calling ? e.shareToCall : e.shareLocal;
  const shareLabel = sharing?.s === 'on' ? 'Stop sharing' : calling ? 'Share to call' : 'Share screen';

  return (
    <div class="devtile-controls" data-solo={soloed ? '' : undefined}>
      <Toggles entities={e} keys={keys} />
      {e.volume ? <Volume entity={e.volume} /> : null}

      {shareTarget || e.shareSource ? (
        <div class="devtile-row">
          {shareTarget ? (
            <Pressable
              class="devtile-wide"
              onPress={() => {
                pressButton(shareTarget);
                markActivity();
              }}
              ariaLabel={shareLabel}
            >
              <Icon name={sharing?.s === 'on' ? 'close' : 'share'} size="1.1875rem" weight={1.7} />
              <span class="truncate">{shareLabel}</span>
            </Pressable>
          ) : null}
          {e.shareSource ? <ShareSource entity={e.shareSource} /> : null}
        </div>
      ) : null}

      {e.answer || e.hangUp ? (
        <div class="devtile-row">
          {e.answer ? (
            <Pressable
              class="devtile-wide"
              tone="ok"
              onPress={() => {
                pressButton(e.answer!);
                markActivity();
              }}
              ariaLabel="Answer"
            >
              <Icon name="phone" size="1.1875rem" weight={1.7} />
              <span>Answer</span>
            </Pressable>
          ) : null}
          {e.hangUp ? (
            <Pressable
              class="devtile-wide"
              tone="danger"
              onPress={() => {
                pressButton(e.hangUp!);
                markActivity();
              }}
              ariaLabel="Hang up"
            >
              <Icon name="phoneDown" size="1.1875rem" weight={1.7} />
              <span>Hang up</span>
            </Pressable>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The four mute/mode switches.
 *
 * `microphone_mute` and `speaker_mute` are ON when MUTED — that is how the
 * integration reports them — so the key lights up to mean "muted", and its
 * label says so. A key that reads "Mic" and glows when the mic is WORKING
 * would be read the wrong way round in exactly the moment it matters.
 */
function Toggles({ entities: e, keys }: { entities: DeviceEntities; keys: ControlButton[] }) {
  const specs: { id?: string; on: string; off: string; iconOn: string; iconOff: string }[] = [
    { id: e.mic, on: 'Mic muted', off: 'Mic', iconOn: 'micOff', iconOff: 'mic' },
    { id: e.speaker, on: 'Speaker muted', off: 'Speaker', iconOn: 'mute', iconOff: 'volume' },
    // The camera, not the selfview: one is what the far end sees, the other is
    // the preview. Sits next to the mic because those two are the pair people
    // reach for in a call.
    { id: e.camera, on: 'Camera off', off: 'Camera', iconOn: 'cameraOff', iconOff: 'camera' },
    { id: e.dnd, on: 'DND on', off: 'DND', iconOn: 'moon', iconOff: 'moon' },
    { id: e.selfview, on: 'Selfview on', off: 'Selfview', iconOn: 'pip', iconOff: 'pip' },
  ];
  const present = specs.filter((s) => s.id);
  if (present.length === 0 && keys.length === 0) return null;

  // The count drives the column split in CSS: `repeat()` needs a literal
  // integer, so this is an attribute rather than a custom property.
  const count = present.length + keys.length;

  return (
    <div class="devtile-keys" data-count={count > 4 ? String(Math.min(count, 6)) : undefined}>
      {present.map((spec) => (
        <ToggleKey key={spec.id} spec={spec} />
      ))}
      {/* Configured keys come after the device's own, so the row's stateful
          half stays in one place as keys are added and removed. */}
      {keys.map((button) => (
        <MacroKey key={button.id} button={button} />
      ))}
    </div>
  );
}

/**
 * A configured key in the toggle row — a Companion press, a webhook, a scene.
 *
 * Deliberately NOT drawn as a toggle. It has no state to show: the press goes
 * out and nothing comes back, so it confirms that it went and claims nothing
 * further. Borrowing the lit-up look of the real toggles beside it would make
 * "camera off" indistinguishable from "I asked for camera off".
 */
function MacroKey({ button }: { button: ControlButton }) {
  const confirming = pressed.value.has(button.id);

  return (
    <Pressable
      class="devtile-key"
      onPress={() => {
        pressControl(button.id);
        markActivity();
      }}
      ariaLabel={button.name}
    >
      <span class="devtile-key-face" data-confirm={confirming ? '' : undefined}>
        <Icon
          name={hasIcon(button.icon) ? button.icon : 'grid'}
          size="1.625rem"
          weight={1.6}
          class="devtile-key-icon"
        />
        <Icon name="check" size="1.625rem" weight={2.2} class="devtile-key-tick" />
      </span>
      <span class="devtile-key-name truncate">{button.name}</span>
    </Pressable>
  );
}

function ToggleKey({
  spec,
}: {
  spec: { id?: string; on: string; off: string; iconOn: string; iconOff: string };
}) {
  const state = useState(spec.id);
  const on = state?.s === 'on';
  const dead = !state || unavailable(state);

  return (
    <Pressable
      class="devtile-key"
      onPress={() => {
        toggle(spec.id!);
        markActivity();
      }}
      ariaLabel={on ? spec.on : spec.off}
      ariaPressed={on}
      disabled={dead}
    >
      <span class="devtile-key-face" data-on={on ? '' : undefined}>
        <Icon name={on ? spec.iconOn : spec.iconOff} size="1.625rem" weight={1.6} />
      </span>
      <span class="devtile-key-name truncate">{on ? spec.on : spec.off}</span>
    </Pressable>
  );
}

function Volume({ entity: id }: { entity: string }) {
  const state = useState(id);
  const value = Number(state?.s);
  const min = num(state?.a['min'], 0);
  const max = num(state?.a['max'], 100);
  const step = num(state?.a['step'], 1);

  return (
    <Slider
      value={Number.isFinite(value) ? value : min}
      min={min}
      max={max}
      step={step}
      size="lg"
      disabled={!state || unavailable(state)}
      readout={Number.isFinite(value) ? String(value) : '—'}
      ariaLabel="Volume"
      icon={<Icon name="volume" size="1.125rem" />}
      onChange={(v, final) => {
        setEntityNumber(id, v, final);
        if (final) markActivity();
      }}
    />
  );
}

function ShareSource({ entity: id }: { entity: string }) {
  const state = useState(id);
  const current = state && !unavailable(state) ? state.s : '—';

  return (
    <Pressable
      class="devtile-wide devtile-source"
      onPress={() => {
        openDeviceSource.value = id;
        markActivity();
      }}
      ariaLabel={`Share source: ${current}`}
      disabled={!state || unavailable(state)}
    >
      <span class="truncate">{current}</span>
      <Icon name="chevronDown" size="1.0625rem" weight={1.9} />
    </Pressable>
  );
}

/* ── Footer ───────────────────────────────────────────────────────────────*/

function Foot({ entities: e }: { entities: DeviceEntities }) {
  const noise = useState(e.noise);
  const uptime = useState(e.uptime);
  const ip = useState(e.ip);
  const version = useState(e.version);
  const alerts = useState(e.alerts);

  const items: { icon: string; text: string }[] = [];
  if (noise && !unavailable(noise)) items.push({ icon: 'motion', text: `${noise.s} dBA` });
  if (uptime && !unavailable(uptime)) items.push({ icon: 'clock', text: uptimeOf(uptime.s) });
  if (ip && !unavailable(ip)) items.push({ icon: 'link', text: ip.s });
  if (version && !unavailable(version)) items.push({ icon: 'script', text: version.s });

  const alertCount = Number(alerts?.s);
  if (items.length === 0 && !Number.isFinite(alertCount)) return null;

  return (
    <div class="devtile-foot">
      {items.map((it) => (
        <div class="devtile-foot-item" key={it.text}>
          <Icon name={it.icon} size="0.875rem" weight={1.8} />
          <span class="truncate">{it.text}</span>
        </div>
      ))}
      {Number.isFinite(alertCount) ? (
        // Pressable only when there is something to read. A chip that says
        // "No alerts" and opens an empty sheet is a worse answer than one
        // that simply does not invite the tap.
        alertCount > 0 && e.alerts ? (
          <Pressable
            class="devtile-foot-item devtile-alerts is-raised"
            onPress={() => {
              openDeviceAlerts.value = e.alerts!;
              markActivity();
            }}
            ariaLabel={`${alertCount} device ${alertCount === 1 ? 'alert' : 'alerts'}: show detail`}
          >
            <Icon name="alert" size="0.875rem" weight={1.8} />
            <span>
              {alertCount} {alertCount === 1 ? 'alert' : 'alerts'}
            </span>
            <Icon name="chevronRight" size="0.75rem" weight={2} />
          </Pressable>
        ) : (
          <div class="devtile-foot-item devtile-alerts">
            <Icon name="check" size="0.875rem" weight={1.8} />
            <span>No alerts</span>
          </div>
        )
      ) : null}
    </div>
  );
}

/* ── Helpers ──────────────────────────────────────────────────────────────*/

/** Read an optional entity slot. Returns null when unconfigured or unknown. */
function useState(id: string | undefined): EntityState | null {
  // Not a hook despite the name shape — `entity()` returns a signal, and
  // reading `.value` during render is what subscribes this component to it.
  return id ? entity(id).value : null;
}

function unavailable(state: EntityState): boolean {
  return state.s === 'unavailable' || state.s === 'unknown';
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Seconds to "1d 18h" / "4h 12m" / "9m". */
function uptimeOf(raw: string): string {
  const total = Number(raw);
  if (!Number.isFinite(total) || total < 0) return raw;
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * An ISO start time as a wall clock, in the panel's configured zone.
 *
 * The meridiem is appended on a 12-hour clock, unlike everywhere else in the
 * app: the big Home clock can drop it because you know roughly what time it
 * is, but a LIST of bookings cannot — "5:00" against "5:00" is the difference
 * between a stand-up and dinner, and the list may run across noon.
 */
function clockOf(iso: string | undefined, opts: TimeOpts): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const time = formatTime(d, opts);
  return opts.hour12 ? `${time} ${formatMeridiem(d, opts)}` : time;
}
