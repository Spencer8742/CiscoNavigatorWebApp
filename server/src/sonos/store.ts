import { logger } from '~/lib/log.ts';
import { artUrl, parseTrackMetadata } from '~/sonos/didl.ts';
import { parseLastChange } from '~/sonos/events.ts';
import { flag, integer, seconds } from '~/sonos/soap.ts';
import { textOf } from '~/sonos/xml.ts';
import type { XmlNode } from '~/sonos/xml.ts';
import type { SonosClient } from '~/sonos/client.ts';
import type { SonosEvent, SonosEvents } from '~/sonos/events.ts';
import type { SonosZone } from '~/sonos/topology.ts';
import type { MediaArt } from '~/http/media-art.ts';
import type { MassMedia, MassPlayer, MassQueue } from '@shared/protocol.ts';

const log = logger('sonos-store');

/**
 * Every Sonos zone, shaped into the protocol the panel already speaks.
 *
 * The types are still called `Mass*` because `docs/SONOS.md` phase 6 does the
 * rename as part of the cut-over, when Music Assistant is deleted and there is
 * one music source again.
 *
 * ## Events, not polling
 *
 * Phase 1 polled every five seconds because it had nothing else. Phase 2
 * subscribes (`events.ts`) and the speakers push instead — a volume knob
 * turned in the Sonos app now reaches the panel in milliseconds rather than up
 * to five seconds later, and an idle household costs nothing at all.
 *
 * What remains on a timer is **reconciliation**, every five minutes and only
 * while a panel is connected. That is not the poll wearing a hat: subscription
 * renewal already detects a dead subscription, but a single dropped `NOTIFY`
 * on a busy Wi-Fi network leaves one value wrong with nothing to correct it.
 * Five minutes is slow enough to be free and fast enough that nobody lives
 * with a stale number for long.
 *
 * ## One thing events do not carry
 *
 * `AVTransport` tells us the track, its duration and the transport state, but
 * **not the position within it**. So a track change is followed by one
 * `GetPositionInfo` to anchor `elapsed`/`elapsedAt`, from which the panel
 * extrapolates a smooth bar. Coalesced, because a track change delivers
 * several events in a burst.
 */

/**
 * Reconciliation, not polling. See the note above.
 *
 * Gated on a panel being connected, like the key-light poll — a container
 * running before the Navigator is provisioned talks to nobody.
 */
const RECONCILE_MS = 300_000;

/** Long enough to absorb a burst of events, short enough to feel immediate. */
const PUBLISH_DEBOUNCE_MS = 120;

/** A track change arrives as several events; anchor the position once. */
const POSITION_DEBOUNCE_MS = 400;

/**
 * Concurrent SOAP calls during a full read.
 *
 * A ten-zone household is ~30 requests. Firing them all at once works on a
 * good day and produces timeouts on a busy network, which then read as
 * speakers going unavailable.
 */
const CONCURRENCY = 6;

export interface SonosStoreEvents {
  onChange(players: MassPlayer[], queues: MassQueue[]): void;
}

export interface SonosStoreDeps {
  client: SonosClient;
  events: SonosEvents;
  art: MediaArt;
  listeners: SonosStoreEvents;
  /** Nothing is reconciled while no panel is watching. */
  hasPanels: () => boolean;
}

/** Per-zone facts. Volume and mute are per speaker, always. */
interface ZoneState {
  volume: number | null;
  muted: boolean;
  reachable: boolean;
}

/** Per-group facts, owned by the coordinator and shared by its members. */
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
  readonly #events: SonosEvents;
  readonly #art: MediaArt;
  readonly #listeners: SonosStoreEvents;
  readonly #hasPanels: () => boolean;

  readonly #zones = new Map<string, ZoneState>();
  readonly #groups = new Map<string, GroupState>();

  #dirty = false;
  #publishTimer: ReturnType<typeof setTimeout> | undefined;
  #reconcileTimer: ReturnType<typeof setInterval> | undefined;
  #positionTimer: ReturnType<typeof setTimeout> | undefined;
  #positionWanted = new Set<string>();
  #refreshing = false;

  constructor(deps: SonosStoreDeps) {
    this.#client = deps.client;
    this.#events = deps.events;
    this.#art = deps.art;
    this.#listeners = deps.listeners;
    this.#hasPanels = deps.hasPanels;
  }

  start(): void {
    if (!this.#client.enabled) return;

    // Read once immediately and ungated: the household must be known BEFORE
    // the first panel connects, or its `hello` frame carries an empty speaker
    // list and the Media screen sits blank in front of somebody.
    void this.refresh();

    clearInterval(this.#reconcileTimer);
    this.#reconcileTimer = setInterval(() => {
      if (this.#hasPanels()) void this.refresh();
    }, RECONCILE_MS);
    this.#reconcileTimer.unref();
  }

  dispose(): void {
    clearInterval(this.#reconcileTimer);
    clearTimeout(this.#publishTimer);
    clearTimeout(this.#positionTimer);
    this.#reconcileTimer = undefined;
    this.#publishTimer = undefined;
    this.#positionTimer = undefined;
  }

  clear(): void {
    this.#zones.clear();
    this.#groups.clear();
    this.#publishNow();
  }

  /** True when this id is a zone Sonos actually told us about. */
  hasPlayer(uuid: string): boolean {
    return this.#client.household.zones.has(uuid);
  }

  /* ── Events ────────────────────────────────────────────────────────────*/

  /**
   * Fold one pushed event into the store.
   *
   * Everything here is a write into a map plus a debounced publish. The one
   * exception is a topology change, which has to re-shape the subscriptions
   * themselves — a speaker that just joined a group no longer speaks for its
   * own transport.
   */
  async applyEvent(event: SonosEvent): Promise<void> {
    switch (event.service) {
      case 'ZoneGroupTopology': {
        const xml = event.properties.get('ZoneGroupState');
        if (!xml) return;
        if (!this.#client.adoptTopology(xml)) return;

        log.debug('Topology changed');
        await this.#resubscribe();
        // Grouping moves which speaker owns the transport, so the affected
        // groups have to be re-read rather than waiting for their next event.
        await this.#readAll();
        this.#publishNow();
        return;
      }

      case 'RenderingControl': {
        const change = parseLastChange(event.properties.get('LastChange') ?? '');
        if (change.size === 0) return;

        const previous = this.#zones.get(event.uuid);
        const volume = integer(change.get('Volume') ?? null);
        const muteRaw = change.get('Mute');

        this.#zones.set(event.uuid, {
          volume: volume ?? previous?.volume ?? null,
          muted: muteRaw === undefined ? (previous?.muted ?? false) : flag(muteRaw),
          reachable: true,
        });
        this.#touch();
        return;
      }

      case 'AVTransport': {
        const change = parseLastChange(event.properties.get('LastChange') ?? '');
        if (change.size === 0) return;
        this.#applyTransport(event.uuid, change);
        return;
      }
    }
  }

  #applyTransport(uuid: string, change: Map<string, string>): void {
    const zone = this.#client.household.zones.get(uuid);
    if (!zone) return;

    const previous = this.#groups.get(uuid);
    const mode = change.has('CurrentPlayMode')
      ? playMode(change.get('CurrentPlayMode') ?? null)
      : { shuffle: previous?.shuffle ?? false, repeat: previous?.repeat ?? 'off' };

    const metadata = change.get('CurrentTrackMetaData');
    const media =
      metadata === undefined
        ? (previous?.media ?? null)
        : this.#mediaFromEvent(metadata, change, zone.host, previous?.media ?? null);

    const track = integer(change.get('CurrentTrack') ?? null);

    const next: GroupState = {
      state: change.has('TransportState')
        ? playbackState(change.get('TransportState') ?? null)
        : (previous?.state ?? 'idle'),
      media,
      tracks: integer(change.get('NumberOfTracks') ?? null) ?? previous?.tracks ?? 0,
      // Sonos counts tracks from 1; the protocol and the panel count from 0.
      index: track === null ? (previous?.index ?? null) : track < 1 ? null : track - 1,
      shuffle: mode.shuffle,
      repeat: mode.repeat,
    };

    this.#groups.set(uuid, next);

    /*
     * A new track, or a transport that just started, needs a fresh position
     * anchor — the event carries the duration but never the position, so
     * without this the panel would extrapolate from the previous track's
     * offset and draw a bar that starts halfway through.
     */
    const trackChanged = media?.title !== previous?.media?.title || track !== previous?.index;
    if (trackChanged || next.state !== previous?.state) {
      this.#wantPosition(uuid);
    }

    this.#touch();
  }

  /**
   * Now-playing from a `LastChange`, rather than from `GetPositionInfo`.
   *
   * `elapsed` is deliberately carried over from the previous read rather than
   * reset: the anchor is refreshed a moment later by `#wantPosition`, and
   * zeroing it here would make every progress bar jump to the start and back.
   */
  #mediaFromEvent(
    metadata: string,
    change: Map<string, string>,
    host: string,
    previous: MassMedia | null,
  ): MassMedia | null {
    const track = parseTrackMetadata(metadata);
    if (!track) return null;

    const title = track.streamContent ?? track.title;
    if (!title) return null;

    const sameTrack = previous?.title === title;

    return {
      title,
      artist: track.artist ?? (track.streamContent ? track.title : null),
      album: track.album,
      art: this.#art.register(artUrl(track.artUri, host)),
      duration: seconds(change.get('CurrentTrackDuration') ?? null),
      elapsed: sameTrack ? previous.elapsed : null,
      elapsedAt: sameTrack ? previous.elapsedAt : null,
    };
  }

  /** Coalesce position reads: a track change arrives as several events. */
  #wantPosition(uuid: string): void {
    this.#positionWanted.add(uuid);
    if (this.#positionTimer) return;

    this.#positionTimer = setTimeout(() => {
      this.#positionTimer = undefined;
      const wanted = [...this.#positionWanted];
      this.#positionWanted.clear();
      void this.#readPositions(wanted);
    }, POSITION_DEBOUNCE_MS);
    this.#positionTimer.unref();
  }

  async #readPositions(uuids: string[]): Promise<void> {
    const zones = this.#client.household.zones;
    const tasks = uuids
      .map((uuid) => zones.get(uuid))
      .filter((zone): zone is SonosZone => zone !== undefined)
      .map((zone) => async () => {
        try {
          const position = await this.#client.call(zone.host, 'AVTransport', 'GetPositionInfo', {
            InstanceID: 0,
          });
          this.#anchorPosition(zone.uuid, position);
        } catch (err) {
          log.debug(`Position for ${zone.name} failed:`, err);
        }
      });

    if (tasks.length === 0) return;
    await mapLimit(tasks, CONCURRENCY);
    this.#touch();
  }

  #anchorPosition(uuid: string, position: XmlNode): void {
    const group = this.#groups.get(uuid);
    if (!group?.media) return;

    const elapsed = seconds(textOf(position, 'RelTime'));
    group.media = {
      ...group.media,
      elapsed,
      // The moment it was measured, so the panel extrapolates a smooth bar
      // between events rather than stepping.
      elapsedAt: elapsed === null ? null : Date.now(),
      // A live stream reports NOT_IMPLEMENTED for both; keep whichever the
      // event gave us rather than overwriting a real duration with null.
      duration: group.media.duration ?? seconds(textOf(position, 'TrackDuration')),
    };
  }

  /* ── Full read ─────────────────────────────────────────────────────────*/

  /**
   * Re-read the household and everything in it, then re-shape subscriptions.
   *
   * Runs at startup, on reconnect, and every five minutes as reconciliation.
   * Skips overlapping runs rather than queueing: a refresh still going when
   * the next one is due means the household is slow, and stacking another
   * thirty requests behind it is how slow becomes unreachable.
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
      await this.#resubscribe();
      await this.#readAll();
      this.#publishNow();
    } catch (err) {
      log.warn('Failed to read Sonos state:', err);
    } finally {
      this.#refreshing = false;
    }
  }

  async #resubscribe(): Promise<void> {
    const zones = [...this.#client.household.zones.values()];
    if (zones.length === 0) return;
    await this.#events.sync(zones, zones[0]?.host ?? '');
  }

  async #readAll(): Promise<void> {
    const zones = [...this.#client.household.zones.values()];
    const coordinators = zones.filter((z) => z.coordinator === z.uuid);

    // Drop state for zones that have gone away, so a removed speaker does not
    // leave its old values behind to be published forever.
    const live = new Set(zones.map((z) => z.uuid));
    for (const uuid of [...this.#zones.keys()]) {
      if (!live.has(uuid)) this.#zones.delete(uuid);
    }
    for (const uuid of [...this.#groups.keys()]) {
      if (!live.has(uuid)) this.#groups.delete(uuid);
    }

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
        // Converting it anywhere is how a slider sets 1% of what was asked.
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
        media: this.#mediaFromPosition(position, zone.host),
        tracks: integer(textOf(media, 'NrTracks')) ?? 0,
        index: track === null || track < 1 ? null : track - 1,
        shuffle: mode.shuffle,
        repeat: mode.repeat,
      });
    } catch (err) {
      log.debug(`${zone.name} transport did not answer:`, err);
      this.#groups.delete(zone.uuid);
    }
  }

  #mediaFromPosition(position: XmlNode, host: string): MassMedia | null {
    const track = parseTrackMetadata(textOf(position, 'TrackMetaData'));
    if (!track) return null;

    /*
     * For a live stream the station sits in `dc:title` and the song in
     * `r:streamContent`, so preferring the stream line is what stops a radio
     * station showing the same text for an hour. For a file both agree and
     * `streamContent` is absent.
     */
    const title = track.streamContent ?? track.title;
    if (!title) return null;

    const elapsed = seconds(textOf(position, 'RelTime'));

    return {
      title,
      artist: track.artist ?? (track.streamContent ? track.title : null),
      album: track.album,
      art: this.#art.register(artUrl(track.artUri, host)),
      duration: seconds(textOf(position, 'TrackDuration')),
      elapsed,
      elapsedAt: elapsed === null ? null : Date.now(),
    };
  }

  /* ── Shaping ───────────────────────────────────────────────────────────*/

  snapshot(): { players: MassPlayer[]; queues: MassQueue[] } {
    const zones = [...this.#client.household.zones.values()];

    const players: MassPlayer[] = zones.map((zone) => this.#describe(zone, zones));
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

  #describe(zone: SonosZone, all: SonosZone[]): MassPlayer {
    const state = this.#zones.get(zone.uuid);
    const group = this.#groups.get(zone.coordinator);
    const leading = zone.coordinator === zone.uuid;

    return {
      id: zone.uuid,
      name: zone.name,
      type: zone.kind,
      available: state?.reachable ?? false,
      // A follower plays exactly what its coordinator plays, so it reports the
      // group's state rather than its own — which for a grouped Sonos speaker
      // is always STOPPED and would draw a paused speaker that is audibly on.
      state: group?.state ?? 'idle',
      // Sonos speakers have no power concept. The panel already draws no power
      // button when this is null.
      powered: null,
      volume: state?.volume ?? null,
      muted: state?.muted ?? false,
      // A group of one is not a group: a lone speaker listing itself as its
      // own member reads oddly in "Playing on".
      members: zone.group.length > 1 ? zone.group : [],
      syncedTo: leading ? null : zone.coordinator,
      /*
       * Sonos groups anything with anything, so this is every OTHER zone.
       * Phase 1 deliberately left it empty because nothing could honour a
       * grouping request yet; phase 3 can, so the panel gets its group bar.
       */
      canGroupWith: all.filter((z) => z.uuid !== zone.uuid).map((z) => z.uuid),
      queueId: zone.coordinator,
      groupVolume: state?.volume ?? null,
      media: group?.media ?? null,
    };
  }

  /* ── Publishing ────────────────────────────────────────────────────────*/

  #touch(): void {
    this.#dirty = true;
    if (this.#publishTimer) return;
    this.#publishTimer = setTimeout(() => {
      this.#publishTimer = undefined;
      if (this.#dirty) this.#publishNow();
    }, PUBLISH_DEBOUNCE_MS);
    this.#publishTimer.unref();
  }

  #publishNow(): void {
    this.#dirty = false;
    const { players, queues } = this.snapshot();
    this.#listeners.onChange(players, queues);
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
export function playMode(raw: string | null): { shuffle: boolean; repeat: string } {
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

/** The inverse of `playMode`, for setting it. */
export function toPlayMode(shuffle: boolean, repeat: string): string {
  if (shuffle) {
    if (repeat === 'one') return 'SHUFFLE_REPEAT_ONE';
    return repeat === 'all' ? 'SHUFFLE' : 'SHUFFLE_NOREPEAT';
  }
  if (repeat === 'one') return 'REPEAT_ONE';
  return repeat === 'all' ? 'REPEAT_ALL' : 'NORMAL';
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
