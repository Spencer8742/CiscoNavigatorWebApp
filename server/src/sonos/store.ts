import { logger } from '~/lib/log.ts';
import { artUrl, parseTrackMetadata } from '~/sonos/didl.ts';
import { flag, integer, seconds } from '~/sonos/soap.ts';
import { textOf } from '~/sonos/xml.ts';
import type { XmlNode } from '~/sonos/xml.ts';
import type { SonosClient } from '~/sonos/client.ts';
import type { SonosZone } from '~/sonos/topology.ts';
import type { MediaArt } from '~/http/media-art.ts';
import type { MassMedia, MassPlayer, MassQueue } from '@shared/protocol.ts';

const log = logger('sonos-store');

/**
 * Every Sonos zone, shaped into the protocol the panel already speaks.
 *
 * The types are still called `Mass*` because `docs/SONOS.md` phase 6 does the
 * rename as part of the cut-over, when Music Assistant is deleted and there is
 * one music source again. Until then both stores produce the same shape and
 * the panel cannot tell — which is the property that makes this migration
 * possible in stages rather than one commit.
 *
 * ## What is deliberately not here yet
 *
 * `canGroupWith` is left EMPTY. Sonos can group any zone with any other, so
 * populating it is a one-liner — and it would immediately put a "Playing on"
 * bar on the Media screen whose button sends a command nothing yet handles.
 * A control that is drawn but inert is worse than one that is absent, so
 * grouping appears when phase 3 can honour it.
 *
 * `powered` is null, and that is permanent: Sonos speakers have no power
 * concept. The panel already draws no power button when this is null.
 *
 * ## The poll
 *
 * Phase 1 has no event subscriptions, so this polls — the only way to notice
 * a volume knob turned in the Sonos app. It is a stopgap and phase 2 deletes
 * it: GENA pushes the same facts the instant they change.
 *
 * It is gated on a panel being connected, exactly as the key-light poll is
 * (`controls/index.ts`), so a container running before the Navigator is
 * provisioned talks to nobody.
 */

/**
 * Long enough not to hammer a household, short enough to feel alive.
 *
 * A four-zone household is about twenty requests per pass, which is well
 * inside what Sonos serves happily — the Sonos app itself asks for more. The
 * number stops mattering in phase 2, when events make the poll unnecessary.
 */
const POLL_MS = 5000;

/**
 * Concurrent SOAP calls.
 *
 * A ten-zone household is ~30 requests per refresh. Firing them all at once
 * works on a good day and produces timeouts on a busy Wi-Fi network, which
 * then read as speakers going unavailable.
 */
const CONCURRENCY = 6;

export interface SonosStoreEvents {
  onChange(players: MassPlayer[], queues: MassQueue[]): void;
}

export interface SonosStoreDeps {
  client: SonosClient;
  art: MediaArt;
  events: SonosStoreEvents;
  /** Nothing is polled while no panel is watching. */
  hasPanels: () => boolean;
}

/** Per-zone facts, as last read. */
interface ZoneState {
  volume: number | null;
  muted: boolean;
  reachable: boolean;
}

/** Per-group facts, read from the coordinator and shared by its members. */
interface GroupState {
  state: string;
  media: MassMedia | null;
  tracks: number;
  index: number | null;
  shuffle: boolean;
  repeat: string;
}

export class SonosStore {
  readonly #client: SonosClient;
  readonly #art: MediaArt;
  readonly #events: SonosStoreEvents;
  readonly #hasPanels: () => boolean;

  /** uuid → volume and mute. */
  readonly #zones = new Map<string, ZoneState>();
  /** coordinator uuid → what that group is doing. */
  readonly #groups = new Map<string, GroupState>();

  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #refreshing = false;

  constructor(deps: SonosStoreDeps) {
    this.#client = deps.client;
    this.#art = deps.art;
    this.#events = deps.events;
    this.#hasPanels = deps.hasPanels;
  }

  start(): void {
    if (!this.#client.enabled) return;

    /*
     * Read once immediately, ungated.
     *
     * The poll below waits for a panel, which is right — but the household has
     * to be known BEFORE the first panel connects, or its `hello` frame
     * carries an empty speaker list and the Media screen sits blank for ten
     * seconds on a device somebody is standing in front of.
     */
    void this.refresh();

    clearInterval(this.#pollTimer);
    this.#pollTimer = setInterval(() => {
      if (this.#hasPanels()) void this.refresh();
    }, POLL_MS);
    this.#pollTimer.unref();
  }

  dispose(): void {
    clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
  }

  /** Drop everything — we no longer know, and saying so beats guessing. */
  clear(): void {
    this.#zones.clear();
    this.#groups.clear();
    this.#publishNow();
  }

  /**
   * Re-read the household and everything in it.
   *
   * Skips overlapping runs rather than queueing them: a refresh that is still
   * going when the next tick fires means the household is slow, and stacking
   * another thirty requests behind it is how a slow system becomes an
   * unreachable one.
   */
  async refresh(): Promise<void> {
    if (this.#refreshing) return;
    this.#refreshing = true;
    try {
      const ok = await this.#client.refresh();
      if (!ok) {
        this.clear();
        return;
      }
      await this.#readAll();
      this.#publishNow();
    } catch (err) {
      log.warn('Failed to read Sonos state:', err);
    } finally {
      this.#refreshing = false;
    }
  }

  /** The current picture, for a panel that has just connected. */
  snapshot(): { players: MassPlayer[]; queues: MassQueue[] } {
    const zones = [...this.#client.household.zones.values()];

    const players: MassPlayer[] = zones.map((zone) => this.#describe(zone));
    players.sort((a, b) => a.name.localeCompare(b.name));

    const queues: MassQueue[] = [];
    for (const zone of zones) {
      // One queue per group, owned by its coordinator. A follower has no queue
      // of its own while it is grouped.
      if (zone.coordinator !== zone.uuid) continue;
      const group = this.#groups.get(zone.uuid);
      queues.push({
        id: zone.uuid,
        name: zone.name,
        count: group?.tracks ?? 0,
        index: group?.index ?? null,
        shuffle: group?.shuffle ?? false,
        repeat: group?.repeat ?? 'off',
      });
    }

    return { players, queues };
  }

  /* ── Reading ───────────────────────────────────────────────────────────*/

  async #readAll(): Promise<void> {
    const zones = [...this.#client.household.zones.values()];
    const coordinators = zones.filter((z) => z.coordinator === z.uuid);

    // Drop zones that have gone away, so a renamed or removed speaker does not
    // leave its old state behind to be published forever.
    const live = new Set(zones.map((z) => z.uuid));
    for (const uuid of [...this.#zones.keys()]) {
      if (!live.has(uuid)) this.#zones.delete(uuid);
    }
    for (const uuid of [...this.#groups.keys()]) {
      if (!live.has(uuid)) this.#groups.delete(uuid);
    }

    /*
     * One queue for both kinds of read, rather than two `mapLimit` calls run
     * in parallel — which would put twice `CONCURRENCY` requests in flight and
     * make the limit a suggestion.
     */
    const tasks: (() => Promise<void>)[] = [
      ...zones.map((zone) => () => this.#readZone(zone)),
      ...coordinators.map((zone) => () => this.#readGroup(zone)),
    ];
    await mapLimit(tasks, CONCURRENCY);
  }

  async #readZone(zone: SonosZone): Promise<void> {
    try {
      const [volume, mute] = await Promise.all([
        this.#client.call(zone.host, 'RenderingControl', 'GetVolume', {
          InstanceID: 0,
          Channel: 'Master',
        }),
        this.#client.call(zone.host, 'RenderingControl', 'GetMute', {
          InstanceID: 0,
          Channel: 'Master',
        }),
      ]);

      this.#zones.set(zone.uuid, {
        // Sonos volume is already 0-100, the same scale the protocol uses.
        // Converting it anywhere is how a slider ends up setting 1% of what
        // was asked for.
        volume: integer(textOf(volume, 'CurrentVolume')),
        muted: flag(textOf(mute, 'CurrentMute')),
        reachable: true,
      });
    } catch (err) {
      log.debug(`${zone.name} did not answer:`, err);
      const previous = this.#zones.get(zone.uuid);
      // Keep the last known values but stop claiming they are current.
      this.#zones.set(zone.uuid, {
        volume: previous?.volume ?? null,
        muted: previous?.muted ?? false,
        reachable: false,
      });
    }
  }

  async #readGroup(zone: SonosZone): Promise<void> {
    try {
      const [transport, position, media, settings] = await Promise.all([
        this.#client.call(zone.host, 'AVTransport', 'GetTransportInfo', { InstanceID: 0 }),
        this.#client.call(zone.host, 'AVTransport', 'GetPositionInfo', { InstanceID: 0 }),
        this.#client.call(zone.host, 'AVTransport', 'GetMediaInfo', { InstanceID: 0 }),
        this.#client.call(zone.host, 'AVTransport', 'GetTransportSettings', { InstanceID: 0 }),
      ]);

      const track = integer(textOf(position, 'Track'));
      const mode = playMode(textOf(settings, 'PlayMode'));

      this.#groups.set(zone.uuid, {
        state: playbackState(textOf(transport, 'CurrentTransportState')),
        media: this.#media(position, zone.host),
        tracks: integer(textOf(media, 'NrTracks')) ?? 0,
        // Sonos counts tracks from 1; the protocol and the panel count from 0.
        index: track === null || track < 1 ? null : track - 1,
        shuffle: mode.shuffle,
        repeat: mode.repeat,
      });
    } catch (err) {
      log.debug(`${zone.name} transport did not answer:`, err);
      this.#groups.delete(zone.uuid);
    }
  }

  #media(position: XmlNode, host: string): MassMedia | null {
    const track = parseTrackMetadata(textOf(position, 'TrackMetaData'));
    if (!track) return null;

    /*
     * For a live stream the station sits in `dc:title` and the song in
     * `r:streamContent`, so preferring the stream line is what stops a radio
     * station showing the same text for an hour. For a file both agree, and
     * `streamContent` is absent.
     */
    const title = track.streamContent ?? track.title;
    if (!title) return null;

    const elapsed = seconds(textOf(position, 'RelTime'));

    return {
      title,
      // When the stream line supplied the title, the station name is the more
      // useful second line than repeating it.
      artist: track.artist ?? (track.streamContent ? track.title : null),
      album: track.album,
      art: this.#art.register(artUrl(track.artUri, host)),
      duration: seconds(textOf(position, 'TrackDuration')),
      elapsed,
      // The moment it was measured, so the panel extrapolates a smooth bar
      // between refreshes rather than stepping once per poll.
      elapsedAt: elapsed === null ? null : Date.now(),
    };
  }

  /* ── Shaping ───────────────────────────────────────────────────────────*/

  #describe(zone: SonosZone): MassPlayer {
    const state = this.#zones.get(zone.uuid);
    const group = this.#groups.get(zone.coordinator);
    const leading = zone.coordinator === zone.uuid;

    return {
      id: zone.uuid,
      name: zone.name,
      type: zone.kind,
      available: state?.reachable ?? false,
      // A follower is playing exactly what its coordinator is playing, so it
      // reports the group's state rather than its own — which for a grouped
      // Sonos speaker is always STOPPED and would draw a paused speaker that
      // is audibly playing.
      state: group?.state ?? 'idle',
      powered: null,
      volume: state?.volume ?? null,
      muted: state?.muted ?? false,
      // A group of one is not a group: the panel draws "Playing on" from this,
      // and a lone speaker listing itself as its own member reads oddly.
      members: zone.group.length > 1 ? zone.group : [],
      syncedTo: leading ? null : zone.coordinator,
      // Empty until phase 3 — see the note at the top of this file.
      canGroupWith: [],
      queueId: zone.coordinator,
      groupVolume: state?.volume ?? null,
      media: group?.media ?? null,
    };
  }

  /* ── Publishing ────────────────────────────────────────────────────────*/

  #publishNow(): void {
    const { players, queues } = this.snapshot();
    this.#events.onChange(players, queues);
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────────*/

/** Sonos's transport states, in the vocabulary the panel already draws. */
function playbackState(raw: string | null): string {
  switch (raw) {
    case 'PLAYING':
      return 'playing';
    case 'PAUSED_PLAYBACK':
      return 'paused';
    case 'TRANSITIONING':
      return 'buffering';
    default:
      // STOPPED and NO_MEDIA_PRESENT both mean nothing is coming out of it.
      return 'idle';
  }
}

/**
 * Sonos folds shuffle and repeat into one `PlayMode` string.
 *
 * Note `SHUFFLE`, which means shuffle **and** repeat-all rather than shuffle
 * alone — `SHUFFLE_NOREPEAT` is the one that means what its name suggests.
 * Reading them the obvious way round makes the repeat button lie.
 */
function playMode(raw: string | null): { shuffle: boolean; repeat: string } {
  switch (raw) {
    case 'REPEAT_ALL':
      return { shuffle: false, repeat: 'all' };
    case 'REPEAT_ONE':
      return { shuffle: false, repeat: 'one' };
    case 'SHUFFLE':
      return { shuffle: true, repeat: 'all' };
    case 'SHUFFLE_NOREPEAT':
      return { shuffle: true, repeat: 'off' };
    case 'SHUFFLE_REPEAT_ONE':
      return { shuffle: true, repeat: 'one' };
    default:
      return { shuffle: false, repeat: 'off' };
  }
}

/** Run every task, at most `limit` of them at a time. */
async function mapLimit(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  const workers: Promise<void>[] = [];

  for (let i = 0; i < Math.min(limit, tasks.length); i += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const task = tasks[next];
          next += 1;
          if (task === undefined) return;
          await task();
        }
      })(),
    );
  }

  await Promise.all(workers);
}
