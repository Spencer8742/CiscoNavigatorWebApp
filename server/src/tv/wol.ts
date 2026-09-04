import { createSocket } from 'node:dgram';
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
 * Send the packet to the broadcast address.
 *
 * Broadcast rather than the TV's own IP on purpose: the set is off, so it has
 * no IP lease and nothing will answer an ARP for it. The packet has to go to
 * everyone and be recognised by the NIC.
 *
 * Sent three times, ~100ms apart. This is UDP to a device that is asleep;
 * there is no acknowledgement to wait for and no way to retry on failure, so
 * the redundancy is the retry. Duplicates are harmless — a magic packet is
 * idempotent, unlike the transport commands elsewhere in this codebase that
 * are deliberately never retried.
 */
export async function wake(mac: string, broadcast = '255.255.255.255'): Promise<void> {
  const packet = magicPacket(mac);
  const socket = createSocket('udp4');

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(() => {
        socket.setBroadcast(true);
        resolve();
      });
    });

    for (let i = 0; i < 3; i += 1) {
      await new Promise<void>((resolve, reject) => {
        // Port 9 (discard) is the convention; 7 also works. The TV's NIC
        // matches on the payload, not the port.
        socket.send(packet, 9, broadcast, (err) => (err ? reject(err) : resolve()));
      });
      if (i < 2) await new Promise((r) => setTimeout(r, 100));
    }
    log.info(`Wake-on-LAN sent to ${mac}`);
  } finally {
    socket.close();
  }
}
