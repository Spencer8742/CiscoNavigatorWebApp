import { createServer } from 'node:net';

/**
 * A stand-in for a Google Nest Hub, speaking the real Cast v2 protocol.
 *
 * ## Why the protobuf is written out again here
 *
 * This file deliberately does NOT import the encoder it is testing. A mock
 * that shares the implementation under test agrees with it by construction:
 * swap the field numbers around in both and every test still passes, while
 * nothing on the wall works. Written independently from the published
 * `cast_channel.proto`, the two have to agree about the actual format for the
 * suite to be green.
 *
 * ## What it models
 *
 *   - the platform receiver at `receiver-0`, answering GET_STATUS and LAUNCH
 *   - a receiver that takes time to register its channel (`readyAfter`), which
 *     is the failure the sender's polling exists for
 *   - the heartbeat, so a sender that ignores PING can be caught
 *   - DashCast's own channel, recording every URL it is handed
 *
 * It is plain TCP rather than TLS. A real device wraps this in a certificate
 * that verifies against nothing published (see device.ts), so the handshake is
 * Node's code, not this project's, and testing it would test OpenSSL.
 */

const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat';
const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';
const NS_DASHCAST = 'urn:x-cast:com.madmod.dashcast';

const DASHCAST_APP_ID = '84912283';
const TRANSPORT_ID = 'web-9';

/* ── protobuf, from cast_channel.proto ─────────────────────────────────────
   message CastMessage {
     required ProtocolVersion protocol_version = 1;
     required string          source_id        = 2;
     required string          destination_id   = 3;
     required string          namespace        = 4;
     required PayloadType     payload_type     = 5;
     optional string          payload_utf8     = 6;
   } */

function putVarint(out, value) {
  let rest = value;
  do {
    const byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    out.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);
}

function putString(out, fieldNumber, text) {
  putVarint(out, fieldNumber * 8 + 2);
  const bytes = Buffer.from(text, 'utf8');
  putVarint(out, bytes.length);
  for (const b of bytes) out.push(b);
}

function putUint(out, fieldNumber, value) {
  putVarint(out, fieldNumber * 8 + 0);
  putVarint(out, value);
}

function encode({ namespace, source, destination, payload }) {
  const body = [];
  putUint(body, 1, 0); // protocol_version
  putString(body, 2, source);
  putString(body, 3, destination);
  putString(body, 4, namespace);
  putUint(body, 5, 0); // payload_type: STRING
  putString(body, 6, payload);

  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, Buffer.from(body)]);
}

function getVarint(buf, at) {
  let value = 0;
  let scale = 1;
  let pos = at;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated varint');
    const byte = buf[pos++];
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return [value, pos];
    scale *= 128;
  }
}

/**
 * Fields 1-5 are `required` in cast_channel.proto.
 *
 * Enforced here because a real device enforces it — its protobuf-lite parser
 * rejects a message with a required field missing, and a sender that omits
 * `protocol_version` because it happens to be zero gets silence rather than
 * an error. A permissive mock would call that correct.
 */
const REQUIRED_FIELDS = [1, 2, 3, 4, 5];

function decode(body) {
  const out = { namespace: '', source: '', destination: '', payload: '' };
  const seen = new Set();
  let pos = 0;
  while (pos < body.length) {
    let tag;
    [tag, pos] = getVarint(body, pos);
    const fieldNumber = Math.floor(tag / 8);
    const wireType = tag & 7;
    seen.add(fieldNumber);
    if (wireType === 0) {
      [, pos] = getVarint(body, pos);
    } else if (wireType === 2) {
      let len;
      [len, pos] = getVarint(body, pos);
      const text = body.subarray(pos, pos + len).toString('utf8');
      pos += len;
      if (fieldNumber === 2) out.source = text;
      else if (fieldNumber === 3) out.destination = text;
      else if (fieldNumber === 4) out.namespace = text;
      else if (fieldNumber === 6) out.payload = text;
    } else {
      throw new Error(`unexpected wire type ${wireType}`);
    }
  }

  const missing = REQUIRED_FIELDS.filter((f) => !seen.has(f));
  if (missing.length > 0) {
    throw new Error(`CastMessage is missing required field(s) ${missing.join(', ')}`);
  }
  return out;
}

export class MockCastDevice {
  #server;
  #sockets = new Set();
  /** GET_STATUS calls since the last launch. Drives `readyAfter`. */
  #statusCalls = 0;

  /**
   * @param {object} [options]
   * @param {boolean} [options.running]      DashCast is already up.
   * @param {number}  [options.readyAfter]   GET_STATUS calls before the app
   *                                         reports its channel. 0 = at once.
   * @param {boolean} [options.refuseLaunch] Answer LAUNCH with LAUNCH_ERROR.
   * @param {boolean} [options.ping]         Send a heartbeat PING on connect.
   */
  constructor(options = {}) {
    this.options = options;
    this.running = options.running ?? false;
    /** Every URL handed to DashCast, in order. */
    this.loads = [];
    /** Every LAUNCH accepted. */
    this.launches = 0;
    /** Frames received, for assertions about what the sender actually sent. */
    this.received = [];
    /** PONGs received, to prove the sender answers the heartbeat. */
    this.pongs = 0;
    /** Messages the device could not parse. Should always be empty. */
    this.protocolErrors = [];
    /** Connections accepted, whatever was then spoken over them. */
    this.connections = 0;

    this.#server = createServer((socket) => this.#serve(socket));
  }

  /** Listens on an OS-assigned port and returns `host:port`. */
  async start() {
    await new Promise((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
    return `127.0.0.1:${this.#server.address().port}`;
  }

  async stop() {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    await new Promise((resolve) => this.#server.close(resolve));
  }

  /** Something else took the screen — a timer, a voice answer, a reboot. */
  interrupt() {
    this.running = false;
    this.#statusCalls = 0;
  }

  #serve(socket) {
    this.connections += 1;
    this.#sockets.add(socket);
    let buffer = Buffer.alloc(0);

    const send = (namespace, destination, payload) => {
      if (socket.destroyed) return;
      socket.write(
        encode({
          namespace,
          source: 'receiver-0',
          destination,
          payload: JSON.stringify(payload),
        }),
      );
    };

    socket.on('close', () => this.#sockets.delete(socket));
    socket.on('error', () => this.#sockets.delete(socket));

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) return;
        let frame;
        try {
          frame = decode(buffer.subarray(4, 4 + length));
        } catch (err) {
          // What a real device does with a message it cannot parse: nothing,
          // then eventually nothing at all.
          this.protocolErrors.push(err.message);
          socket.destroy();
          return;
        }
        buffer = buffer.subarray(4 + length);
        this.#handle(frame, send);
      }
    });

    if (this.options.ping) {
      setTimeout(() => send(NS_HEARTBEAT, 'sender-navigator', { type: 'PING' }), 20);
    }
  }

  #handle(frame, send) {
    this.received.push(frame);
    // A device that is listening but wedged: it accepts everything and
    // answers nothing.
    if (this.options.mute) return;
    let payload;
    try {
      payload = JSON.parse(frame.payload);
    } catch {
      return;
    }

    if (frame.namespace === NS_HEARTBEAT) {
      if (payload.type === 'PING') send(NS_HEARTBEAT, frame.source, { type: 'PONG' });
      if (payload.type === 'PONG') this.pongs += 1;
      return;
    }

    if (frame.namespace === NS_CONNECTION) return;

    if (frame.namespace === NS_DASHCAST) {
      // A URL sent before DashCast has registered its channel is dropped on
      // the floor by a real device. Modelled, because a sender that does not
      // wait would otherwise look correct here and fail on a real Hub.
      if (!this.#ready()) return;
      this.loads.push(payload);
      return;
    }

    if (frame.namespace !== NS_RECEIVER) return;

    if (payload.type === 'GET_STATUS') {
      this.#statusCalls += 1;
      send(NS_RECEIVER, frame.source, {
        type: 'RECEIVER_STATUS',
        requestId: payload.requestId,
        status: this.#status(),
      });
      return;
    }

    if (payload.type === 'LAUNCH') {
      if (this.options.refuseLaunch) {
        send(NS_RECEIVER, frame.source, {
          type: 'LAUNCH_ERROR',
          requestId: payload.requestId,
          reason: 'NOT_AVAILABLE',
        });
        return;
      }
      this.launches += 1;
      this.running = payload.appId === DASHCAST_APP_ID;
      this.#statusCalls = 0;
      send(NS_RECEIVER, frame.source, {
        type: 'RECEIVER_STATUS',
        requestId: payload.requestId,
        status: this.#status(),
      });
    }
  }

  /** Whether the launched receiver has finished registering its channel. */
  #ready() {
    return this.running && this.#statusCalls >= (this.options.readyAfter ?? 0);
  }

  #status() {
    if (!this.running) return { applications: [], volume: { level: 0.5, muted: false } };
    return {
      applications: [
        {
          appId: DASHCAST_APP_ID,
          displayName: 'DashCast',
          sessionId: 'session-1',
          statusText: 'DashCast',
          transportId: TRANSPORT_ID,
          // The whole point of `readyAfter`: the app is listed before its
          // channel exists.
          namespaces: this.#ready()
            ? [{ name: NS_DASHCAST }, { name: NS_CONNECTION }]
            : [{ name: NS_CONNECTION }],
        },
      ],
      volume: { level: 0.5, muted: false },
    };
  }
}
