import { logger } from '~/lib/log.ts';
import { integer } from '~/sonos/soap.ts';
import { toPlayMode } from '~/sonos/store.ts';
import { textOf, type XmlNode } from '~/sonos/xml.ts';
import type { SonosClient } from '~/sonos/client.ts';
import type { SonosStore } from '~/sonos/store.ts';
import type { SonosZone } from '~/sonos/topology.ts';
import type { UriRegistry } from '~/sonos/uris.ts';
import type { Enqueue, MusicCommand } from '@shared/protocol.ts';

const log = logger('sonos-cmd');

/**
 * The guard between a panel and the speakers.
 *
 * Sonos's local API is administrative: the same port that pauses a track can
 * rename rooms (`DeviceProperties.SetZoneAttributes`), rewrite alarms
 * (`AlarmClock`), and write music-service account credentials
 * (`SystemProperties`). None of that is behind authentication on the LAN.
 *
 * So the guard is not an allow-list, it is a different shape:
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
  readonly #uris: UriRegistry;

  constructor(client: SonosClient, store: SonosStore, uris: UriRegistry) {
    this.#client = client;
    this.#store = store;
    this.#uris = uris;
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
        return this.#playItem(lead, cmd.item, cmd.enqueue);

      case 'queueJump':
        // Sonos counts tracks from 1; the panel counts from 0.
        await this.#av(lead, 'Seek', {
          Unit: 'TRACK_NR',
          Target: String(Math.max(0, Math.floor(cmd.index)) + 1),
        });
        return null;

      case 'queueRemove':
        if (!isQueueId(cmd.item)) return 'Not permitted';
        await this.#av(lead, 'RemoveTrackFromQueue', { ObjectID: cmd.item, UpdateID: '0' });
        return null;

      case 'queueMove':
        return this.#moveQueueItem(lead, cmd.item, cmd.by);

      case 'queueClear':
        await this.#av(lead, 'RemoveAllTracksFromQueue');
        return null;

      case 'favorite':
        /*
         * Not a refusal, an absence. Sonos manages favourites in its own app
         * and exposes no way to add one locally — `FV:2` is readable and not
         * writable. The panel therefore never offers the button (it only does
         * when the current state is known), so this is the belt to that
         * braces.
         */
        return 'Favourites are managed in the Sonos app';
    }
  }

  /**
   * Play something a browse produced.
   *
   * `item` is a key this backend minted, never a URI — see `uris.ts`. Which of
   * the three sequences below runs is decided by `Playable.style`, and getting
   * that wrong is not a cosmetic error:
   *
   * - A **stream** has no end and cannot go in a queue at all.
   * - A **container** is resolved by the speaker itself. Enqueueing one and
   *   then pointing the transport at the queue is how a favourited playlist
   *   became `Play → UPnP 701`: the service declined to enqueue, so the
   *   transport was aimed at an empty queue and there was no transition to
   *   make. Handing the container straight to `SetAVTransportURI` is what the
   *   Sonos app's own "Play now" does.
   * - A **track** is the only one the queue path was ever right for.
   */
  async #playItem(lead: SonosZone, key: string, enqueue: Enqueue): Promise<string | null> {
    const playable = this.#uris.get(key);
    if (!playable) {
      // Expected after a backend restart, or once a key has aged out. The row
      // is still on screen, so this is an instruction somebody can follow.
      return 'That item is no longer loaded — browse to it again';
    }

    /*
     * A local library container arrives with an object id and no URI of its
     * own — `A:ALBUM/The%20Wall` is an address in the ContentDirectory, not
     * something a speaker can fetch. `x-rincon-playlist:` is how that address
     * is turned into one, and it needs a speaker UUID to be relative to.
     */
    const uri =
      playable.uri ?? (playable.objectId ? `x-rincon-playlist:${lead.uuid}#${playable.objectId}` : null);
    if (!uri) return 'That item cannot be played';

    const playNow = enqueue === 'play' || enqueue === 'replace';

    /*
     * A stream replaces what is playing whichever option was chosen — there is
     * nothing sensible to queue it behind, so "add to queue" on a radio
     * station is treated as "play it" rather than refused.
     */
    if (playable.style === 'stream' || (playable.style === 'container' && playNow)) {
      await this.#av(lead, 'SetAVTransportURI', {
        CurrentURI: uri,
        CurrentURIMetaData: playable.metadata,
      });
      await this.#av(lead, 'Play', { Speed: '1' });
      return null;
    }

    if (playNow) await this.#av(lead, 'RemoveAllTracksFromQueue');

    /*
     * `EnqueueAsNext` puts it after the current track; the first-track number
     * decides where. Zero means "at the end", which is what "add" means.
     */
    const next = enqueue === 'next' || enqueue === 'replace_next';
    const added = await this.#av(lead, 'AddURIToQueue', {
      EnqueuedURI: uri,
      EnqueuedURIMetaData: playable.metadata,
      DesiredFirstTrackNumberEnqueued: '0',
      EnqueueAsNext: next ? '1' : '0',
    });

    /*
     * Sonos answers 200 OK with `NumTracksAdded: 0` when it cannot resolve
     * what it was handed — a stale service token, a share that is offline.
     * Unchecked, the next two lines aim the transport at an empty queue and
     * the failure surfaces as a bare 701 several steps from its cause.
     */
    const count = integer(textOf(added, 'NumTracksAdded'));
    if (count === 0) {
      log.warn(`Nothing enqueued for ${uri.slice(0, 80)}`);
      return 'Sonos would not add that to the queue';
    }

    if (enqueue === 'add' || enqueue === 'next') return null;

    /*
     * Point the player at its own queue before playing.
     *
     * Without this a speaker that was on a radio station stays on it: the
     * queue now holds the album, and the transport is still pointed somewhere
     * else. `x-rincon-queue:<uuid>#0` is how a speaker is told "your source is
     * your queue", and forgetting it is a command that succeeds and changes
     * nothing audible.
     */
    await this.#av(lead, 'SetAVTransportURI', {
      CurrentURI: `x-rincon-queue:${lead.uuid}#0`,
      CurrentURIMetaData: '',
    });

    // Where Sonos actually put it, which is only 1 when the queue was cleared
    // first. Assuming 1 starts an "add and play" at somebody else's track.
    const first = integer(textOf(added, 'FirstTrackNumberEnqueued')) ?? 1;
    await this.#av(lead, 'Seek', { Unit: 'TRACK_NR', Target: String(first) });
    await this.#av(lead, 'Play', { Speed: '1' });
    return null;
  }

  /**
   * Move a queued track by a position shift.
   *
   * Sonos reorders by absolute positions rather than by a delta, and the
   * arithmetic differs by direction: moving DOWN has to account for the track
   * being lifted out first, so it inserts one further along than the naive
   * sum. Getting that wrong moves a track down by nothing at all.
   */
  async #moveQueueItem(lead: SonosZone, itemId: string, by: number): Promise<string | null> {
    if (!isQueueId(itemId)) return 'Not permitted';

    const from = positionOf(itemId);
    if (from === null) return 'Not permitted';

    let insertBefore: number;
    if (by === 0) {
      // "Play next": immediately after whatever is playing now.
      const current = this.#store.snapshot().queues.find((q) => q.id === lead.uuid)?.index ?? 0;
      insertBefore = current + 2;
    } else {
      insertBefore = by < 0 ? from + by : from + by + 1;
    }

    if (insertBefore < 1) insertBefore = 1;

    await this.#av(lead, 'ReorderTracksInQueue', {
      StartingIndex: String(from),
      NumberOfTracks: '1',
      InsertBefore: String(insertBefore),
      UpdateID: '0',
    });
    return null;
  }

  /**
   * Set the group led by `leader` to exactly these members.
   *
   * Absolute rather than incremental, matching `players/cmd/set_members` on
   * every other absolute setter — which is what makes removing a speaker the same
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
     * All of it at once.
     *
     * Every speaker here is told something about ITSELF — a joiner is pointed
     * at the coordinator, a leaver is told to stand alone — so there is no
     * ordering between them. Doing it sequentially made regrouping four
     * speakers four round trips deep, which is felt as a slow button.
     *
     * Joining is `SetAVTransportURI` with the coordinator's own `x-rincon:`
     * URI: the speaker stops being its own source and starts following. It is
     * not an obvious API and it is the only way to do it locally.
     */
    const work: Promise<unknown>[] = [];

    for (const id of joining) {
      const zone = zones.get(id);
      if (!zone) continue;
      work.push(
        this.#client.call(zone.host, 'AVTransport', 'SetAVTransportURI', {
          InstanceID: 0,
          CurrentURI: `x-rincon:${leader.uuid}`,
          CurrentURIMetaData: '',
        }),
      );
    }

    for (const id of leaving) {
      const zone = zones.get(id);
      if (!zone) continue;
      work.push(
        this.#client.call(zone.host, 'AVTransport', 'BecomeCoordinatorOfStandaloneGroup', {
          InstanceID: 0,
        }),
      );
    }

    /*
     * `allSettled`, not `all`: one speaker that is asleep or unplugged must
     * not abandon the rest halfway, leaving a group nobody asked for. The
     * topology event that follows is the authority on what actually happened.
     */
    const results = await Promise.allSettled(work);
    const failed = results.filter((r) => r.status === 'rejected').length;

    if (failed === 0) return null;
    log.warn(`Grouping: ${failed} of ${work.length} speakers did not accept the change`);
    return failed === work.length ? 'The speakers did not accept that' : null;
  }

  /** The zone a transport command must actually be sent to. */
  #coordinatorOf(zone: SonosZone): SonosZone {
    return this.#client.household.zones.get(zone.coordinator) ?? zone;
  }

  #av(zone: SonosZone, action: string, args: Record<string, string> = {}): Promise<XmlNode> {
    return this.#client.call(zone.host, 'AVTransport', action, { InstanceID: 0, ...args });
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────────*/

function clampVolume(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const n = Math.round(raw);
  return n >= 0 && n <= 100 ? n : null;
}

/**
 * A queue object id, `Q:0/5`.
 *
 * Checked rather than trusted because it goes straight into a SOAP argument
 * that removes or reorders things: `RemoveTrackFromQueue` takes an ObjectID,
 * and an unchecked one would let the panel name a container elsewhere in the
 * ContentDirectory.
 */
function isQueueId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^Q:\d+\/\d+$/.test(raw);
}

/** The 1-based position out of `Q:0/5`. */
function positionOf(queueId: string): number | null {
  const n = Number.parseInt(queueId.slice(queueId.lastIndexOf('/') + 1), 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/** Seconds to `H:MM:SS`, which is the only format Sonos's Seek accepts. */
export function hms(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}
