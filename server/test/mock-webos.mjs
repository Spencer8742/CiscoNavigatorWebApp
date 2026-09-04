import { WebSocketServer } from 'ws';

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

  inputs = [
    { id: 'HDMI_1', label: 'HDMI 1', connected: true },
    { id: 'HDMI_2', label: 'Laptop', connected: true },
    { id: 'HDMI_3', label: 'Mac Studio', connected: true },
  ];

  constructor(port) {
    this.#port = port;
  }

  async start() {
    this.#server = new WebSocketServer({ port: this.#port, host: '127.0.0.1' });
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
    await new Promise((resolve) => this.#server.once('listening', resolve));
  }

  #handle(socket, msg) {
    const reply = (frame) => socket.send(JSON.stringify(frame));

    if (msg.type === 'register') {
      const offered = msg.payload?.['client-key'];
      this.registrations.push({ clientKey: offered });

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

    if (msg.type !== 'request') return;
    this.commands.push({ uri: msg.uri, payload: msg.payload });

    if (this.refuse.has(msg.uri)) {
      reply({
        id: msg.id,
        type: 'response',
        payload: { returnValue: false, errorText: 'Refused by the TV' },
      });
      return;
    }

    if (msg.uri === 'ssap://tv/getExternalInputList') {
      reply({ id: msg.id, type: 'response', payload: { returnValue: true, devices: this.inputs } });
      return;
    }

    reply({ id: msg.id, type: 'response', payload: { returnValue: true } });
  }

  async stop() {
    if (!this.#server) return;
    for (const client of this.#server.clients) client.terminate();
    await new Promise((resolve) => this.#server.close(resolve));
    this.#server = undefined;
  }
}
