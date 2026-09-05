import { logger } from '~/lib/log.ts';
import { escapeXml, find, parseXml, textOf, type XmlNode } from '~/sonos/xml.ts';

const log = logger('sonos-soap');

/**
 * SOAP against a Sonos speaker, on port 1400.
 *
 * There is no session, no authentication and no connection to keep alive: each
 * call is one HTTP POST. That is why `sonos/` has a client that manages
 * *reachability* rather than a socket — the only long-lived state in this
 * integration is the GENA event subscriptions that arrive in phase 2.
 *
 * `docs/SONOS.md` §2 covers why this is the local API and not the cloud
 * Control API.
 */

export type SonosService =
  | 'AVTransport'
  | 'RenderingControl'
  | 'GroupRenderingControl'
  | 'ZoneGroupTopology'
  | 'ContentDirectory'
  | 'DeviceProperties'
  | 'Queue'
  | 'MusicServices'
  | 'SystemProperties';

interface ServiceDef {
  /** Path of the control endpoint. */
  path: string;
  /** Service type, used in both the SOAPACTION header and the body. */
  urn: string;
}

/**
 * Where each service lives.
 *
 * Note `Queue`: it is the one service with a Sonos-specific URN rather than a
 * `schemas-upnp-org` one, and sending the UPnP form gets a 500 that reads like
 * the speaker is broken.
 */
const SERVICES: Record<SonosService, ServiceDef> = {
  AVTransport: {
    path: '/MediaRenderer/AVTransport/Control',
    urn: 'urn:schemas-upnp-org:service:AVTransport:1',
  },
  RenderingControl: {
    path: '/MediaRenderer/RenderingControl/Control',
    urn: 'urn:schemas-upnp-org:service:RenderingControl:1',
  },
  GroupRenderingControl: {
    path: '/MediaRenderer/GroupRenderingControl/Control',
    urn: 'urn:schemas-upnp-org:service:GroupRenderingControl:1',
  },
  ZoneGroupTopology: {
    path: '/ZoneGroupTopology/Control',
    urn: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1',
  },
  ContentDirectory: {
    path: '/MediaServer/ContentDirectory/Control',
    urn: 'urn:schemas-upnp-org:service:ContentDirectory:1',
  },
  DeviceProperties: {
    path: '/DeviceProperties/Control',
    urn: 'urn:schemas-upnp-org:service:DeviceProperties:1',
  },
  Queue: {
    path: '/MediaRenderer/Queue/Control',
    urn: 'urn:schemas-sonos-com:service:Queue:1',
  },
  MusicServices: {
    path: '/MusicServices/Control',
    urn: 'urn:schemas-upnp-org:service:MusicServices:1',
  },
  SystemProperties: {
    path: '/SystemProperties/Control',
    urn: 'urn:schemas-upnp-org:service:SystemProperties:1',
  },
};

/** Every Sonos speaker serves its control endpoints here. */
export const SONOS_PORT = 1400;

/**
 * `192.168.1.51` → `192.168.1.51:1400`, keeping a port that is already there.
 *
 * A speaker's address reaches us from its own device-description URL, which
 * carries the port, so the common path is a no-op. The default matters for
 * `SONOS_HOST`, which is written by hand as a bare address.
 *
 * The IPv6 branches are three lines and exist because the naive test —
 * "does it end in `:digits`?" — is true of the literal `fe80::1`, and would
 * quietly produce a URL pointing at port 1.
 */
export function authority(host: string): string {
  if (/]:\d+$/.test(host)) return host; // [v6]:port
  if (/^\[.*]$/.test(host)) return `${host}:${SONOS_PORT}`; // [v6]
  if (host.includes(':')) {
    // One colon is host:port. Several make it a bare IPv6 literal, which has
    // to be bracketed before a port can be appended at all.
    return host.indexOf(':') === host.lastIndexOf(':') ? host : `[${host}]:${SONOS_PORT}`;
  }
  return `${host}:${SONOS_PORT}`;
}

/** Long enough for a large household's topology, short enough to fail a poll. */
const TIMEOUT_MS = 10_000;

/**
 * A refusal from the speaker.
 *
 * `code` is the UPnP error code when the speaker sent a SOAP fault — 701 is
 * "no such object", 402 "invalid args", 800 "operation not supported by this
 * player". Null when the failure was HTTP or transport level.
 */
export class SoapError extends Error {
  readonly code: number | null;

  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = 'SoapError';
    this.code = code;
  }
}

export type SoapArgs = Record<string, string | number>;

/**
 * Call one action and return the response element.
 *
 * Arguments are emitted in insertion order, which matters: Sonos validates
 * these positionally in places and answers 402 for a body whose elements are
 * in an order it did not expect.
 */
export async function soapCall(
  host: string,
  service: SonosService,
  action: string,
  args: SoapArgs = {},
  timeoutMs: number = TIMEOUT_MS,
): Promise<XmlNode> {
  const def = SERVICES[service];
  const body = envelope(def.urn, action, args);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`http://${authority(host)}${def.path}`, {
      method: 'POST',
      headers: {
        'content-type': 'text/xml; charset="utf-8"',
        soapaction: `"${def.urn}#${action}"`,
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    const reason = controller.signal.aborted ? 'did not answer in time' : describe(err);
    throw new SoapError(`${host} ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();

  /*
   * A SOAP fault arrives as HTTP 500 with a body worth reading — the UPnP
   * error code inside is the difference between "that player cannot do this"
   * and "the speaker is unreachable", and only one of those is worth
   * retrying.
   */
  if (!response.ok) {
    const fault = faultOf(text);
    if (fault !== null) {
      throw new SoapError(`${action} on ${host} failed (UPnP ${fault})`, fault);
    }
    throw new SoapError(`${action} on ${host} failed (HTTP ${response.status})`);
  }

  const root = parseXml(text);
  const result = find(root, `${action}Response`);
  if (!result) {
    log.debug(`No ${action}Response in reply from ${host}`);
    throw new SoapError(`${host} sent an unrecognisable reply to ${action}`);
  }
  return result;
}

function envelope(urn: string, action: string, args: SoapArgs): string {
  let inner = '';
  for (const key in args) {
    inner += `<${key}>${escapeXml(String(args[key]))}</${key}>`;
  }
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${urn}">${inner}</u:${action}></s:Body>` +
    '</s:Envelope>'
  );
}

/** The UPnP error code from a fault body, if it is one. */
function faultOf(text: string): number | null {
  const code = textOf(parseXml(text), 'errorCode');
  if (code === null) return null;
  const n = Number.parseInt(code, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Why a request failed, in words worth putting on the Settings screen.
 *
 * `fetch` reports every transport failure as the same `TypeError: fetch
 * failed` and puts the real error in `cause`. Reading only the top-level
 * message turns "nothing is listening at that address" — the shape of a
 * mistyped `SONOS_HOST`, and the most likely first-run problem — into text
 * that tells the user nothing.
 */
function describe(err: unknown): string {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;

  if (cause instanceof Error) {
    switch ((cause as NodeJS.ErrnoException).code) {
      case 'ECONNREFUSED':
        return 'refused the connection — nothing is listening there';
      case 'EHOSTUNREACH':
      case 'ENETUNREACH':
        return 'is unreachable from this container';
      case 'ETIMEDOUT':
        return 'timed out';
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
        return 'could not be resolved';
      default:
        return `could not be reached (${cause.message})`;
    }
  }
  return 'could not be reached';
}

/* ── Value helpers ───────────────────────────────────────────────────────
   Sonos answers in strings, and three of its conventions cost a bug each if
   they are read as ordinary values. */

/**
 * `H:MM:SS` to seconds.
 *
 * Returns null for `NOT_IMPLEMENTED`, which is what a live stream reports for
 * both position and duration — and which parses to 0 if you let it, drawing a
 * progress bar that claims a radio station is at the start of a zero-length
 * track.
 */
export function seconds(raw: string | null | undefined): number | null {
  if (!raw || raw === 'NOT_IMPLEMENTED') return null;
  const parts = raw.split(':');
  if (parts.length !== 3) return null;

  let total = 0;
  for (const part of parts) {
    const n = Number.parseInt(part, 10);
    if (!Number.isFinite(n)) return null;
    total = total * 60 + n;
  }
  return total;
}

/** Sonos writes booleans as `1` and `0`, never `true`/`false`. */
export function flag(raw: string | null | undefined): boolean {
  return raw === '1';
}

export function integer(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
