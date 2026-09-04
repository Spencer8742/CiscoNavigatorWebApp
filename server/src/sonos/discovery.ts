import { createSocket } from 'node:dgram';
import { logger } from '~/lib/log.ts';

const log = logger('sonos-discovery');

/**
 * Finding one speaker.
 *
 * One is all that is ever needed: from any single player,
 * `ZoneGroupTopology.GetZoneGroupState` describes the entire household
 * (`topology.ts`). So this runs once at startup and its answer is a seed, not
 * a subscription.
 *
 * ## Why `SONOS_HOST` is the documented path and this is the fallback
 *
 * This backend runs in a container. On Docker's default bridge network
 * multicast does not reach the LAN, so SSDP finds nothing — and the failure is
 * an empty Media screen rather than an error, on a device nobody can open
 * DevTools on. A static address always works and is one line in `.env`.
 *
 * `docs/SONOS.md` §5 has the full reasoning. Discovery exists so that a bench
 * test on a laptop needs no configuration at all.
 */

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;

/**
 * The device type every Sonos speaker answers to.
 *
 * Deliberately specific: `ssdp:all` would return every UPnP device on the
 * network — printers, routers, televisions — and picking Sonos out of that by
 * inspecting each one is slower and less reliable than asking the right
 * question.
 */
const TARGET = 'urn:schemas-upnp-org:device:ZonePlayer:1';

const SEARCH = [
  'M-SEARCH * HTTP/1.1',
  `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
  // The quotes are required by the spec and some stacks reject the datagram
  // without them.
  'MAN: "ssdp:discover"',
  'MX: 1',
  `ST: ${TARGET}`,
  '',
  '',
].join('\r\n');

/**
 * Look for a speaker, and return the address of the first that answers.
 *
 * Sends three times: SSDP is UDP, a lost datagram is silent, and a single
 * probe that happens to collide with Wi-Fi traffic looks exactly like "you
 * have no Sonos".
 */
export function discoverHost(timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    let socket: ReturnType<typeof createSocket>;
    try {
      socket = createSocket({ type: 'udp4', reuseAddr: true });
    } catch (err) {
      log.debug('Could not open a discovery socket:', err);
      resolve(null);
      return;
    }

    let settled = false;
    let probes: ReturnType<typeof setInterval> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;

    const finish = (host: string | null): void => {
      if (settled) return;
      settled = true;
      clearInterval(probes);
      clearTimeout(deadline);
      try {
        socket.close();
      } catch {
        // Already closing; nothing to do and nothing worth logging.
      }
      resolve(host);
    };

    socket.on('error', (err) => {
      log.debug('Discovery socket error:', err.message);
      finish(null);
    });

    socket.on('message', (msg, from) => {
      const text = msg.toString('utf8');
      // Other UPnP devices answer broadcast traffic on this port too; only a
      // reply naming the ZonePlayer type is ours.
      if (!text.includes(TARGET)) return;

      const host = locationHost(text) ?? from.address;
      log.info(`Discovered a Sonos speaker at ${host}`);
      finish(host);
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {
        // Not fatal: the multicast send below is the one that matters.
      }

      const probe = (): void => {
        if (settled) return;
        socket.send(SEARCH, SSDP_PORT, SSDP_ADDRESS, (err) => {
          if (err) log.debug('Discovery send failed:', err.message);
        });
      };

      probe();
      probes = setInterval(probe, Math.max(250, Math.floor(timeoutMs / 3)));
      deadline = setTimeout(() => {
        log.debug(`No speaker answered discovery within ${timeoutMs}ms`);
        finish(null);
      }, timeoutMs);
    });
  });
}

/** Pull the host out of the `LOCATION:` header of an SSDP reply. */
function locationHost(text: string): string | null {
  const match = /^location:\s*(\S+)/im.exec(text);
  if (!match?.[1]) return null;
  try {
    const { hostname } = new URL(match[1]);
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}
