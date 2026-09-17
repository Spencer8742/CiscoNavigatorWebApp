/**
 * Device detection.
 *
 * Two uses, both narrow:
 *
 *  - Diagnostics in Settings, so "which Chromium is this actually?" is
 *    answerable while standing in front of the panel rather than by reading
 *    release notes.
 *  - A capability hook for degrading gracefully if a device turns out to be
 *    older than our Chromium 102 build target.
 *
 * It is NOT used for layout. Cisco's user agent format is documented but the
 * device string varies by model and over time, so branching layout on it
 * would be fragile. The UI is fluid instead (docs/ROOMOS.md §7).
 */

export interface DeviceInfo {
  isRoomOS: boolean;
  isRoomNavigator: boolean;
  /** e.g. "Cisco Room Navigator", parsed from the UA. */
  model: string | null;
  /** Chromium major.minor.build.patch, if the UA declares one. */
  chromeVersion: string | null;
  /** True when RoomOS has injected the bound JSXAPI object (PWA mode). */
  hasXapi: boolean;
}

let cached: DeviceInfo | null = null;

export function deviceInfo(): DeviceInfo {
  if (cached) return cached;

  const ua = navigator.userAgent;

  // Documented format (docs/ROOMOS.md §1):
  //   Mozilla/5.0 (Linux; RoomOS; Cisco Webex Board (70) AppleWebKit/...
  const isRoomOS = /RoomOS/i.test(ua);

  let model: string | null = null;
  const modelMatch = /RoomOS;\s*([^)]*?)(?:\s*\(|\s*AppleWebKit|\))/i.exec(ua);
  if (modelMatch?.[1]) model = modelMatch[1].trim() || null;

  const chromeMatch = /Chrome\/([\d.]+)/i.exec(ua);
  const chromeVersion = chromeMatch?.[1] ?? null;

  cached = {
    isRoomOS,
    isRoomNavigator: /\b(?:Cisco\s+(?:Webex\s+)?(?:Room\s+)?Navigator|Room\s+Navigator)\b/i.test(ua)
      || (isRoomOS && /\bNavigator\b/i.test(ua)),
    model,
    chromeVersion,
    hasXapi: hasXapi(),
  };
  return cached;
}

/**
 * In Persistent Web App mode RoomOS injects an already-connected JSXAPI
 * object — no connection code needed on our side. We use it only for
 * read-only diagnostics and the optional LED tint, and always guard on its
 * presence, so the app runs identically in a desktop browser during
 * development.
 */
function hasXapi(): boolean {
  try {
    const w = window as unknown as Record<string, unknown>;
    return typeof w['xapi'] === 'object' && w['xapi'] !== null;
  } catch {
    return false;
  }
}

/**
 * JS heap, as the engine itself reports it.
 *
 * This is not the RoomOS process memory budget. Decoded images, compositor
 * textures and other native allocations can cause memory pressure while the
 * JS heap remains small. `jsHeapSizeLimit` describes V8's heap limit only.
 *
 * `performance.memory` is non-standard and Chrome-only, so every access is
 * guarded: it is absent in Firefox and Safari, and it may be quantised or
 * withheld depending on the page's isolation. Absent is a normal answer, not
 * an error -- the caller shows a dash.
 */
export interface HeapInfo {
  usedMb: number;
  limitMb: number;
}

export function heapInfo(): HeapInfo | null {
  try {
    const mem = (performance as unknown as Record<string, unknown>)['memory'] as
      | { usedJSHeapSize?: unknown; jsHeapSizeLimit?: unknown }
      | undefined;
    if (!mem) return null;
    const used = Number(mem.usedJSHeapSize);
    const limit = Number(mem.jsHeapSizeLimit);
    if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
    return { usedMb: used / 1048576, limitMb: limit / 1048576 };
  } catch {
    // Not fatal, and not worth a console line on a wall panel: the readout
    // simply says nothing rather than claiming a figure it does not have.
    return null;
  }
}

/** True when the engine is older than the version this bundle targets. */
export function isBelowBuildTarget(): boolean {
  const v = deviceInfo().chromeVersion;
  if (!v) return false;
  const major = Number.parseInt(v, 10);
  return Number.isFinite(major) && major < 102;
}
