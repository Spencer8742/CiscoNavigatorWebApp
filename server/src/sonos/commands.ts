import { logger } from '~/lib/log.ts';
import { toPlayMode } from '~/sonos/store.ts';
import type { SonosClient } from '~/sonos/client.ts';
import type { SonosStore } from '~/sonos/store.ts';
import type { SonosZone } from '~/sonos/topology.ts';
import type { MusicCommand } from '@shared/protocol.ts';

const log = logger('sonos-cmd');

/**
 * The guard between a panel and the speakers.
 *
 * `mass/commands.ts` allow-lists Music Assistant command names because that
 * API is administrative. Sonos's local API is worse: the same port that pauses
 * a track can rename rooms (`DeviceProperties.SetZoneAttributes`), rewrite
 * alarms (`AlarmClock`), and write music-service account credentials
 * (`SystemProperties`). None of that is behind authentication on the LAN.
 *
 * So the guard is not a longer list, it is a different shape:
 *
 * > **The panel names a verb. It never names a SOAP action.**
 *
 * There is no string a compromised panel can send that becomes an action this
 * file does not itself write. That is a stronger property than an allow-list
 * of upstream command names — with a list, the risk is that something
 * dangerous was overlooked; here the set is closed by construction.
 *
 * It is the same rule as `controls.pages`, where the panel sends
 * `deskpro.hangup` rather than a URL, for the same reason: a screen anyone in
 * the room can touch is trusted to drive the dashboard, not to compose
 * requests to the LAN.
 *
 * ## Coordinator routing
 *
 * Transport acts on the **group**; volume and mute act on the **speaker**.
 * Sending `Play` to a grouped follower is accepted and does nothing, which is
 * the single most common Sonos integration bug. Every transport verb is
 * therefore routed to `zone.coordinator` before it is sent.
 *
 * `docs/SONOS.md` §15 phase 3 called for refusing such a command instead.
 * Routing is the better answer: the panel legitimately shows a follower, and
 * its transport buttons should work rather than explain themselves.
 */

/** A group cannot sensibly be larger than a household. */
const MAX_MEMBERS = 32;

const REPEAT_MODES = new Set(['off', 'one', 'all']);

export class SonosCommands {
  readonly #client: SonosClient;
  readonly #store: SonosStore;

  constructor(client: SonosClient, store: SonosStore) {
    this.#client = client;
    this.#store = store;
  }

  /**
   * Validate and perform one verb. Returns a message for the panel, or null.
   *
   * Refusals are vague on purpose while the log line is specific: a panel is
   * not the place to explain the shape of a guard to whoever is standing in
   * front of it.
   */
  async run(cmd: MusicCommand): Promise<string | null> {
    if (!this.#client.enabled) return 'Sonos is not configured';
    if (this.#client.state !== 'connected') return 'Sonos is not reachable';

    const zone = this.#client.household.zones.get(cmd.player);
    if (!zone) {
      log.warn(`Refused ${cmd.verb}: "${cmd.player}" is not a known zone`);
      return 'Not permitted';
    }

    try {
      return await this.#perform(cmd, zone);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`${cmd.verb} on ${zone.name} failed: ${message}`);
      return 'The speaker did not accept that';
    }
  }

  async #perform(cmd: MusicCommand, zone: SonosZone): Promise<string | null> {
    /*
     * Transport is the coordinator's business. Resolving it here rather than
     * at each call site is what makes it impossible to forget — and forgetting
     * produces a command that is accepted and silently does nothing.
     */
    const lead = this.#coordinatorOf(zone);

    switch (cmd.verb) {
      case 'play':
        await this.#av(lead, 'Play', { Speed: '1' });
        return null;

      case 'pause':
        await this.#av(lead, 'Pause');
        return null;

      case 'stop':
        await this.#av(lead, 'Stop');
        return null;

      case 'playPause': {
        // The store already knows, so this costs no round trip. Asking the
        // speaker would add one to every tap of the biggest button on screen.
        const playing = this.#store
          .snapshot()
          .players.find((p) => p.id === zone.uuid)?.state;
        await this.#av(lead, playing === 'playing' ? 'Pause' : 'Play', {
          ...(playing === 'playing' ? {} : { Speed: '1' }),
        });
        return null;
      }

      case 'next':
        await this.#av(lead, 'Next');
        return null;

      case 'previous':
        await this.#av(lead, 'Previous');
        return null;

      case 'seek': {
        if (!Number.isFinite(cmd.seconds) || cmd.seconds < 0) return 'Not permitted';
        await this.#av(lead, 'Seek', {
          Unit: 'REL_TIME',
          Target: hms(Math.floor(cmd.seconds)),
        });
        return null;
      }

      case 'volume': {
        const level = clampVolume(cmd.level);
        if (level === null) {
          log.warn(`Refused volume: ${String(cmd.level)} is out of range`);
          return 'Not permitted';
        }
        // Volume is per SPEAKER, not per group — sending this to a coordinator
        // would change one speaker while the user was looking at another.
        await this.#client.call(zone.host, 'RenderingControl', 'SetVolume', {
          InstanceID: 0,
          Channel: 'Master',
          DesiredVolume: level,
        });
        return null;
      }

      case 'mute':
        await this.#client.call(zone.host, 'RenderingControl', 'SetMute', {
          InstanceID: 0,
          Channel: 'Master',
          // Sonos writes booleans as 1/0, never true/false.
          DesiredMute: cmd.muted ? 1 : 0,
        });
        return null;

      case 'shuffle':
      case 'repeat': {
        const current = this.#store.snapshot().queues.find((q) => q.id === lead.uuid);
        const shuffle = cmd.verb === 'shuffle' ? cmd.on : (current?.shuffle ?? false);
        const repeat = cmd.verb === 'repeat' ? cmd.mode : (current?.repeat ?? 'off');

        if (!REPEAT_MODES.has(repeat)) return 'Not permitted';

        // Sonos has one setting for both, so changing either means sending the
        // combination — which is why the other half is read back first.
        await this.#av(lead, 'SetPlayMode', { NewPlayMode: toPlayMode(shuffle, repeat) });
        return null;
      }

      case 'group':
        return this.#group(zone, cmd.members);

      case 'ungroup':
        await this.#av(zone, 'BecomeCoordinatorOfStandaloneGroup');
        return null;

      case 'power':
        // Not a refusal, an absence: Sonos speakers have no power concept, and
        // the panel already draws no power button for them.
        return 'Sonos speakers have no power control';

      case 'playItem':
      case 'favorite':
      case 'queueJump':
      case 'queueMove':
      case 'queueRemove':
      case 'queueClear':
        // Reachable only once browsing exists to produce something to play.
        return 'Not available yet — Sonos browsing arrives in the next phase';
    }
  }

  /**
   * Set the group led by `leader` to exactly these members.
   *
   * Absolute rather than incremental, matching `players/cmd/set_members` on
   * the Music Assistant side — which is what makes removing a speaker the same
   * operation as adding one, and what stops two panels racing into a group
   * neither asked for.
   */
  async #group(leader: SonosZone, members: unknown): Promise<string | null> {
    if (!Array.isArray(members) || members.length > MAX_MEMBERS) {
      log.warn(`Refused group: members is not a usable list`);
      return 'Not permitted';
    }

    const zones = this.#client.household.zones;
    const wanted = new Set<string>();
    for (const id of members) {
      if (typeof id !== 'string' || !zones.has(id)) {
        log.warn(`Refused group: "${String(id)}" is not a known zone`);
        return 'Not permitted';
      }
      // The leader is implied by the target; naming it as its own child is
      // what Sonos would reject.
      if (id !== leader.uuid) wanted.add(id);
    }

    const current = new Set(leader.group.filter((id) => id !== leader.uuid));

    const joining = [...wanted].filter((id) => !current.has(id));
    const leaving = [...current].filter((id) => !wanted.has(id));

    /*
     * Joining is `SetAVTransportURI` with the coordinator's own `x-rincon:`
     * URI — the speaker stops being its own source and starts following. It
     * is not an obvious API and it is the only way to do it locally.
     */
    for (const id of joining) {
      const zone = zones.get(id);
      if (!zone) continue;
      await this.#client.call(zone.host, 'AVTransport', 'SetAVTransportURI', {
        InstanceID: 0,
        CurrentURI: `x-rincon:${leader.uuid}`,
        CurrentURIMetaData: '',
      });
    }

    for (const id of leaving) {
      const zone = zones.get(id);
      if (!zone) continue;
      await this.#client.call(zone.host, 'AVTransport', 'BecomeCoordinatorOfStandaloneGroup', {
        InstanceID: 0,
      });
    }

    return null;
  }

  /** The zone a transport command must actually be sent to. */
  #coordinatorOf(zone: SonosZone): SonosZone {
    return this.#client.household.zones.get(zone.coordinator) ?? zone;
  }

  #av(zone: SonosZone, action: string, args: Record<string, string> = {}): Promise<unknown> {
    return this.#client.call(zone.host, 'AVTransport', action, { InstanceID: 0, ...args });
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────────*/

function clampVolume(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const n = Math.round(raw);
  return n >= 0 && n <= 100 ? n : null;
}

/** Seconds to `H:MM:SS`, which is the only format Sonos's Seek accepts. */
export function hms(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}
