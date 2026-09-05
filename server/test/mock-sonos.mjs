import { createServer } from 'node:http';

/**
 * A mock Sonos household.
 *
 * **One HTTP server per speaker**, not one for the household. That costs a few
 * lines and buys the thing this suite exists for: every zone has its own
 * address, so a test can give the Living Room a different volume from the
 * Kitchen and catch a store that reads one speaker and reports it for all of
 * them. A single shared endpoint passes that bug.
 *
 * What is modelled is what fails SILENTLY against real hardware:
 *
 *  - **Doubly-escaped XML.** `GetZoneGroupState` returns the topology escaped
 *    inside the SOAP body, and `TrackMetaData` returns DIDL escaped inside
 *    that. A parser that unescapes once too few or too many produces
 *    plausible-looking output rather than an error, so the fixtures carry an
 *    ampersand and angle brackets at both levels.
 *  - **`Invisible="1"` members.** A bonded subwoofer and the right channel of
 *    a stereo pair are real `ZoneGroupMember`s. Showing them puts "Sub" and
 *    "Bedroom (R)" in the player picker.
 *  - **`<Satellite>` elements**, which are nested inside the member they are
 *    bonded to rather than beside it.
 *  - **Followers report STOPPED.** A grouped speaker's own AVTransport says it
 *    is stopped while it is audibly playing; only its coordinator knows. A
 *    store that asks each speaker about itself draws a paused Kitchen during a
 *    party.
 *  - **`SHUFFLE` means shuffle AND repeat-all**, where `SHUFFLE_NOREPEAT` is
 *    the one that means what it says.
 *  - **`NOT_IMPLEMENTED`** for the position of a live stream, which parses to
 *    0 if you let it and draws a progress bar on a radio station.
 */

/** Event endpoints, mirroring the ones the backend subscribes to. */
const SERVICE_OF_EVENT_PATH = {
  '/ZoneGroupTopology/Event': 'ZoneGroupTopology',
  '/MediaRenderer/AVTransport/Event': 'AVTransport',
  '/MediaRenderer/RenderingControl/Event': 'RenderingControl',
};

/** An empty success, which is all Sonos returns for a command. */
function ack(action, service = 'AVTransport') {
  return `<u:${action}Response xmlns:u="urn:schemas-upnp-org:service:${service}:1"/>`;
}

/** Escape exactly once, as a Sonos speaker does at each nesting level. */
function esc(raw) {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The default household.
 *
 * Living Room coordinates a group containing the Kitchen. The Study is
 * standalone and its name carries an ampersand. The Bedroom is a stereo pair,
 * so it has a `ChannelMapSet` and an invisible partner. There is a bonded sub
 * and a home-theatre satellite, neither of which is a speaker anyone points at.
 */
export function defaultZones() {
  return [
    {
      uuid: 'RINCON_LIVING',
      name: 'Living Room',
      coordinator: 'RINCON_LIVING',
      volume: 35,
      mute: false,
      transportState: 'PLAYING',
      playMode: 'SHUFFLE',
      nrTracks: 12,
      trackNo: 3,
      relTime: '0:01:07',
      duration: '0:04:12',
      // The ampersand and the angle brackets are the point of this fixture.
      track: {
        title: 'Rock & Roll <Live>',
        creator: 'Led Zeppelin',
        album: 'Led Zeppelin IV',
        albumArtURI: '/getaa?s=1&u=x-file-cifs%3a%2f%2fnas%2fmusic',
      },
      // A satellite bonded to this room. Nested, and must never be a speaker.
      satellites: [{ uuid: 'RINCON_LIVING_SAT', name: 'Living Room (LS)' }],
    },
    {
      uuid: 'RINCON_KITCHEN',
      name: 'Kitchen',
      coordinator: 'RINCON_LIVING',
      volume: 18,
      mute: false,
      // A grouped follower reports STOPPED about itself. The store must report
      // what its coordinator is doing instead.
      transportState: 'STOPPED',
      playMode: 'NORMAL',
      nrTracks: 0,
      trackNo: 0,
      relTime: '0:00:00',
      duration: '0:00:00',
      track: null,
    },
    {
      uuid: 'RINCON_STUDY',
      name: "Study & Den",
      coordinator: 'RINCON_STUDY',
      volume: 55,
      mute: true,
      transportState: 'PLAYING',
      playMode: 'NORMAL',
      nrTracks: 1,
      trackNo: 1,
      // A live stream: no position, no duration, and the song in streamContent.
      relTime: 'NOT_IMPLEMENTED',
      duration: 'NOT_IMPLEMENTED',
      track: {
        title: 'BBC Radio 6 Music',
        creator: null,
        album: null,
        albumArtURI: null,
        streamContent: 'Sleaford Mods - Nudge It',
      },
    },
    {
      uuid: 'RINCON_BEDROOM',
      name: 'Bedroom',
      coordinator: 'RINCON_BEDROOM',
      volume: 8,
      mute: false,
      transportState: 'PAUSED_PLAYBACK',
      playMode: 'SHUFFLE_NOREPEAT',
      nrTracks: 4,
      trackNo: 2,
      relTime: '0:00:30',
      duration: '0:03:00',
      track: { title: 'Teardrop', creator: 'Massive Attack', album: 'Mezzanine' },
      // Two speakers bonded L/R present as one zone.
      channelMapSet: 'RINCON_BEDROOM:LF,LF;RINCON_BEDROOM_R:RF,RF',
      // The other half. Real member, never a speaker.
      hidden: [{ uuid: 'RINCON_BEDROOM_R', name: 'Bedroom (R)' }],
    },
    {
      uuid: 'RINCON_LIVING_SUB',
      name: 'Living Room (Sub)',
      coordinator: 'RINCON_LIVING',
      invisible: true,
      volume: 50,
      mute: false,
      transportState: 'STOPPED',
      playMode: 'NORMAL',
      nrTracks: 0,
      trackNo: 0,
      relTime: '0:00:00',
      duration: '0:00:00',
      track: null,
    },
  ];
}

export class MockSonos {
  /** uuid → { zone, server, port }. */
  #speakers = new Map();
  /** SID → { uuid, service, callback }. */
  #subs = new Map();
  #sidSeq = 0;

  /** Every SOAP action received, as { uuid, service, action, args }. */
  calls = [];

  /**
   * The ContentDirectory, by object id.
   *
   * The two entries that matter are `FV:2` and `Q:0`. A favourite carries an
   * `r:resMD` that Sonos needs handed back to play it, and a radio favourite's
   * URI scheme is what marks it as a stream rather than something queueable —
   * both are invisible in the shape and decisive in the behaviour.
   */
  containers = {
    'FV:2': [
      {
        id: 'FV:2/1',
        title: 'Morning & Coffee',
        creator: 'Spotify playlist',
        upnpClass: 'object.container.playlistContainer',
        res: 'x-rincon-cpcontainer:1006206cspotify%3aplaylist%3a37i9',
        resMD: '<DIDL-Lite><item id="0"><dc:title>Morning &amp; Coffee</dc:title></item></DIDL-Lite>',
        albumArtURI: '/getaa?u=spotify',
      },
      {
        id: 'FV:2/2',
        title: 'BBC Radio 6 Music',
        upnpClass: 'object.item.audioItem.audioBroadcast',
        // A stream: no end, cannot be queued behind anything.
        res: 'x-sonosapi-stream:s44491?sid=254',
        resMD: '<DIDL-Lite><item id="s44491"><dc:title>BBC 6</dc:title></item></DIDL-Lite>',
      },
    ],
    'SQ:': [
      {
        id: 'SQ:3',
        title: 'Dinner',
        upnpClass: 'object.container.playlistContainer',
        res: 'file:///jffs/settings/savedqueues.rsq#3',
      },
    ],
    'A:ALBUM': [
      {
        id: 'A:ALBUM/Led%20Zeppelin%20IV',
        title: 'Led Zeppelin IV',
        creator: 'Led Zeppelin',
        upnpClass: 'object.container.album.musicAlbum',
        res: 'x-rincon-playlist:RINCON_LIVING#A:ALBUM/Led%20Zeppelin%20IV',
      },
    ],
    'Q:0': [
      {
        id: 'Q:0/1',
        title: 'Black Dog',
        creator: 'Led Zeppelin',
        album: 'Led Zeppelin IV',
        upnpClass: 'object.item.audioItem.musicTrack',
        res: 'x-file-cifs://nas/music/black-dog.flac',
        duration: '0:04:55',
      },
      {
        id: 'Q:0/2',
        title: 'Rock & Roll <Live>',
        creator: 'Led Zeppelin',
        upnpClass: 'object.item.audioItem.musicTrack',
        res: 'x-file-cifs://nas/music/rock-and-roll.flac',
        duration: '0:03:40',
      },
    ],
  };

  /** Every SUBSCRIBE / UNSUBSCRIBE, as { uuid, service, method, sid }. */
  subscriptions = [];

  /** Set to make every speaker answer 500 with a UPnP fault. */
  failing = false;

  /**
   * Accept subscriptions and then never deliver anything.
   *
   * This is what a Docker bridge network looks like from the backend's side:
   * the SUBSCRIBE succeeds, because that is outbound, and the NOTIFY never
   * arrives, because the callback address is unreachable. It is the failure
   * that matters most and the one that cannot be spotted by reading code.
   */
  swallowEvents = false;

  constructor(zones = defaultZones()) {
    this.zones = zones;
  }

  /** Subscriptions currently live, i.e. subscribed and not unsubscribed. */
  get liveSubscriptions() {
    return [...this.#subs.values()];
  }

  zone(uuid) {
    const speaker = this.#speakers.get(uuid);
    if (!speaker) throw new Error(`No mock speaker ${uuid}`);
    return speaker.zone;
  }

  async start() {
    for (const zone of this.zones) {
      const server = createServer((req, res) => this.#handle(zone, req, res));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      this.#speakers.set(zone.uuid, { zone, server, port: server.address().port });
    }
  }

  async stop() {
    for (const { server } of this.#speakers.values()) {
      await new Promise((resolve) => server.close(resolve));
    }
    this.#speakers.clear();
  }

  /** `127.0.0.1:PORT` for one zone — what SONOS_HOST is pointed at. */
  address(uuid) {
    const speaker = this.#speakers.get(uuid);
    if (!speaker) throw new Error(`No mock speaker ${uuid}`);
    return `127.0.0.1:${speaker.port}`;
  }

  /**
   * Change a zone's state, as turning a knob in the Sonos app would — and
   * push the event a real speaker would push.
   *
   * That second half is the point: from phase 2 the backend does not poll, so
   * a mock that only mutates its own state proves nothing. Which service the
   * event goes out on is decided by what changed, exactly as a speaker does.
   */
  async set(uuid, changes) {
    const speaker = this.#speakers.get(uuid);
    if (!speaker) throw new Error(`No mock speaker ${uuid}`);
    Object.assign(speaker.zone, changes);

    const rendering = 'volume' in changes || 'mute' in changes;
    const transport =
      'transportState' in changes ||
      'playMode' in changes ||
      'track' in changes ||
      'nrTracks' in changes ||
      'trackNo' in changes ||
      'duration' in changes;

    if (rendering) await this.#notifyRendering(uuid);
    if (transport) await this.#notifyTransport(uuid);
  }

  /** Move a zone into another's group, as grouping in the Sonos app would. */
  async regroup(uuid, coordinator) {
    this.zone(uuid).coordinator = coordinator;
    await this.#notifyTopology();
  }

  #handle(zone, req, res) {
    if (req.method === 'SUBSCRIBE' || req.method === 'UNSUBSCRIBE') {
      this.#subscription(zone, req, res);
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const soapAction = req.headers['soapaction'] ?? '';
    const match = /#([A-Za-z]+)"?$/.exec(String(soapAction));
    const action = match?.[1] ?? '';
    const service = /urn:[^#]*:service:([A-Za-z]+):1/.exec(String(soapAction))?.[1] ?? '';

    // The body is kept rather than drained: what a command CARRIES is most of
    // what is worth asserting — that SetVolume went to the right speaker with
    // the right number, that joining a group used an `x-rincon:` URI.
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      this.calls.push({ uuid: zone.uuid, service, action, args: soapArgs(raw) });

      if (this.failing) {
        this.#fault(res, 500);
        return;
      }

      const body = this.#respond(zone, action, soapArgs(raw));
      if (body === null) {
        this.#fault(res, 401);
        return;
      }

      const envelope =
        '<?xml version="1.0"?>' +
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">' +
        `<s:Body>${body}</s:Body></s:Envelope>`;

      res.writeHead(200, { 'content-type': 'text/xml; charset="utf-8"' });
      res.end(envelope);
    });
  }

  /* ── GENA ──────────────────────────────────────────────────────────────
     The half of the protocol that makes the panel live rather than polled.
     A real speaker hands back a SID, sends the current state immediately, and
     expects the subscription to be renewed or torn down. */

  #subscription(zone, req, res) {
    const service = SERVICE_OF_EVENT_PATH[req.url ?? ''];
    if (!service) {
      res.writeHead(404).end();
      return;
    }

    req.resume();

    if (req.method === 'UNSUBSCRIBE') {
      const sid = req.headers['sid'] ?? '';
      this.subscriptions.push({ uuid: zone.uuid, service, method: 'UNSUBSCRIBE', sid });
      this.#subs.delete(sid);
      res.writeHead(200).end();
      return;
    }

    // A renewal carries a SID and no CALLBACK; a fresh subscription the other
    // way round. Getting these confused is how a renewal silently creates a
    // second subscription and doubles every event.
    const existing = req.headers['sid'];
    if (existing) {
      this.subscriptions.push({ uuid: zone.uuid, service, method: 'RENEW', sid: existing });
      res.writeHead(200, { SID: existing, TIMEOUT: 'Second-3600' }).end();
      return;
    }

    const callback = /<([^>]+)>/.exec(String(req.headers['callback'] ?? ''))?.[1];
    if (!callback) {
      res.writeHead(412).end();
      return;
    }

    this.#sidSeq += 1;
    const sid = `uuid:mock-${zone.uuid}-${service}-${this.#sidSeq}`;
    this.#subs.set(sid, { uuid: zone.uuid, service, callback });
    this.subscriptions.push({ uuid: zone.uuid, service, method: 'SUBSCRIBE', sid });

    res.writeHead(200, { SID: sid, TIMEOUT: 'Second-3600' }).end();

    // A real speaker sends current state the moment you subscribe, unprompted.
    // That is what lets events REPLACE the initial read rather than supplement
    // it, so a mock that waits for a change would hide a real dependency.
    setTimeout(() => {
      if (service === 'RenderingControl') void this.#notifyRendering(zone.uuid);
      else if (service === 'AVTransport') void this.#notifyTransport(zone.uuid);
      else void this.#notifyTopology();
    }, 10);
  }

  async #notifyRendering(uuid) {
    const zone = this.zone(uuid);
    const body =
      '<Event xmlns="urn:schemas-upnp-org:metadata-1-0/RCS/"><InstanceID val="0">' +
      `<Volume channel="Master" val="${zone.volume}"/>` +
      // A stereo pair reports LF and RF too, and neither is the number anyone
      // means by "the volume". A reader that takes the last one gets the wrong
      // answer for exactly the speakers that are hardest to test against.
      `<Volume channel="LF" val="100"/><Volume channel="RF" val="100"/>` +
      `<Mute channel="Master" val="${zone.mute ? 1 : 0}"/>` +
      '</InstanceID></Event>';
    await this.#notify(uuid, 'RenderingControl', 'LastChange', body);
  }

  async #notifyTransport(uuid) {
    const zone = this.zone(uuid);
    const body =
      '<Event xmlns="urn:schemas-upnp-org:metadata-1-0/AVT/"><InstanceID val="0">' +
      `<TransportState val="${zone.transportState}"/>` +
      `<CurrentPlayMode val="${zone.playMode}"/>` +
      `<NumberOfTracks val="${zone.nrTracks}"/>` +
      `<CurrentTrack val="${zone.trackNo}"/>` +
      `<CurrentTrackDuration val="${zone.duration}"/>` +
      // Escaped INTO an attribute, which is then escaped into the propertyset.
      // Three levels in total once DIDL's own escaping is counted.
      `<CurrentTrackMetaData val="${esc(didl(zone.track))}"/>` +
      '</InstanceID></Event>';
    await this.#notify(uuid, 'AVTransport', 'LastChange', body);
  }

  async #notifyTopology() {
    for (const [, sub] of this.#subs) {
      if (sub.service !== 'ZoneGroupTopology') continue;
      await this.#post(sub, 'ZoneGroupState', this.#topology());
    }
  }

  async #notify(uuid, service, property, value) {
    for (const [, sub] of this.#subs) {
      if (sub.uuid !== uuid || sub.service !== service) continue;
      await this.#post(sub, property, value);
    }
  }

  async #post(sub, property, value) {
    if (this.swallowEvents) return;

    const body =
      '<?xml version="1.0"?>' +
      '<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">' +
      `<e:property><${property}>${esc(value)}</${property}></e:property>` +
      '</e:propertyset>';

    // Find a SID for this subscription: the backend refuses a NOTIFY whose SID
    // it did not mint, so sending one without it would test the guard rather
    // than the path.
    const sid = [...this.#subs.entries()].find(([, s]) => s === sub)?.[0] ?? '';

    try {
      await fetch(sub.callback, {
        method: 'NOTIFY',
        headers: {
          'content-type': 'text/xml; charset="utf-8"',
          nt: 'upnp:event',
          nts: 'upnp:propchange',
          sid,
          seq: '1',
        },
        body,
      });
    } catch {
      // The backend may be shutting down. Not this mock's problem.
    }
  }

  /** A UPnP fault, in the shape a real speaker sends: HTTP 500 with a code. */
  #fault(res, code) {
    res.writeHead(500, { 'content-type': 'text/xml; charset="utf-8"' });
    res.end(
      '<?xml version="1.0"?>' +
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>' +
        '<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>' +
        `<UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode></UPnPError>` +
        '</detail></s:Fault></s:Body></s:Envelope>',
    );
  }

  #respond(zone, action, args) {
    /*
     * Commands. A real speaker applies these and then announces the result on
     * its event stream, so the mock does too — otherwise a test could only
     * ever assert that a request was SENT, never that the panel comes to
     * agree with the speaker afterwards.
     */
    switch (action) {
      case 'SetVolume':
        void this.set(zone.uuid, { volume: Number.parseInt(args.DesiredVolume ?? '0', 10) });
        return ack(action, 'RenderingControl');

      case 'SetMute':
        void this.set(zone.uuid, { mute: args.DesiredMute === '1' });
        return ack(action, 'RenderingControl');

      case 'Play':
        void this.set(zone.uuid, { transportState: 'PLAYING' });
        return ack(action);

      case 'Pause':
        void this.set(zone.uuid, { transportState: 'PAUSED_PLAYBACK' });
        return ack(action);

      case 'Stop':
        void this.set(zone.uuid, { transportState: 'STOPPED' });
        return ack(action);

      case 'SetPlayMode':
        void this.set(zone.uuid, { playMode: args.NewPlayMode ?? 'NORMAL' });
        return ack(action);

      case 'Next':
      case 'Previous':
      case 'Seek':
        return ack(action);

      case 'SetAVTransportURI': {
        // `x-rincon:<uuid>` is how a speaker is told to follow another. It is
        // not an obvious API and it is the only local way to group.
        const leader = /^x-rincon:(.+)$/.exec(args.CurrentURI ?? '')?.[1];
        if (leader) void this.regroup(zone.uuid, leader);
        return ack(action);
      }

      case 'BecomeCoordinatorOfStandaloneGroup':
        void this.regroup(zone.uuid, zone.uuid);
        return ack(action);

      case 'AddURIToQueue':
        return (
          '<u:AddURIToQueueResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">' +
          '<FirstTrackNumberEnqueued>3</FirstTrackNumberEnqueued>' +
          '<NumTracksAdded>1</NumTracksAdded><NewQueueLength>3</NewQueueLength>' +
          '</u:AddURIToQueueResponse>'
        );

      case 'RemoveAllTracksFromQueue':
      case 'RemoveTrackFromQueue':
      case 'ReorderTracksInQueue':
        return ack(action);

      case 'Browse': {
        const rows = this.containers[args.ObjectID ?? ''] ?? searchOf(this.containers, args.ObjectID);
        if (!rows) return null;

        const start = Number.parseInt(args.StartingIndex ?? '0', 10) || 0;
        const count = Number.parseInt(args.RequestedCount ?? '100', 10) || 100;
        const page = rows.slice(start, start + count);

        return (
          '<u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">' +
          // Escaped once: DIDL travels as a string inside the body, exactly as
          // the topology does.
          `<Result>${esc(didlList(page))}</Result>` +
          `<NumberReturned>${page.length}</NumberReturned>` +
          `<TotalMatches>${rows.length}</TotalMatches><UpdateID>1</UpdateID>` +
          '</u:BrowseResponse>'
        );
      }

      case 'ListAvailableServices':
        return (
          '<u:ListAvailableServicesResponse xmlns:u="urn:schemas-upnp-org:service:MusicServices:1">' +
          `<AvailableServiceDescriptorList>${esc(
            '<Services><Service Id="9" Name="Spotify"/></Services>',
          )}</AvailableServiceDescriptorList>` +
          '</u:ListAvailableServicesResponse>'
        );
    }

    switch (action) {
      case 'GetZoneGroupState':
        return (
          '<u:GetZoneGroupStateResponse xmlns:u="urn:schemas-upnp-org:service:ZoneGroupTopology:1">' +
          // Escaped once: the topology travels as a string inside the body.
          `<ZoneGroupState>${esc(this.#topology())}</ZoneGroupState>` +
          '</u:GetZoneGroupStateResponse>'
        );

      case 'GetVolume':
        return (
          '<u:GetVolumeResponse xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">' +
          `<CurrentVolume>${zone.volume}</CurrentVolume></u:GetVolumeResponse>`
        );

      case 'GetMute':
        return (
          '<u:GetMuteResponse xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">' +
          // Sonos writes booleans as 1/0, never true/false.
          `<CurrentMute>${zone.mute ? 1 : 0}</CurrentMute></u:GetMuteResponse>`
        );

      case 'GetTransportInfo':
        return (
          '<u:GetTransportInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">' +
          `<CurrentTransportState>${zone.transportState}</CurrentTransportState>` +
          '<CurrentTransportStatus>OK</CurrentTransportStatus>' +
          '</u:GetTransportInfoResponse>'
        );

      case 'GetPositionInfo':
        return (
          '<u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">' +
          `<Track>${zone.trackNo}</Track>` +
          `<TrackDuration>${zone.duration}</TrackDuration>` +
          `<TrackMetaData>${esc(didl(zone.track))}</TrackMetaData>` +
          `<RelTime>${zone.relTime}</RelTime>` +
          '</u:GetPositionInfoResponse>'
        );

      case 'GetMediaInfo':
        return (
          '<u:GetMediaInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">' +
          `<NrTracks>${zone.nrTracks}</NrTracks>` +
          '</u:GetMediaInfoResponse>'
        );

      case 'GetTransportSettings':
        return (
          '<u:GetTransportSettingsResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">' +
          `<PlayMode>${zone.playMode}</PlayMode>` +
          '</u:GetTransportSettingsResponse>'
        );

      default:
        // Anything the panel should not be reaching for. 401 is what a real
        // speaker answers for an action a service does not have.
        return null;
    }
  }

  /**
   * The `ZoneGroupState` document, before escaping.
   *
   * Grouped by coordinator, which is how a real household reports it, and with
   * each member carrying its OWN address — that is what makes the store talk
   * to four different speakers rather than one.
   */
  #topology() {
    const byCoordinator = new Map();
    for (const zone of this.zones) {
      const list = byCoordinator.get(zone.coordinator) ?? [];
      list.push(zone);
      byCoordinator.set(zone.coordinator, list);
    }

    let xml = '<ZoneGroupState><ZoneGroups>';
    for (const [coordinator, members] of byCoordinator) {
      xml += `<ZoneGroup Coordinator="${coordinator}" ID="${coordinator}:1">`;
      for (const zone of members) {
        const port = this.#speakers.get(zone.uuid)?.port ?? 1400;
        const location = `http://127.0.0.1:${port}/xml/device_description.xml`;

        xml +=
          `<ZoneGroupMember UUID="${zone.uuid}" ZoneName="${esc(zone.name)}" ` +
          `Location="${esc(location)}" Invisible="${zone.invisible ? 1 : 0}" ` +
          `ChannelMapSet="${esc(zone.channelMapSet ?? '')}">`;

        // Satellites nest INSIDE the member they are bonded to.
        for (const sat of zone.satellites ?? []) {
          xml +=
            `<Satellite UUID="${sat.uuid}" ZoneName="${esc(sat.name)}" ` +
            `Location="${esc(location)}" Invisible="1"/>`;
        }
        xml += '</ZoneGroupMember>';

        // The other half of a stereo pair: a sibling member, always invisible.
        for (const half of zone.hidden ?? []) {
          xml +=
            `<ZoneGroupMember UUID="${half.uuid}" ZoneName="${esc(half.name)}" ` +
            `Location="${esc(location)}" Invisible="1"/>`;
        }
      }
      xml += '</ZoneGroup>';
    }
    return `${xml}</ZoneGroups><VanishedDevices/></ZoneGroupState>`;
  }
}

/**
 * The arguments out of a SOAP body.
 *
 * Deliberately naive — the mock is asserting what we sent, so it reads the
 * envelope as text rather than sharing a parser with the code under test. A
 * bug in `sonos/xml.ts` must not be able to make these assertions pass.
 */
function soapArgs(body) {
  const inner = /<u:[A-Za-z]+[^>]*>([\s\S]*?)<\/u:[A-Za-z]+>/.exec(body)?.[1] ?? '';
  const args = {};
  for (const [, name, value] of inner.matchAll(/<([A-Za-z][\w.-]*)>([\s\S]*?)<\/\1>/g)) {
    args[name] = value
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }
  // A self-closing or empty element still counts as present.
  for (const [, name] of inner.matchAll(/<([A-Za-z][\w.-]*)\s*\/>/g)) {
    if (!(name in args)) args[name] = '';
  }
  return args;
}

/**
 * A local-library search: `A:ALBUM:zeppelin`.
 *
 * Sonos addresses these by appending the term to a category id rather than
 * having a search action, which is the detail this exists to exercise.
 */
function searchOf(containers, objectId) {
  if (typeof objectId !== 'string') return null;
  const colon = objectId.lastIndexOf(':');
  if (colon <= 1) return null;

  const category = objectId.slice(0, colon);
  const term = objectId.slice(colon + 1).toLowerCase();
  const rows = containers[category];
  if (!rows || term.length === 0) return null;

  return rows.filter((r) => r.title.toLowerCase().includes(term));
}

/** DIDL-Lite for a browse result, before escaping. */
function didlList(rows) {
  let items = '';
  for (const row of rows) {
    const container = row.upnpClass.includes('container');
    const tag = container ? 'container' : 'item';

    let inner = `<dc:title>${esc(row.title)}</dc:title>`;
    inner += `<upnp:class>${row.upnpClass}</upnp:class>`;
    if (row.creator) inner += `<dc:creator>${esc(row.creator)}</dc:creator>`;
    if (row.album) inner += `<upnp:album>${esc(row.album)}</upnp:album>`;
    if (row.albumArtURI) inner += `<upnp:albumArtURI>${esc(row.albumArtURI)}</upnp:albumArtURI>`;
    if (row.res) {
      const duration = row.duration ? ` duration="${row.duration}"` : '';
      inner += `<res${duration} protocolInfo="x">${esc(row.res)}</res>`;
    }
    // The field that decides whether a favourite plays or plays silence.
    if (row.resMD) inner += `<r:resMD>${esc(row.resMD)}</r:resMD>`;

    items += `<${tag} id="${esc(row.id)}" parentID="-1" restricted="true">${inner}</${tag}>`;
  }

  return (
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" ' +
    'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
    `${items}</DIDL-Lite>`
  );
}

/** DIDL-Lite for one track, before escaping. */
function didl(track) {
  if (!track) return '';

  let item = '';
  if (track.title !== null && track.title !== undefined) {
    item += `<dc:title>${esc(track.title)}</dc:title>`;
  }
  if (track.creator) item += `<dc:creator>${esc(track.creator)}</dc:creator>`;
  if (track.album) item += `<upnp:album>${esc(track.album)}</upnp:album>`;
  if (track.albumArtURI) {
    item += `<upnp:albumArtURI>${esc(track.albumArtURI)}</upnp:albumArtURI>`;
  }
  if (track.streamContent) {
    item += `<r:streamContent>${esc(track.streamContent)}</r:streamContent>`;
  }

  return (
    '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ' +
    'xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" ' +
    'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">' +
    `<item id="-1" parentID="-1" restricted="true">${item}</item>` +
    '</DIDL-Lite>'
  );
}
