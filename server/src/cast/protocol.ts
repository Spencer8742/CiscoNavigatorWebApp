/**
 * The Cast v2 wire protocol — the small part of it this app needs.
 *
 * A Chromecast, a Nest Hub and a Nest Mini all speak the same thing on TCP
 * 8009: length-prefixed Protocol Buffers, each carrying a JSON string on a
 * named channel.
 *
 *     ┌──────────┬────────────────────────────┐
 *     │ uint32be │ CastMessage (protobuf)     │
 *     │ length   │                            │
 *     └──────────┴────────────────────────────┘
 *
 * and the message itself, from Google's `cast_channel.proto`:
 *
 *     required ProtocolVersion protocol_version = 1;  // 0 = CASTV2_1_0
 *     required string          source_id        = 2;
 *     required string          destination_id   = 3;
 *     required string          namespace        = 4;
 *     required PayloadType     payload_type     = 5;  // 0 = STRING
 *     optional string          payload_utf8     = 6;
 *     optional bytes           payload_binary   = 7;
 *
 * ## Why this is hand-rolled
 *
 * Six fields, five of them strings, one shape, no nesting, no repeated fields,
 * no maps. A protobuf runtime plus a generated stub is several hundred
 * kilobytes of dependency to encode what fits on one screen — and this is a
 * backend that must stay small enough to be worth running beside the panel it
 * serves. The whole encoder is `tag, length, bytes` repeated six times.
 *
 * Everything here is pure and synchronous; the socket lives in device.ts.
 */

/**
 * Refuse to buffer a frame larger than this.
 *
 * Real frames are a few hundred bytes; a receiver status with a long
 * namespace list might reach a few kilobytes. The cap exists because the
 * length prefix is read before any of the body is: without it, one corrupt
 * or hostile four-byte header asks Node for a 4 GB buffer.
 */
const MAX_FRAME = 256 * 1024;

export interface CastFrame {
  namespace: string;
  source: string;
  destination: string;
  /**
   * The UTF-8 payload, which in practice is always JSON.
   *
   * Binary payloads exist in the protocol and are used by nothing this app
   * talks to; they decode to an empty string rather than being an error, so
   * an unexpected one is ignored instead of killing the connection.
   */
  payload: string;
}

/* ── Encoding ──────────────────────────────────────────────────────────── */

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    const byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    bytes.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);
  return Buffer.from(bytes);
}

/** A field header: the field number and its wire type, packed into a varint. */
function key(field: number, wireType: number): Buffer {
  return varint((field << 3) | wireType);
}

function varintField(field: number, value: number): Buffer {
  return Buffer.concat([key(field, 0), varint(value)]);
}

function stringField(field: number, value: string): Buffer {
  const body = Buffer.from(value, 'utf8');
  return Buffer.concat([key(field, 2), varint(body.length), body]);
}

/** One frame, length prefix and all, ready to write to the socket. */
export function encodeFrame(frame: CastFrame): Buffer {
  const body = Buffer.concat([
    // proto2 `required` fields must be present even when zero, so these two
    // are written explicitly rather than left to a default.
    varintField(1, 0), // protocol_version: CASTV2_1_0
    stringField(2, frame.source),
    stringField(3, frame.destination),
    stringField(4, frame.namespace),
    varintField(5, 0), // payload_type: STRING
    stringField(6, frame.payload),
  ]);

  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

/* ── Decoding ──────────────────────────────────────────────────────────── */

interface Read {
  value: number;
  next: number;
}

function readVarint(buf: Buffer, at: number): Read | null {
  let value = 0;
  let scale = 1;
  let pos = at;
  while (pos < buf.length) {
    const byte = buf[pos] as number;
    pos += 1;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return { value, next: pos };
    scale *= 128;
    // Ten bytes is the widest a 64-bit varint can be. Anything longer is
    // corruption, and continuing would silently produce a garbage number.
    if (pos - at > 10) return null;
  }
  return null;
}

/**
 * Decode one message body (the bytes after the length prefix).
 *
 * Returns null for anything malformed. Unknown fields are skipped rather than
 * rejected — that is what protobuf's wire format is for, and a future firmware
 * adding a field must not stop this from reading the fields it does know.
 */
export function decodeFrame(body: Buffer): CastFrame | null {
  let source = '';
  let destination = '';
  let namespace = '';
  let payload = '';

  let pos = 0;
  while (pos < body.length) {
    const tag = readVarint(body, pos);
    if (!tag) return null;
    pos = tag.next;

    const field = Math.floor(tag.value / 8);
    const wireType = tag.value & 7;

    switch (wireType) {
      case 0: {
        const v = readVarint(body, pos);
        if (!v) return null;
        pos = v.next;
        break;
      }
      case 2: {
        const len = readVarint(body, pos);
        if (!len) return null;
        const end = len.next + len.value;
        if (end > body.length) return null;
        const slice = body.subarray(len.next, end);
        if (field === 2) source = slice.toString('utf8');
        else if (field === 3) destination = slice.toString('utf8');
        else if (field === 4) namespace = slice.toString('utf8');
        else if (field === 6) payload = slice.toString('utf8');
        pos = end;
        break;
      }
      case 1:
        pos += 8;
        break;
      case 5:
        pos += 4;
        break;
      default:
        // Groups (3 and 4) were removed from proto2 long before this protocol
        // existed, and 6/7 are not wire types at all.
        return null;
    }
  }

  // A fixed-width field running off the end lands here rather than above.
  if (pos !== body.length) return null;

  return { namespace, source, destination, payload };
}

/**
 * Reassembles frames from a TCP stream.
 *
 * TCP gives no message boundaries: a single `data` event may carry half a
 * frame, three frames, or three and a half. Every reader of this protocol
 * needs this loop, and getting it subtly wrong shows up only under load —
 * exactly when the dashboard is being cast to several displays at once.
 */
export class FrameReader {
  #buffer: Buffer = Buffer.alloc(0);

  /** Appends bytes and returns whatever complete frames that made available. */
  push(chunk: Buffer): CastFrame[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    const frames: CastFrame[] = [];
    for (;;) {
      if (this.#buffer.length < 4) break;
      const length = this.#buffer.readUInt32BE(0);
      if (length > MAX_FRAME) {
        throw new Error(`Cast frame claims ${length} bytes — refusing to buffer it`);
      }
      if (this.#buffer.length < 4 + length) break;

      const frame = decodeFrame(this.#buffer.subarray(4, 4 + length));
      this.#buffer = this.#buffer.subarray(4 + length);
      // A frame we cannot parse is dropped, not fatal: the stream is still
      // correctly framed, so the next one will very likely be fine.
      if (frame) frames.push(frame);
    }
    return frames;
  }
}
