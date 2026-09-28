import { WebSocketServer } from 'ws';
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';

/**
 * A mock Cisco RoomOS device, speaking the xAPI over WebSocket (JSON-RPC 2.0)
 * the way a Desk Pro does.
 *
 * The parts worth mocking faithfully:
 *
 *  - Basic auth on the upgrade request, refused with a 401 before any socket
 *    exists — which a client sees as a failed handshake, not a JSON error.
 *  - Feedback is only a nudge. A removed presentation arrives as a `ghost`
 *    entry, and a client that merged events rather than re-reading would
 *    keep showing an input that stopped presenting.
 *  - Connector 1 is the camera, and it is reported with the inputs.
 */
export class MockRoomos {
  #server;
  #http;
  #port;
  #cert;
  #key;
  #sockets = new Set();

  username = 'panel';
  password = 'secret';
  /** Every xCommand received, as { path, params }. */
  commands = [];
  /** Set to refuse Presentation/Start calls that carry an Instance. */
  rejectInstance = false;

  connectors = [
    { id: 1, Type: 'Camera', Connected: 'True' },
    { id: 2, Type: 'HDMI', Connected: 'True' },
    { id: 3, Type: 'USBC', Connected: 'True' },
  ];
  /** The live local presentation, or null. */
  presenting = null;
  /** `Audio Volume` and `Audio VolumeMute`. */
  volume = 40;
  muted = false;

  constructor(port, { cert, key }) {
    this.#port = port;
    this.#cert = cert;
    this.#key = key;
  }

  async start() {
    this.#http = createServer({ cert: readFileSync(this.#cert), key: readFileSync(this.#key) });
    this.#server = new WebSocketServer({
      server: this.#http,
      path: '/ws',
      verifyClient: (info, done) => {
        const want = 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
        if (info.req.headers.authorization === want) done(true);
        else done(false, 401, 'Unauthorized');
      },
    });
    this.#server.on('connection', (ws) => {
      this.#sockets.add(ws);
      ws.subscribed = false;
      ws.on('close', () => this.#sockets.delete(ws));
      ws.on('message', (data) => this.#onMessage(ws, JSON.parse(String(data))));
    });
    await new Promise((resolve) => this.#http.listen(this.#port, '127.0.0.1', resolve));
  }

  async stop() {
    for (const ws of this.#sockets) ws.terminate();
    await new Promise((resolve) => this.#server.close(() => resolve()));
    await new Promise((resolve) => this.#http.close(() => resolve()));
  }

  /** Something changed on the device itself — a laptop plugged in, say. */
  presentLocally(connector, mode = 'LocalOnly') {
    this.presenting = { connector, mode };
    this.#emit({
      Conference: {
        Presentation: { LocalInstance: [{ id: 1, SendingMode: mode, Source: sourceOf(connector) }] },
      },
    });
  }

  /** The volume changed on the device — its own buttons, or a call. */
  setVolumeLocally(level, muted = this.muted) {
    this.volume = level;
    this.muted = muted;
    this.#emit({ Audio: { Volume: level, VolumeMute: muted ? 'On' : 'Off' } });
  }

  stopLocally() {
    this.presenting = null;
    this.#emit({ Conference: { Presentation: { LocalInstance: [{ id: 1, ghost: 'True' }] } } });
  }

  #emit(status) {
    for (const ws of this.#sockets) {
      if (!ws.subscribed) continue;
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'xFeedback/Event', params: { Id: 1, Status: status } }));
    }
  }

  #tree() {
    const presentation = { Mode: this.presenting ? 'Sending' : 'Off' };
    if (this.presenting) {
      presentation.LocalInstance = [
        { id: 1, SendingMode: this.presenting.mode, Source: sourceOf(this.presenting.connector) },
      ];
    }
    return {
      Status: {
        Audio: { Volume: this.volume, VolumeMute: this.muted ? 'On' : 'Off' },
        Conference: { Presentation: presentation },
        Video: {
          Input: {
            Connector: this.connectors,
            // Source ids deliberately differ from connector ids here, so a
            // client that assumed they coincide would read the wrong input.
            Source: this.connectors.map((c) => ({ id: sourceOf(c.id), ConnectorId: c.id })),
          },
        },
      },
    };
  }

  #onMessage(ws, msg) {
    const reply = (body) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...body }));

    if (msg.method === 'xFeedback/Subscribe') {
      ws.subscribed = true;
      return reply({ result: { Id: 1 } });
    }

    if (msg.method === 'xGet') {
      let node = this.#tree();
      for (const key of msg.params.Path) node = node?.[key];
      if (node === undefined) return reply({ error: { code: 3, message: 'No match on Path argument' } });
      return reply({ result: node });
    }

    if (msg.method?.startsWith('xCommand/')) {
      const path = msg.method.slice('xCommand/'.length);
      this.commands.push({ path, params: msg.params });

      if (path === 'Presentation/Start') {
        if (this.rejectInstance && 'Instance' in msg.params) {
          return reply({ error: { code: 4, message: 'Unrecognised argument: Instance' } });
        }
        reply({ result: { status: 'OK' } });
        this.presentLocally(msg.params.ConnectorId, msg.params.SendingMode ?? 'LocalOnly');
        return;
      }
      if (path === 'Presentation/Stop') {
        reply({ result: { status: 'OK' } });
        this.stopLocally();
        return;
      }
      if (path === 'Audio/Volume/Set') {
        reply({ result: { status: 'OK' } });
        this.setVolumeLocally(msg.params.Level);
        return;
      }
      if (path === 'Audio/Volume/Mute' || path === 'Audio/Volume/Unmute') {
        reply({ result: { status: 'OK' } });
        this.setVolumeLocally(this.volume, path.endsWith('/Mute'));
        return;
      }
      // Anything else — volume steps, standby — is accepted, as a real device
      // accepts any valid command; `commands` is what the tests assert on.
      return reply({ result: { status: 'OK' } });
    }
  }
}

/** Source ids are the device's own numbering, not the connector's. */
function sourceOf(connector) {
  return connector + 10;
}
