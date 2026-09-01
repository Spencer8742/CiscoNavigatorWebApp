import { createServer } from 'node:http';

/**
 * Mock Bitfocus Companion and mock Elgato Key Light.
 *
 * Both speak the real wire format, because that format is precisely what is
 * easy to get quietly wrong and impossible to check by reading:
 *
 *  - Companion 4.x presses at `POST /api/location/<page>/<row>/<column>/press`
 *    and answers 404 for a location with no button on it, which is what a
 *    rearranged Companion page looks like from here.
 *  - A Key Light speaks `{ numberOfLights, lights: [...] }` with `on` as 0/1
 *    and `temperature` in MIREDS — 143 (7000 K) to 344 (2900 K), a number
 *    that gets SMALLER as the light gets warmer. Getting that backwards is
 *    invisible in a unit test that uses the same helper both ways.
 */

/** Companion. Records every press; answers 404 for unknown locations. */
export class MockCompanion {
  #server;
  #port;

  /** Every press received, as { page, row, column }. */
  presses = [];

  /** Locations that exist. Anything else is a 404, as Companion does. */
  buttons = new Set(['1/0/0', '1/0/1', '2/1/3']);

  constructor(port) {
    this.#port = port;
  }

  async start() {
    this.#server = createServer((req, res) => {
      const match = /^\/api\/location\/(\d+)\/(\d+)\/(\d+)\/press$/.exec(req.url ?? '');

      if (!match || req.method !== 'POST') {
        res.writeHead(404).end('Not found');
        return;
      }

      const [, page, row, column] = match;
      if (!this.buttons.has(`${page}/${row}/${column}`)) {
        res.writeHead(404).end('No button at that location');
        return;
      }

      this.presses.push({ page: Number(page), row: Number(row), column: Number(column) });
      res.writeHead(200).end('ok');
    });

    await new Promise((resolve) => this.#server.listen(this.#port, '127.0.0.1', resolve));
  }

  async stop() {
    if (!this.#server) return;
    await new Promise((resolve) => this.#server.close(resolve));
    this.#server = undefined;
  }
}

/** One Elgato Key Light. `offline` makes it refuse connections. */
export class MockKeyLight {
  #server;
  #port;

  /** Wire state: on is 0/1, temperature is mireds. */
  light = { on: 0, brightness: 20, temperature: 213 };

  /** Every PUT body received, for asserting what was actually sent. */
  writes = [];

  /** GET count, so the poll can be observed without timing assumptions. */
  reads = 0;

  constructor(port) {
    this.#port = port;
  }

  async start() {
    this.#server = createServer((req, res) => {
      if (!req.url?.startsWith('/elgato/lights')) {
        res.writeHead(404).end();
        return;
      }

      if (req.method === 'GET') {
        this.reads += 1;
        this.#respond(res);
        return;
      }

      if (req.method !== 'PUT') {
        res.writeHead(405).end();
        return;
      }

      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          this.writes.push(parsed);
          // A real light applies only the fields it was sent and leaves the
          // rest alone, which is what makes "set brightness" not also reset
          // the colour temperature.
          const wanted = parsed.lights?.[0] ?? {};
          for (const key of ['on', 'brightness', 'temperature']) {
            if (wanted[key] !== undefined) this.light[key] = wanted[key];
          }
        } catch {
          res.writeHead(400).end();
          return;
        }
        this.#respond(res);
      });
    });

    await new Promise((resolve) => this.#server.listen(this.#port, '127.0.0.1', resolve));
  }

  #respond(res) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ numberOfLights: 1, lights: [{ ...this.light }] }));
  }

  async stop() {
    if (!this.#server) return;
    await new Promise((resolve) => this.#server.close(resolve));
    this.#server = undefined;
  }
}
