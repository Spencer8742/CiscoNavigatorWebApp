import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { logger } from '~/lib/log.ts';

const log = logger('wol');

/**
 * Wake-on-LAN, for the one thing the webOS socket cannot do.
 *
 * A webOS TV that is off has its network stack down — there is nothing
 * listening on 3000/3001 to ask. The only way back on is a magic packet to
 * the panel's own LAN, which is why every integration that can turn an LG on
 * wants its MAC address as well as its IP.
 *
 * (Even this needs the TV configured to listen: "Quick Start+" on newer sets,
 * or Network > "TV On with Mobile"/"Wake on LAN" on older ones. With those off
 * the set is genuinely unreachable when off, and no software fixes it.)
 */

/** 6 bytes of 0xFF, then the MAC 16 times. */
export function magicPacket(mac: string): Buffer {
  const bytes = parseMac(mac);
  if (!bytes) throw new Error(`Not a MAC address: ${mac}`);

  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i += 1) bytes.copy(packet, 6 + i * 6);
  return packet;
}

/** Accepts aa:bb:cc:dd:ee:ff, aa-bb-..., or aabbccddeeff, any case. */
export function parseMac(mac: string): Buffer | null {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) return null;
  return Buffer.from(hex, 'hex');
}

/**
 * Every address worth sending the packet to, for a TV at `host`.
 *
 * One address was not enough, and which one fails depends on the network:
 *
 *  - `255.255.255.255` only leaves by the interface the default route uses.
 *    On a host with more than one, that may not be the TV's.
 *  - So the directed broadcast of every local interface the TV is actually
 *    on is sent as well, worked out from the interface's own netmask rather
 *    than guessed as a /24.
 *  - And the TV's own address, unicast. Inside Docker's default bridge
 *    network — which is what the Unraid template uses — no broadcast ever
 *    reaches the LAN at all, but a unicast packet is routed out like any
 *    other. It arrives as long as the TV's MAC is still in the router's ARP
 *    table, which on a set in standby it usually is.
 *
 * A configured `broadcast` replaces the guessed broadcasts, not the unicast:
 * it is an answer to "which subnet", and the unicast costs nothing.
 */
export function wakeTargets(host: string, broadcast?: string): string[] {
  const out = new Set<string>();
  const ip = ipv4ToInt(host);

  if (broadcast) {
    out.add(broadcast);
  } else {
    out.add('255.255.255.255');
    if (ip !== null) {
      for (const list of Object.values(networkInterfaces())) {
        for (const iface of list ?? []) {
          if (iface.family !== 'IPv4' || iface.internal) continue;
          const own = ipv4ToInt(iface.address);
          const mask = ipv4ToInt(iface.netmask);
          if (own === null || mask === null || mask === 0) continue;
          if (((own & mask) >>> 0) !== ((ip & mask) >>> 0)) continue;
          out.add(intToIpv4(((own & mask) | ~mask) >>> 0));
        }
      }
    }
  }

  if (ip !== null) out.add(host);
  return [...out];
}

function ipv4ToInt(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    n = n * 256 + byte;
  }
  return n >>> 0;
}

function intToIpv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/**
 * Send the packet to every target, three times, ~100ms apart.
 *
 * Broadcast rather than only the TV's own IP on purpose: the set is off, so
 * it may have no IP lease and nothing will answer an ARP for it. The packet
 * has to go to everyone and be recognised by the NIC. See `wakeTargets` for
 * why the unicast goes too.
 *
 * This is UDP to a device that is asleep; there is no acknowledgement to wait
 * for, so the redundancy is the retry. Duplicates are harmless — a magic
 * packet is idempotent, unlike the transport commands elsewhere in this
 * codebase that are deliberately never retried.
 *
 * One target refusing (a unicast to a host with no route, say) does not stop
 * the others. Only when NOTHING could be sent is it an error.
 */
export async function wake(mac: string, targets: string[], port = 9): Promise<void> {
  const packet = magicPacket(mac);
  const socket = createSocket('udp4');
  let sent = 0;
  let lastError: unknown;

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(() => {
        socket.setBroadcast(true);
        resolve();
      });
    });
    // A send to an unreachable target can surface asynchronously as an
    // 'error' on the socket; that must not become an unhandled exception.
    socket.on('error', (err) => log.debug(`Wake-on-LAN socket error: ${err.message}`));

    for (let i = 0; i < 3; i += 1) {
      for (const target of targets) {
        try {
          await new Promise<void>((resolve, reject) => {
            // Port 9 (discard) is the convention; 7 also works. The TV's NIC
            // matches on the payload, not the port.
            socket.send(packet, port, target, (err) => (err ? reject(err) : resolve()));
          });
          sent += 1;
        } catch (err) {
          lastError = err;
          log.debug(`Wake-on-LAN to ${target} failed:`, err);
        }
      }
      if (i < 2) await new Promise((r) => setTimeout(r, 100));
    }
    if (sent === 0) throw lastError ?? new Error('No wake target');
    log.debug(`Wake-on-LAN sent to ${mac} via ${targets.join(', ')}`);
  } finally {
    socket.close();
  }
}
