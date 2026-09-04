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

  /** Every SOAP action received, as { uuid, service, action }. */
  calls = [];

  /** Set to make every speaker answer 500 with a UPnP fault. */
  failing = false;

  constructor(zones = defaultZones()) {
    this.zones = zones;
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

  /** Change a zone's state, as turning a knob in the Sonos app would. */
  set(uuid, changes) {
    const speaker = this.#speakers.get(uuid);
    if (!speaker) throw new Error(`No mock speaker ${uuid}`);
    Object.assign(speaker.zone, changes);
  }

  #handle(zone, req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }

    const soapAction = req.headers['soapaction'] ?? '';
    const match = /#([A-Za-z]+)"?$/.exec(String(soapAction));
    const action = match?.[1] ?? '';
    const service = /urn:[^#]*:service:([A-Za-z]+):1/.exec(String(soapAction))?.[1] ?? '';

    // Drain the body: a client that gets a reply before it finished sending
    // sees ECONNRESET on some Node versions.
    req.resume();
    req.on('end', () => {
      this.calls.push({ uuid: zone.uuid, service, action });

      if (this.failing) {
        this.#fault(res, 500);
        return;
      }

      const body = this.#respond(zone, action);
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

  #respond(zone, action) {
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
