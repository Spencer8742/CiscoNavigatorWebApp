/**
 * LG webOS SSAP — the wire protocol, kept separate from the socket that
 * speaks it so the parts worth testing can be tested without a TV.
 *
 * SSAP is a JSON envelope over a plain WebSocket on port 3000 (or TLS on
 * 3001, with a self-signed certificate the TV never rotates). Every request
 * carries an `id` the reply echoes:
 *
 *   -> {"id":"1","type":"request","uri":"ssap://audio/getVolume"}
 *   <- {"id":"1","type":"response","payload":{"volume":12,"returnValue":true}}
 *
 * `returnValue: false` is how the TV says no. It arrives as a perfectly
 * ordinary response, so a client that only checks for `type: "error"` treats
 * a refusal as a success.
 */

/** The permissions asked for at registration. */
export const MANIFEST = {
  manifestVersion: 1,
  appVersion: '1.0',
  signed: {
    created: '20240101',
    appId: 'com.navigator.panel',
    vendorId: '',
    localizedAppNames: { '': 'Room Navigator' },
    localizedVendorNames: { '': '' },
    permissions: ['TEST_SECURE', 'CONTROL_INPUT_TEXT', 'CONTROL_POWER', 'CONTROL_INPUT_TV'],
    serial: '0123456789abcdef',
  },
  permissions: [
    'CONTROL_POWER',
    'CONTROL_INPUT_TV',
    'READ_INPUT_DEVICE_LIST',
    'READ_TV_CURRENT_CHANNEL',
    'READ_CURRENT_CHANNEL',
    'CONTROL_AUDIO',
    'READ_INSTALLED_APPS',
    'LAUNCH',
  ],
  signatures: [],
} as const;

/* ── URIs, named once ─────────────────────────────────────────────────────*/

export const URI = {
  /** Puts the set into standby. There is no matching "on" — see wol.ts. */
  turnOff: 'ssap://system/turnOff',
  listInputs: 'ssap://tv/getExternalInputList',
  switchInput: 'ssap://tv/switchInput',
  foregroundApp: 'ssap://com.webos.applicationManager/getForegroundAppInfo',
} as const;

/**
 * Where to try, in order.
 *
 * webOS moved: sets from roughly 2020 on (webOS 5 and later) serve SSAP over
 * TLS on 3001 and leave 3000 closed, while older ones do the opposite. A set
 * on the new firmware ACCEPTS a connection on 3000 and immediately resets it,
 * which surfaces as ECONNRESET — a message that reads like a network fault
 * rather than "wrong port", and sent me looking at the LAN first.
 *
 * So both are tried, newest first, unless the config pins a port — in which
 * case that is an instruction, not a hint, and it is the only thing tried.
 *
 * The certificate on 3001 is self-signed, issued to the TV itself, and LG
 * never rotates it. It cannot be verified and there is nothing to verify it
 * against: the config names an IP on the user's own LAN. So the connection is
 * encrypted but NOT authenticated, which is what every webOS client does and
 * is worth being explicit about rather than quietly passing a flag.
 */
export function endpointsFor(host: string, explicitPort?: number): string[] {
  // A written port is honoured exactly — but the SCHEME is still discovered.
  // Picking it from the port number was the first attempt and it is wrong
  // twice over: it makes 3001 magic, and it silently downgrades anything
  // behind a proxy or on a non-standard port to plaintext, which then fails
  // in the same unreadable way this function exists to prevent.
  if (explicitPort !== undefined) {
    return [`wss://${host}:${explicitPort}`, `ws://${host}:${explicitPort}`];
  }
  return [`wss://${host}:3001`, `ws://${host}:3000`];
}

export interface SsapFrame {
  id?: string;
  type?: string;
  payload?: Record<string, unknown>;
  error?: string;
}

/** One input the TV reports: `{ id: "HDMI_2", label: "Laptop" }`. */
export interface TvInput {
  id: string;
  label: string;
  connected: boolean;
}

/**
 * Did this response actually succeed?
 *
 * `returnValue` is the real signal. A refused command comes back as
 * `type: "response"` with `returnValue: false` and often an `errorText`, so
 * checking the frame type alone reports failures as successes — which on a
 * power command means the panel says "done" to a TV that ignored it.
 */
export function failureOf(frame: SsapFrame): string | null {
  if (frame.type === 'error') return frame.error || 'The TV rejected the command';

  const payload = frame.payload;
  if (payload && payload['returnValue'] === false) {
    const text = payload['errorText'];
    return typeof text === 'string' && text ? text : 'The TV rejected the command';
  }
  return null;
}

/** The inputs out of a getExternalInputList payload, ignoring malformed rows. */
export function inputsOf(payload: Record<string, unknown> | undefined): TvInput[] {
  const raw = payload?.['devices'];
  if (!Array.isArray(raw)) return [];

  const out: TvInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = row['id'];
    if (typeof id !== 'string' || !id) continue;
    const label = row['label'];
    out.push({
      id,
      // The TV labels an unused socket with the socket's own name, so falling
      // back to the id loses nothing and keeps every input selectable.
      label: typeof label === 'string' && label ? label : id,
      connected: row['connected'] === true,
    });
  }
  return out;
}
