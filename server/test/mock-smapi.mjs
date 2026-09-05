import { createServer } from 'node:http';

/**
 * A stand-in music service, speaking SMAPI.
 *
 * This is the other half of the Sonos integration and the half that leaves the
 * house: Plex, SoundCloud, YouTube Music and Sonos Radio all expose one of
 * these, and the backend talks to them in the same dialect the speakers use.
 *
 * What is worth modelling here is not the happy path — it is the two answers
 * that are easy to get wrong:
 *
 *  - **`NOT_LINKED_RETRY` is a SOAP FAULT**, not a result. A service says
 *    "they have not confirmed yet" by failing, so a client that treats every
 *    fault as an error can never finish a device link.
 *  - **Credentials ride in the SOAP HEADER**, not the body, and a call without
 *    them must be refused. Getting that wrong produces a client that appears
 *    to work against an anonymous service and fails against every real one.
 */

const NS = 'http://www.sonos.com/Services/1.1';

/** The calls that obtain a token, and so cannot be asked to present one. */
const LINK_ACTIONS = new Set(['getDeviceLinkCode', 'getAppLink', 'getDeviceAuthToken']);

export class MockSmapi {
  /** Every request, as `{ action, hasToken, body }`. */
  calls = [];

  /** Set false to make the service reject anything without a login token. */
  anonymous = false;

  /**
   * Make the link calls themselves fail, with this fault string.
   *
   * The case that mattered: a service that will not even START a link. What it
   * says is the only account of why, and it was being replaced with "connect
   * this service" — advice to do the thing that had just failed.
   */
  refuseLink = null;
  linkDeviceId = 'private-device-proof';
  faultStatus = 500;
  faults = {};
  rawResponse = null;

  /** How many `getDeviceAuthToken` polls to refuse before granting one. */
  pollsBeforeLink = 1;

  #polls = 0;
  #server;

  /** Containers, by id. `root` is the top level every service must answer. */
  catalog = {
    root: [
      { id: 'stations', itemType: 'container', title: 'Stations' },
      { id: 'playlists', itemType: 'container', title: 'My Playlists' },
    ],
    stations: [
      {
        id: 'st-1',
        itemType: 'stream',
        title: 'Ambient Sleeping Pill',
        albumArtURI: 'https://example.invalid/art/asp.jpg',
      },
    ],
    playlists: [
      { id: 'pl-1', itemType: 'playlist', title: 'Late Night' },
    ],
    'pl-1': [
      {
        id: 'tr-1',
        itemType: 'track',
        title: 'Nightswimming',
        artist: 'R.E.M.',
        album: 'Automatic for the People',
        duration: 256,
      },
    ],
  };

  /** Search results, by category. */
  results = {
    albums: [{ id: 'al-9', itemType: 'album', title: 'Kid A', artist: 'Radiohead' }],
    tracks: [{ id: 'tr-9', itemType: 'track', title: 'Idioteque', artist: 'Radiohead' }],
  };

  async start() {
    this.#server = createServer((req, res) => this.#handle(req, res));
    await new Promise((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
    return this.url;
  }

  get url() {
    return `http://127.0.0.1:${this.#server.address().port}/smapi`;
  }

  async stop() {
    if (this.#server) await new Promise((resolve) => this.#server.close(resolve));
  }

  #handle(req, res) {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const action = /#([A-Za-z]+)"?$/.exec(String(req.headers['soapaction'] ?? ''))?.[1] ?? '';
      const hasToken = raw.includes('<loginToken>');
      this.calls.push({ action, hasToken, body: raw });

      /*
       * The link calls are the ONE set that must work without a token — they
       * are how a token is obtained. Everything else is refused, which is what
       * separates a client that works against an anonymous service from one
       * that works against a real one.
       */
      if (this.rawResponse !== null) {
        res.writeHead(200, { 'content-type': 'text/xml' });
        res.end(this.rawResponse);
        return;
      }
      if (this.faults[action]) {
        const fault = this.faults[action];
        if (fault.once) delete this.faults[action];
        this.#fault(res, fault.code, fault.detail ?? '');
        return;
      }
      if (action === 'getDeviceAuthToken' && tag(raw, 'linkDeviceId') !== this.linkDeviceId) {
        this.#fault(res, 'Client.NOT_LINKED_FAILURE');
        return;
      }
      const linking = LINK_ACTIONS.has(action);
      if (linking && this.refuseLink) {
        this.#fault(res, this.refuseLink);
        return;
      }
      if (!this.anonymous && !hasToken && !linking) {
        this.#fault(res, 'Client.LoginUnauthorized');
        return;
      }

      const body = this.#respond(action, raw);
      if (body === null) {
        this.#fault(res, 'Client.NOT_LINKED_RETRY');
        return;
      }

      res.writeHead(200, { 'content-type': 'text/xml; charset="utf-8"' });
      res.end(
        '<?xml version="1.0"?>' +
          '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">' +
          `<s:Body>${body}</s:Body></s:Envelope>`,
      );
    });
  }

  #respond(action, raw) {
    switch (action) {
      case 'getMetadata': {
        const id = tag(raw, 'id') ?? 'root';
        const rows = this.catalog[id] ?? [];
        return `<getMetadataResponse xmlns="${NS}"><getMetadataResult>` +
          `<index>0</index><count>${rows.length}</count><total>${rows.length}</total>` +
          rows.map((r) => this.#row(r)).join('') +
          '</getMetadataResult></getMetadataResponse>';
      }

      case 'search': {
        const rows = this.results[tag(raw, 'id') ?? ''] ?? [];
        return `<searchResponse xmlns="${NS}"><searchResult>` +
          `<index>0</index><count>${rows.length}</count><total>${rows.length}</total>` +
          rows.map((r) => this.#row(r)).join('') +
          '</searchResult></searchResponse>';
      }

      case 'getDeviceLinkCode':
        return `<getDeviceLinkCodeResponse xmlns="${NS}"><getDeviceLinkCodeResult>` +
          '<regUrl>https://example.invalid/link</regUrl>' +
          '<linkCode>ABCD-1234</linkCode>' +
          '<showLinkCode>true</showLinkCode>' +
          `<linkDeviceId>${escapeXml(this.linkDeviceId)}</linkDeviceId>` +
          '</getDeviceLinkCodeResult></getDeviceLinkCodeResponse>';

      /*
       * The newer policy, and a DIFFERENT call with the same three fields
       * buried one level deeper. A client that only ever asks for a device
       * link code can never connect an AppLink service at all.
       */
      case 'getAppLink':
        return `<getAppLinkResponse xmlns="${NS}"><getAppLinkResult><authorizeAccount>` +
          '<appUrlStringId>SONOS_APP_LINK</appUrlStringId><deviceLink>' +
          '<regUrl>https://example.invalid/app-link</regUrl>' +
          '<linkCode>WXYZ-9876</linkCode>' +
          '<showLinkCode>true</showLinkCode>' +
          `<linkDeviceId>${escapeXml(this.linkDeviceId)}</linkDeviceId>` +
          '</deviceLink></authorizeAccount></getAppLinkResult></getAppLinkResponse>';

      case 'getDeviceAuthToken':
        // Null becomes NOT_LINKED_RETRY: the person has not said yes yet.
        if (this.#polls++ < this.pollsBeforeLink) return null;
        return `<getDeviceAuthTokenResponse xmlns="${NS}"><getDeviceAuthTokenResult>` +
          '<authToken>tok-abc</authToken><privateKey>key-xyz</privateKey>' +
          '</getDeviceAuthTokenResult></getDeviceAuthTokenResponse>';

      default:
        return null;
    }
  }

  /** A catalog row. Collections and items are different elements. */
  #row(r) {
    const collection = r.itemType !== 'track' && r.itemType !== 'stream';
    const el = collection ? 'mediaCollection' : 'mediaMetadata';

    const inner =
      `<id>${r.id}</id><itemType>${r.itemType}</itemType>` +
      `<title>${escapeXml(r.title)}</title>` +
      (r.albumArtURI ? `<albumArtURI>${r.albumArtURI}</albumArtURI>` : '');

    // A track's artist and duration live one level down, inside
    // `trackMetadata` — a nesting that is easy to miss and leaves every
    // result with a blank second line.
    const meta = collection
      ? r.artist
        ? `<artist>${escapeXml(r.artist)}</artist>`
        : ''
      : '<trackMetadata>' +
        (r.artist ? `<artist>${escapeXml(r.artist)}</artist>` : '') +
        (r.album ? `<album>${escapeXml(r.album)}</album>` : '') +
        (r.duration ? `<duration>${r.duration}</duration>` : '') +
        '</trackMetadata>';

    return `<${el}>${inner}${meta}</${el}>`;
  }

  #fault(res, code, detail = '') {
    res.writeHead(this.faultStatus, { 'content-type': 'text/xml; charset="utf-8"' });
    res.end(
      '<?xml version="1.0"?>' +
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>' +
        `<faultcode>${code}</faultcode>` +
        '<faultstring>The request could not complete</faultstring>' +
        `<detail><ExceptionInfo>${code}</ExceptionInfo>${detail}</detail>` +
        '</s:Fault></s:Body></s:Envelope>',
    );
  }
}

function tag(xml, name) {
  return new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? null;
}

function escapeXml(raw) {
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
