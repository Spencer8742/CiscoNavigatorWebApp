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

/**
 * The registration payload, in the shape webOS expects.
 *
 * The manifest is NESTED under `manifest`, and that detail is the whole
 * difference between working and not. Sent flat, the television still
 * registers the client and still hands back a key — it just grants no
 * permissions, so every command afterwards comes back `401 insufficient
 * permissions` from a client that believes it is paired. Nothing about the
 * handshake looks wrong; only the commands fail.
 *
 * `signatures` carries the well-known signature every webOS client sends. It
 * is a public constant, not a credential: LG's own SDK shipped it, and the
 * TV checks it against a key it already has.
 */
const SIGNATURE =
  'eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsIn' +
  'NpZ25hdHVyZVZlcnNpb24iOjF9.hrVRgjCwXVvE2OOSpDZ58hR+59aFNwYDyjQgKk3auukd7pce' +
  'gmE2CzPCa0bJ0ZsRAcKkCTJrWo5iDzNhMBWRyaMOv5zWSrthlf7G128qvIlpMT0YNY+n/FaOHE73' +
  'uLrS/g7swl3/qH/BGFG2Hu4RlL48eb3lLKqTt2xKHdCs6Cd4RMfJPYnzgvI4BNrFUKsjkcu+WD4O' +
  'O2A27Pq1n50cMchmcaXadJhGrOqH5YmHdOCj5NSHzJYrsW0HPlpuAx/ECMeIZYDh6RMqaFM2DXzd' +
  'KX9NmmyqzJ3o/0lkk/N97gfVRLW5hA29yeAwaCViZNCP8iC9aO0q9fQojoa7NQnAtw==';

const PERMISSIONS = [
  'LAUNCH',
  'LAUNCH_WEBAPP',
  'APP_TO_APP',
  'CONTROL_AUDIO',
  'CONTROL_DISPLAY',
  'CONTROL_INPUT_JOYSTICK',
  'CONTROL_INPUT_MEDIA_RECORDING',
  'CONTROL_INPUT_MEDIA_PLAYBACK',
  'CONTROL_INPUT_TV',
  'CONTROL_POWER',
  'READ_APP_STATUS',
  'READ_CURRENT_CHANNEL',
  'READ_INPUT_DEVICE_LIST',
  'READ_NETWORK_STATE',
  'READ_TV_CHANNEL_LIST',
  'WRITE_NOTIFICATION_TOAST',
  'READ_POWER_STATE',
  'READ_COUNTRY_INFO',
  'READ_INSTALLED_APPS',
  'CONTROL_TV_SCREEN',
];

/** The `payload` of a `register` frame, with the key when we have one. */
export function registerPayload(clientKey?: string): Record<string, unknown> {
  return {
    forcePairing: false,
    pairingType: 'PROMPT',
    ...(clientKey ? { 'client-key': clientKey } : {}),
    manifest: {
      manifestVersion: 1,
      appVersion: '1.1',
      signed: {
        created: '20140509',
        appId: 'com.lge.test',
        vendorId: 'com.lge',
        localizedAppNames: { '': 'LG Remote App' },
        localizedVendorNames: { '': 'LG Electronics' },
        permissions: [
          'TEST_SECURE',
          'CONTROL_INPUT_TEXT',
          'CONTROL_MOUSE_AND_KEYBOARD',
          'READ_INSTALLED_APPS',
          'READ_LGE_SDX',
          'READ_NOTIFICATIONS',
          'SEARCH',
          'WRITE_SETTINGS',
          'WRITE_NOTIFICATION_ALERT',
          'CONTROL_POWER',
          'READ_CURRENT_CHANNEL',
          'READ_RUNNING_APPS',
          'READ_UPDATE_INFO',
          'UPDATE_FROM_REMOTE_APP',
          'READ_LGE_TV_INPUT_EVENTS',
          'READ_TV_CURRENT_TIME',
        ],
        serial: '2f930e2d2cfe083771f68e4fe7bb07',
      },
      permissions: PERMISSIONS,
      signatures: [{ signatureVersion: 1, signature: SIGNATURE }],
    },
  };
}

/* ── URIs, named once ─────────────────────────────────────────────────────*/

export const URI = {
  /** Puts the set into standby. There is no matching "on" — see wol.ts. */
  turnOff: 'ssap://system/turnOff',
  listInputs: 'ssap://tv/getExternalInputList',
  switchInput: 'ssap://tv/switchInput',
  foregroundApp: 'ssap://com.webos.applicationManager/getForegroundAppInfo',
} as const;

/**
 * Which input a foreground app id means, or null for anything else.
 *
 * External inputs are apps to webOS: HDMI 3 is `com.webos.app.hdmi3`. So the
 * app in the foreground IS the current input, when it happens to be one — and
 * when it is Netflix it is not an input at all, which is a real answer rather
 * than a missing one.
 */
export function inputOfAppId(appId: unknown): string | null {
  if (typeof appId !== 'string') return null;

  /*
   * There is more than one shape in the wild, and matching only the first one
   * fails in a way that is almost invisible: the input is simply never known,
   * so the key's label stays blank AND the cycle restarts from the first
   * input every press. It looks like "switching only works for one input"
   * rather than like a parsing problem.
   *
   * Seen: com.webos.app.hdmi2, com.webos.app.externalinput.hdmi2, and
   * suffixed variants like hdmi2_1 on sets with multiple sources per socket.
   */
  const match = /(?:^|\.)hdmi(\d+)(?:[._-]|$)/i.exec(appId.trim());
  return match ? `HDMI_${match[1]}` : null;
}

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
  /**
   * The app id webOS reports while this input is showing, when the set says
   * so. This is the TV's own answer to "which app means which socket", and it
   * is worth far more than guessing at the shape of the string — see
   * `inputOfAppId`, which is only the fallback for sets that leave it out.
   */
  appId?: string;
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

/**
 * Is this the television saying our pairing key is no good?
 *
 * `401 insufficient permissions` is what a key registered with the wrong
 * manifest gets: the client is known, so the connection and the handshake
 * both succeed, and only the commands fail. Nothing recovers on its own —
 * the bad key is on disk and gets offered again on every reconnect — so this
 * has to be recognised and the key thrown away.
 */
export function isAuthFailure(message: string): boolean {
  return /\b401\b|insufficient permission|denied|unauthor/i.test(message);
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
    const appId = row['appId'];
    out.push({
      id,
      // The TV labels an unused socket with the socket's own name, so falling
      // back to the id loses nothing and keeps every input selectable.
      label: typeof label === 'string' && label ? label : id,
      connected: row['connected'] === true,
      ...(typeof appId === 'string' && appId ? { appId } : {}),
    });
  }
  return out;
}
