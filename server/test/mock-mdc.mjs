import { createServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { readFileSync } from 'node:fs';

/**
 * A Samsung display that speaks MDC on a TCP port.
 *
 * Holds power, volume, mute and input and answers the commands the client
 * uses. `bootMs` makes it go silent for that long after power on, like a
 * real set booting. `statusSupported: false` NAKs the 0x00 status read, like some models;
 * `standbyNaks: true` NAKs everything but power while off. With `pin` and a
 * cert/key, it runs the Secure MDC handshake first.
 */
export class MockMdc {
  constructor(port, opts = {}) {
    this.port = port;
    this.opts = { displayId: 0, statusSupported: true, standbyNaks: true, ...opts };
    this.state = { power: 0, volume: 12, mute: 0, input: 0x21 };
    this.frames = [];
    this.connections = 0;
    this.sockets = new Set();
  }

  start() {
    this.server = createServer((socket) => {
      this.connections += 1;
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => {});
      if (this.opts.pin) this.#secure(socket);
      else this.#serve(socket);
    });
    return new Promise((r) => this.server.listen(this.port, '127.0.0.1', r));
  }

  stop() {
    for (const s of this.sockets) s.destroy();
    return new Promise((r) => this.server.close(() => r()));
  }

  #secure(raw) {
    raw.write('MDCSTART<<TLS>>');
    const ctx = {
      cert: readFileSync(this.opts.cert),
      key: readFileSync(this.opts.key),
    };
    const tlsServer = createTlsServer(ctx);
    tlsServer.on('secureConnection', (tls) => {
      tls.on('error', () => {});
      tls.once('data', (pin) => {
        if (pin.toString() === this.opts.pin) {
          tls.write('MDCAUTH<<PASS>>');
          this.#serve(tls);
        } else {
          tls.end('MDCAUTH<<FAIL:0001>>');
        }
      });
    });
    tlsServer.emit('connection', raw);
  }

  #serve(socket) {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const start = buf.indexOf(0xaa);
        if (start < 0 || buf.length < start + 4) return;
        const len = buf[start + 3];
        const end = start + 4 + len + 1;
        if (buf.length < end) return;
        const cmd = buf[start + 1];
        const id = buf[start + 2];
        const data = [...buf.subarray(start + 4, end - 1)];
        buf = buf.subarray(end);
        this.frames.push({ cmd, id, data });
        if (id !== this.opts.displayId) continue; // wrong id: ignored, as a real set does
        // Booting after power on: a real set ACKs the power command and then
        // answers nothing at all for a few seconds.
        if (this.bootingUntil && Date.now() < this.bootingUntil) continue;
        // `silentReadsInStandby`: a set that never answers a read while off.
        if (this.opts.silentReadsInStandby && this.state.power === 0 && data.length === 0) continue;
        socket.write(this.#answer(cmd, data));
      }
    });
  }

  #answer(cmd, data) {
    const s = this.state;
    const ack = (values) => reply(this.opts.displayId, 0x41, cmd, values);
    const nak = () => reply(this.opts.displayId, 0x4e, cmd, [0x01]);
    if (cmd !== 0x11 && cmd !== 0x00 && s.power === 0 && this.opts.standbyNaks) return nak();
    switch (cmd) {
      case 0x00:
        if (!this.opts.statusSupported) return nak();
        return ack([s.power, s.volume, s.mute, s.input, 0x10, 0, 0]);
      case 0x11:
        if (data.length) {
          if (data[0] === 1 && s.power === 0 && this.opts.bootMs) {
            this.bootingUntil = Date.now() + this.opts.bootMs;
          }
          s.power = data[0];
        }
        return ack([s.power]);
      case 0x12:
        if (data.length) s.volume = data[0];
        return ack([s.volume]);
      case 0x13:
        if (data.length) s.mute = data[0];
        return ack([s.mute]);
      case 0x14:
        if (data.length) s.input = data[0];
        return ack([s.input]);
      default:
        return nak();
    }
  }
}

function reply(id, ackByte, cmd, values) {
  const body = [0xff, id, values.length + 2, ackByte, cmd, ...values];
  const cs = body.reduce((a, b) => a + b, 0) & 0xff;
  return Buffer.from([0xaa, ...body, cs]);
}
