import { WebSocketServer } from 'ws';
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';

/**
 * A mock LG webOS television, speaking real SSAP.
 *
 * The parts worth mocking faithfully are the ones easy to get wrong against
 * a real set and impossible to check by reading:
 *
 *  - Registration is TWO frames when unpaired: a `response` carrying
 *    `pairingType: "PROMPT"` (the TV asking someone to press Yes with the
 *    remote), then `registered` with a client-key once they do. A client that
 *    treats the first as the answer looks like it works and never stores a key.
 *  - A refusal is an ordinary `response` with `returnValue: false`, not an
 *    error frame.
 *  - The set being OFF means nothing is listening at all — not a socket that
 *    answers with an error. That is why `stop()` exists.
 */
export class MockWebosTv {
  #server;
  #port;
  #http;
  #tls;
  #cert;
  #key;

  /** Every command received, as { uri, payload }. */
  commands = [];
  /** Registrations received, as { clientKey }. */
  registrations = [];

  /** Set to make the TV demand a prompt before pairing. */
  requirePrompt = false;
  /** How long the TV waits before "somebody accepts" the prompt, in ms. */
  promptDelayMs = 30;
  /** The key handed out on a successful registration. */
  clientKey = 'mock-client-key';
  /** URIs to refuse with returnValue:false. */
  refuse = new Set();
  /** What the set is currently showing, or undefined for "not saying". */
  foregroundAppId = undefined;
  /**
   * Set false for a television that accepts commands but never says what it
   * is showing — which is the shape of set that made the input key appear to
   * work for only one input.
   */
  reportsInput = true;
  /** Keys the set refuses outright, whatever manifest comes with them. */
  rejectKeys = new Set();

  inputs = [
    { id: 'HDMI_1', label: 'HDMI 1', connected: true },
    { id: 'HDMI_2', label: 'Laptop', connected: true },
    { id: 'HDMI_3', label: 'Mac Studio', connected: true },
  ];

  /**
   * `tls` serves wss, the way a 2020-or-later set does on 3001. A modern TV
   * leaves 3000 closed; an older one leaves 3001 closed. Both shapes are
   * worth being able to mock, because the client has to find whichever is
   * actually there.
   */
  constructor(port, { tls = false, cert, key } = {}) {
    this.#port = port;
    this.#tls = tls;
    this.#cert = cert;
    this.#key = key;
  }

  async start() {
    if (this.#tls) {
      this.#http = createServer({
        cert: readFileSync(this.#cert),
        key: readFileSync(this.#key),
      });
      this.#server = new WebSocketServer({ server: this.#http });
      await new Promise((resolve) => this.#http.listen(this.#port, '127.0.0.1', resolve));
    } else {
      this.#server = new WebSocketServer({ port: this.#port, host: '127.0.0.1' });
    }
    this.#server.on('connection', (socket) => {
      socket.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        this.#handle(socket, msg);
      });
    });
    if (!this.#tls) {
      await new Promise((resolve) => this.#server.once('listening', resolve));
    }
  }

  #handle(socket, msg) {
    const reply = (frame) => socket.send(JSON.stringify(frame));

    if (msg.type === 'register') {
      const offered = msg.payload?.['client-key'];
      const manifest = msg.payload?.manifest;
      this.registrations.push({ clientKey: offered, manifest });

      /*
       * A real television checks the manifest, and this mock did not — which
       * is exactly how a handshake that sent the manifest FLAT (rather than
       * nested under `manifest`) passed every test here and then failed on
       * the actual set. The TV registered the client, handed back a key, and
       * granted nothing; every command came back 401.
       *
       * So the contract is enforced: no nested manifest with permissions
       * means the client is registered but authorised for nothing, which is
       * what the set really does.
       */
      // Two separate reasons a command can come back 401, kept apart because
      // conflating them let a good manifest clear a key the test had
      // deliberately blacklisted:
      //
      //   - the manifest granted nothing (a per-connection property), or
      //   - this key is one the set refuses outright (a test fixture).
      const granted = Array.isArray(manifest?.permissions) && manifest.permissions.length > 0;
      socket.authorised = granted && !this.rejectKeys.has(offered);

      // A known key pairs straight through; an unknown one has to be accepted
      // on the television first.
      if (this.requirePrompt && offered !== this.clientKey) {
        reply({ id: msg.id, type: 'response', payload: { pairingType: 'PROMPT', returnValue: true } });
        setTimeout(() => {
          reply({ id: msg.id, type: 'registered', payload: { 'client-key': this.clientKey } });
        }, this.promptDelayMs);
        return;
      }
      reply({ id: msg.id, type: 'registered', payload: { 'client-key': this.clientKey } });
      return;
    }

    if (msg.type === 'subscribe') {
      this.subscribeId = msg.id;
      reply({ id: msg.id, type: 'response', payload: { returnValue: true } });
      return;
    }

    if (msg.type !== 'request') return;

    // Registered but not authorised: the set answers, and refuses everything.
    if (socket.authorised === false) {
      reply({ id: msg.id, type: 'error', error: '401 insufficient permissions' });
      return;
    }

    this.commands.push({ uri: msg.uri, payload: msg.payload });

    if (this.refuse.has(msg.uri)) {
      reply({
        id: msg.id,
        type: 'response',
        payload: { returnValue: false, errorText: 'Refused by the TV' },
      });
      return;
    }

    /*
     * Switching an input makes the TV report a new foreground app, because
     * an external input IS an app to webOS. A mock that accepts the command
     * and says nothing back would let a client that never subscribes look
     * exactly like one that does.
     */
    if (msg.uri === 'ssap://tv/switchInput' && this.subscribeId) {
      const id = String(msg.payload?.inputId ?? '');
      const n = /^HDMI_(\d+)$/i.exec(id)?.[1];
      if (n && this.reportsInput) {
        this.foregroundAppId = `com.webos.app.hdmi${n}`;
        reply({ id: msg.id, type: 'response', payload: { returnValue: true } });
        reply({
          id: this.subscribeId,
          type: 'response',
          payload: { returnValue: true, appId: `com.webos.app.hdmi${n}` },
        });
        // Already recorded above, with every other request.
        return;
      }
    }

    // A real set answers this with whatever it is showing. Answering it with
    // an empty success would let a client that mishandles "the reply does
    // not say" look identical to one that gets it right.
    if (msg.uri === 'ssap://com.webos.applicationManager/getForegroundAppInfo') {
      reply({
        id: msg.id,
        type: 'response',
        payload: this.foregroundAppId
          ? { returnValue: true, appId: this.foregroundAppId }
          : { returnValue: true },
      });
      return;
    }

    if (msg.uri === 'ssap://tv/getExternalInputList') {
      reply({ id: msg.id, type: 'response', payload: { returnValue: true, devices: this.inputs } });
      return;
    }

    reply({ id: msg.id, type: 'response', payload: { returnValue: true } });
  }

  /** Open sockets, for a harness that wants to push a subscription update. */
  rawClients() {
    return this.#server ? [...this.#server.clients] : [];
  }

  async stop() {
    if (!this.#server) return;
    for (const client of this.#server.clients) client.terminate();
    await new Promise((resolve) => this.#server.close(resolve));
    if (this.#http) {
      await new Promise((resolve) => this.#http.close(resolve));
      this.#http = undefined;
    }
    this.#server = undefined;
  }
}
