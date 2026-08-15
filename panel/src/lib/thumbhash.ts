/**
 * Average colour from a ThumbHash.
 *
 * Immich returns a `thumbhash` on every asset — about 25 bytes that encode a
 * tiny blurred version of the image. We use only its **DC term**: the average
 * colour, which lives in the first three bytes of the header.
 *
 * ## Why not decode the whole thing
 *
 * A full ThumbHash decode reconstructs a small blurred bitmap, which would be
 * a prettier placeholder. It is also ~80 lines of DCT maths whose failure
 * mode is silent: get a coefficient wrong and you render plausible-looking
 * noise, on a wall-mounted device where nobody will notice for weeks. I have
 * no reference vectors to verify a full decoder against here, and shipping
 * unverified pixel maths to a panel that is hard to debug is not a trade I
 * want to make.
 *
 * The average colour is six lines, is self-checking (a grey image must decode
 * to grey — see the test), and delivers most of the benefit: the crossfade
 * begins from a colour close to the incoming photo instead of from black, so
 * there is never an empty frame. Upgrading to a full decode later is a
 * self-contained change to this file.
 *
 * Format reference: https://github.com/evanw/thumbhash
 *
 *   bits  0-5   L DC   (luminance)
 *   bits  6-11  P DC   (yellow-blue)
 *   bits 12-17  Q DC   (red-green)
 *   bits 18-22  L scale
 *   bit  23     has alpha
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** base64 → bytes. Returns null on malformed input rather than throwing. */
function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * The average colour of the image a ThumbHash came from, as 0-255 channels.
 *
 * Returns null for anything unparseable, so callers fall back to a neutral
 * background rather than showing a wrong colour.
 */
export function thumbHashAverage(base64: string | undefined): Rgb | null {
  if (!base64) return null;

  const hash = decodeBase64(base64);
  if (!hash || hash.length < 3) return null;

  const header = (hash[0] as number) | ((hash[1] as number) << 8) | ((hash[2] as number) << 16);

  const l = (header & 63) / 63;
  const p = ((header >> 6) & 63) / 31.5 - 1;
  const q = ((header >> 12) & 63) / 31.5 - 1;

  // The inverse of ThumbHash's LPQ encoding. Note this is self-consistent:
  // p = q = 0 gives r = g = b = l, i.e. a neutral grey, which is the
  // property the unit test pins.
  const b = l - (2 / 3) * p;
  const r = (3 * l - b + q) / 2;
  const g = r - q;

  return {
    r: Math.round(clamp01(r) * 255),
    g: Math.round(clamp01(g) * 255),
    b: Math.round(clamp01(b) * 255),
  };
}

/** CSS colour for a photo's placeholder, or a neutral surface fallback. */
export function thumbHashCss(base64: string | undefined): string {
  const rgb = thumbHashAverage(base64);
  return rgb ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : 'var(--surface-2)';
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
