/**
 * Inline SVG icons.
 *
 * Why not an icon font or an emoji, which would be less code?
 *
 *  - Emoji are out: RoomOS supports "only a sub-set, and in monochrome only"
 *    (docs/ROOMOS.md §9), so they render inconsistently or not at all.
 *  - An icon font is a separate network request that blocks meaningful paint
 *    and a FOUT on every cold start.
 *  - An SVG sprite sheet is another request for no benefit at this size.
 *
 * Inline paths ship in the JS bundle, cost ~3 KB gzipped for the whole set,
 * paint in the first frame, and inherit `currentColor` so a single CSS change
 * recolours every icon. Stroke geometry stays crisp at any size, which
 * matters because the panel's viewport is not something Cisco publishes
 * (docs/ROOMOS.md §7) and everything scales with the root font size.
 */

import type { VNode } from 'preact';

interface PathSpec {
  /** Stroked path data. */
  d?: string[];
  /** Stroked circles: [cx, cy, r]. */
  c?: [number, number, number][];
  /** Filled path data, for solid glyphs like the play triangle. */
  f?: string[];
  /** Repeat the whole glyph rotated about the centre, by these degrees. */
  rot?: number[];
}

const ICONS: Record<string, PathSpec> = {
  /* ── Navigation ─────────────────────────────────────────────────────── */
  home: { d: ['M3 11.2 12 4l9 7.2', 'M5.6 9.6V19a1 1 0 0 0 1 1h10.8a1 1 0 0 0 1-1V9.6'] },
  rooms: {
    d: [
      'M4 4.8A.8.8 0 0 1 4.8 4h4.4a.8.8 0 0 1 .8.8v4.4a.8.8 0 0 1-.8.8H4.8a.8.8 0 0 1-.8-.8z',
      'M14 4.8a.8.8 0 0 1 .8-.8h4.4a.8.8 0 0 1 .8.8v4.4a.8.8 0 0 1-.8.8h-4.4a.8.8 0 0 1-.8-.8z',
      'M4 14.8a.8.8 0 0 1 .8-.8h4.4a.8.8 0 0 1 .8.8v4.4a.8.8 0 0 1-.8.8H4.8a.8.8 0 0 1-.8-.8z',
      'M14 14.8a.8.8 0 0 1 .8-.8h4.4a.8.8 0 0 1 .8.8v4.4a.8.8 0 0 1-.8.8h-4.4a.8.8 0 0 1-.8-.8z',
    ],
  },
  media: { d: ['M9 17.5V5.2l10-2v12.3'], c: [[6.5, 17.5, 2.5], [16.5, 15.5, 2.5]] },
  pin: { d: ['M8 3.5h8', 'M9 3.5v5l-3 3v1.5h12v-1.5l-3-3v-5', 'M12 13v7.5'] },
  shuffle: { d: ['M4 7h2.5c4.5 0 6.5 10 11 10H20', 'M17 14l3 3-3 3', 'M4 17h2.5c1.7 0 3-1.4 4.2-3.2', 'M14 7.2C15 7 16 7 17.5 7H20', 'M17 4l3 3-3 3'] },
  repeat: { d: ['M7 6h10a3 3 0 0 1 3 3v2', 'M17 3l3 3-3 3', 'M17 18H7a3 3 0 0 1-3-3v-2', 'M7 21l-3-3 3-3'] },
  photos: {
    d: ['M3.5 6.5A2 2 0 0 1 5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
        'M3.6 16.2 8 11.8l3.2 3.2', 'M13.5 13.5 16 11l4.4 4.4'],
    c: [[8.6, 8.8, 1.3]],
  },
  settings: {
    d: ['M4 7h9', 'M17.5 7H20', 'M4 12h3.5', 'M12 12h8', 'M4 17h9', 'M17.5 17H20'],
    c: [[15.2, 7, 2.2], [9.7, 12, 2.2], [15.2, 17, 2.2]],
  },
  // A control surface — a bezel with six keys — rather than the 2x2 grid
  // `rooms` already uses. Two nav items that differ only in the number of
  // squares are two nav items nobody can tell apart at a glance.
  grid: {
    d: ['M3.5 5.5A2 2 0 0 1 5.5 3.5h13a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z'],
    c: [
      [8, 9, 1.15], [12, 9, 1.15], [16, 9, 1.15],
      [8, 15, 1.15], [12, 15, 1.15], [16, 15, 1.15],
    ],
  },

  /* ── Macro pages ────────────────────────────────────────────────────────
     Call control, because that is what the Room Bar's macro pages were for.
     `phoneDown` is the handset rotated 135 degrees, which is the universal
     hang-up glyph and costs nothing beyond the `rot` the fan already uses. */
  phone: {
    d: [
      'M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2C10.6 19.5 4.5 13.4 4.5 5.5a2 2 0 0 1 2-2z',
    ],
  },
  phoneDown: {
    d: [
      'M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2C10.6 19.5 4.5 13.4 4.5 5.5a2 2 0 0 1 2-2z',
    ],
    rot: [135],
  },
  mic: {
    d: [
      'M12 3.5a2.6 2.6 0 0 1 2.6 2.6v5a2.6 2.6 0 0 1-5.2 0v-5A2.6 2.6 0 0 1 12 3.5z',
      'M5.5 11a6.5 6.5 0 0 0 13 0',
      'M12 17.5v3',
    ],
  },
  micOff: {
    d: [
      'M12 3.5a2.6 2.6 0 0 1 2.6 2.6v5a2.6 2.6 0 0 1-5.2 0v-5A2.6 2.6 0 0 1 12 3.5z',
      'M5.5 11a6.5 6.5 0 0 0 13 0',
      'M12 17.5v3',
      'M4 4l16 16',
    ],
  },
  tv: {
    d: [
      'M3.5 6.5A1.5 1.5 0 0 1 5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 16H5a1.5 1.5 0 0 1-1.5-1.5z',
      'M8 20h8',
    ],
  },
  /* Four corners pushing outward — the standard "go full screen" mark. Its
     pair, `collapse`, is the same corners pulled back in, so the two read as
     one control in two states rather than as two different buttons. */
  expand: {
    d: [
      'M9 3.5H4.5A1 1 0 0 0 3.5 4.5V9',
      'M15 3.5h4.5a1 1 0 0 1 1 1V9',
      'M15 20.5h4.5a1 1 0 0 0 1-1V15',
      'M9 20.5H4.5a1 1 0 0 1-1-1V15',
    ],
  },
  collapse: {
    d: [
      'M3.5 9H8a1 1 0 0 0 1-1V3.5',
      'M20.5 9H16a1 1 0 0 1-1-1V3.5',
      'M20.5 15H16a1 1 0 0 0-1 1v4.5',
      'M3.5 15H8a1 1 0 0 1 1 1v4.5',
    ],
  },
  /*
   * Selfview — the local preview, drawn as picture-in-picture.
   *
   * It cannot be the `camera` glyph, and that matters more now than when it
   * was written: Selfview and the Camera toggle sit side by side in the same
   * row, and they mean opposite things — one is what you see, the other is
   * what the far end sees.
   */
  pip: {
    d: [
      'M3.5 6.5h17a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z',
      'M13 11.5h6v4h-6z',
    ],
  },
  camera: {
    d: [
      'M3.5 8.2A1.7 1.7 0 0 1 5.2 6.5h7.6a1.7 1.7 0 0 1 1.7 1.7v7.6a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7z',
      'M14.5 10.8l4.4-2.9a.7.7 0 0 1 1.1.6v7a.7.7 0 0 1-1.1.6l-4.4-2.9z',
    ],
  },
  share: {
    d: [
      'M3.5 6.5A1.5 1.5 0 0 1 5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 16H5a1.5 1.5 0 0 1-1.5-1.5z',
      'M12 13V8',
      'M9.5 10.5 12 8l2.5 2.5',
      'M8 20h8',
    ],
  },
  bolt: { d: ['M13 3 6 13.5h4.6L11 21l7-10.5h-4.6z'] },
  /* Occupancy on a device tile. Two figures, not one: "1 person" beside a
     single silhouette reads as a login, beside a pair it reads as a count. */
  people: {
    d: [
      'M3.5 19.5a5.5 5.5 0 0 1 11 0',
      'M16.5 6.2a3 3 0 0 1 0 5.6',
      'M18.8 19.5a5 5 0 0 0-2.4-4.2',
    ],
    c: [[9, 8, 3.2]],
  },

  /* ── Macro-page variants ────────────────────────────────────────────────
     A control surface is read by SHAPE, not by label — you are mid-call and
     not looking straight at the key you are reaching for. So no two keys in
     the same group may share a glyph, which is what these exist to fix.

     Each is the base glyph plus one distinguishing mark, so the pair still
     reads as a pair: `cameraOff` is `camera` with the same slash `micOff`
     uses, `volumeUp`/`volumeDown` are `volume`'s cone with a + and a -. */
  cameraOff: {
    d: [
      'M3.5 8.2A1.7 1.7 0 0 1 5.2 6.5h7.6a1.7 1.7 0 0 1 1.7 1.7v7.6a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7z',
      'M14.5 10.8l4.4-2.9a.7.7 0 0 1 1.1.6v7a.7.7 0 0 1-1.1.6l-4.4-2.9z',
      'M4 4l16 16',
    ],
  },
  /* No sound arc on these two: the arc lives where the +/- has to go, and
     the pair rendered as an unreadable blob. Cone plus one sign, exactly as
     `mute` is cone plus a cross. */
  volumeUp: {
    f: ['M3 9.5h3.4L11 5.4v13.2L6.4 14.5H3z'],
    d: ['M14.8 12h5.8', 'M17.7 9.1v5.8'],
  },
  volumeDown: {
    f: ['M3 9.5h3.4L11 5.4v13.2L6.4 14.5H3z'],
    d: ['M14.8 12h5.8'],
  },
  /* A display with an arrow going IN, against `share`'s arrow going out —
     the two are opposites and should look like opposites. */
  input: {
    d: [
      'M3.5 6.5A1.5 1.5 0 0 1 5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 16H5a1.5 1.5 0 0 1-1.5-1.5z',
      'M12 7.5v5',
      'M9.5 10 12 12.5 14.5 10',
      'M8 20h8',
    ],
  },
  bulbOff: {
    d: [
      'M9.2 18h5.6', 'M10.2 20.8h3.6',
      'M12 3.2a6 6 0 0 0-3.4 10.9c.6.5 1 1.2 1 2h4.8c0-.8.4-1.5 1-2A6 6 0 0 0 12 3.2z',
      'M4 4l16 16',
    ],
  },
  /* Shut Down, against Start Room's `power`. A second power symbol — even
     tinted red — reads as the same key twice; a moon does not. */
  moon: { d: ['M20.2 14.8A8.6 8.6 0 0 1 9.2 3.8a8.6 8.6 0 1 0 11 11z'] },
  /* Dim, against Full's `sun`: same core, half the rays and shorter. */
  sunDim: {
    c: [[12, 12, 4]],
    d: ['M12 3.4v1.4', 'M12 19.2v1.4', 'M3.4 12h1.4', 'M19.2 12h1.4'],
  },
  hexagon: { d: ['M12 3.2 19.5 7.6v8.8L12 20.8 4.5 16.4V7.6z'] },

  /* ── Rooms ──────────────────────────────────────────────────────────── */
  sofa: {
    // The arms have to rise ABOVE the seat line or the whole thing reads as a
    // box at 1.75rem. The single body path dips between the two arms to make
    // that shape explicit; the vertical stroke is the cushion divider, which
    // is what stops it looking like a car.
    d: ['M20 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v3',
        'M2 11v5a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v2H6v-2a2 2 0 0 0-4 0z',
        'M12 4.5v8.5', 'M4.5 18v1.8', 'M19.5 18v1.8'],
  },
  kitchen: {
    d: ['M3.5 10h17', 'M5.5 10v5.5a3.5 3.5 0 0 0 3.5 3.5h6a3.5 3.5 0 0 0 3.5-3.5V10',
        'M18.5 11.5h1.8a1.6 1.6 0 0 1 0 3.2h-1.8', 'M9 10V7.5', 'M15 10V7.5'],
  },
  bed: {
    d: ['M3 18.5V8', 'M3 13h15a3 3 0 0 1 3 3v2.5', 'M3 18.5h18',
        'M7 11V9.6a.9.9 0 0 1 .9-.9h2.6a.9.9 0 0 1 .9.9V11'],
  },
  tree: {
    // Two stacked triangles + trunk. A rounded "cloud" crown reads as a
    // lollipop or a microphone at small sizes; a conifer never does.
    d: ['M12 3.4 7.6 10.2h8.8z', 'M12 8.2 5.9 16h12.2z', 'M12 16v4.4', 'M9.4 20.4h5.2'],
  },
  bath: {
    d: ['M3.5 12h17v2.5a4.5 4.5 0 0 1-4.5 4.5h-8a4.5 4.5 0 0 1-4.5-4.5z',
        'M6 12V6.2A2.2 2.2 0 0 1 8.2 4a2.2 2.2 0 0 1 2.2 2.2', 'M6 19l-1 2', 'M18 19l1 2'],
  },
  office: {
    d: ['M3.5 5.5A1 1 0 0 1 4.5 4.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z',
        'M12 15.5V19', 'M7.5 19h9'],
  },

  /* ── Entity domains ─────────────────────────────────────────────────── */
  bulb: {
    d: ['M9.2 18h5.6', 'M10.2 20.8h3.6',
        'M12 3.2a6 6 0 0 0-3.4 10.9c.6.5 1 1.2 1 2h4.8c0-.8.4-1.5 1-2A6 6 0 0 0 12 3.2z'],
  },
  power: { d: ['M12 3.8v8.4', 'M7.4 6.6a7 7 0 1 0 9.2 0'] },
  thermometer: {
    d: ['M14 14.4V5.2a2 2 0 0 0-4 0v9.2a4 4 0 1 0 4 0z'],
  },
  blinds: {
    d: ['M3.5 4.5h17', 'M3.5 8h17', 'M3.5 11.5h17', 'M5.5 11.5v6', 'M18.5 11.5v6',
        'M9 15h6'],
  },
  lock: {
    d: ['M4.8 12.4a1.6 1.6 0 0 1 1.6-1.6h11.2a1.6 1.6 0 0 1 1.6 1.6v6.4a1.6 1.6 0 0 1-1.6 1.6H6.4a1.6 1.6 0 0 1-1.6-1.6z',
        'M8 10.8V7.6a4 4 0 0 1 8 0v3.2'],
  },
  unlock: {
    d: ['M4.8 12.4a1.6 1.6 0 0 1 1.6-1.6h11.2a1.6 1.6 0 0 1 1.6 1.6v6.4a1.6 1.6 0 0 1-1.6 1.6H6.4a1.6 1.6 0 0 1-1.6-1.6z',
        'M8 10.8V7.6a4 4 0 0 1 7.4-2.1'],
  },
  fan: {
    c: [[12, 12, 2.1]],
    d: ['M12 9.9c0-3-1.2-5-3.2-5.6C7.2 3.9 6 5 6 6.4c0 2 2.4 3.5 6 3.5z'],
    rot: [0, 120, 240],
  },
  scene: {
    d: ['M12 3.2 13.9 8.4 19.2 10.3 13.9 12.2 12 17.4 10.1 12.2 4.8 10.3 10.1 8.4z',
        'M18.5 16.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z'],
  },
  script: {
    d: ['M6.5 3.8h8.2L19 8.1v12.1a1 1 0 0 1-1 1H6.5a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1z',
        'M14.2 3.8v4.6H19', 'M8.8 12.5h6.4', 'M8.8 16h4.4'],
  },
  motion: {
    d: ['M13.6 6.4 10.4 9.2l1.6 3.6-2.4 4.4', 'M12 12.8 8.4 11.2 5.6 13.2',
        'M12 12.8l3.6 1.2 1.2 3.6'],
    c: [[14.4, 3.6, 1.6]],
  },
  door: {
    d: ['M5.5 20.5h13', 'M7.5 20.5V4.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v16'],
    c: [[14.2, 12.4, 0.9]],
  },

  /* ── Media transport ────────────────────────────────────────────────── */
  play: { f: ['M7.5 4.9a1 1 0 0 1 1.53-.85l9.2 6.1a1 1 0 0 1 0 1.7l-9.2 6.1a1 1 0 0 1-1.53-.85z'] },
  pause: { f: ['M7 4.5h3.2v15H7z', 'M13.8 4.5H17v15h-3.2z'] },
  prev: { f: ['M7.5 5h2.6v14H7.5z', 'M18.5 6.1a1 1 0 0 0-1.55-.83l-6 5.9a1 1 0 0 0 0 1.66l6 5.9a1 1 0 0 0 1.55-.83z'] },
  next: { f: ['M13.9 5h2.6v14h-2.6z', 'M5.5 6.1a1 1 0 0 1 1.55-.83l6 5.9a1 1 0 0 1 0 1.66l-6 5.9A1 1 0 0 1 5.5 17.9z'] },
  volume: {
    f: ['M4 9.5h3.4L12 5.4v13.2L7.4 14.5H4z'],
    d: ['M15.4 9.4a3.6 3.6 0 0 1 0 5.2', 'M18 6.8a7.2 7.2 0 0 1 0 10.4'],
  },
  mute: {
    f: ['M4 9.5h3.4L12 5.4v13.2L7.4 14.5H4z'],
    d: ['M16 10l4.5 4.5', 'M20.5 10 16 14.5'],
  },
  speaker: {
    d: ['M6.5 3.8h11a1 1 0 0 1 1 1v14.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1z'],
    c: [[12, 14, 3.2], [12, 7.6, 1]],
  },

  /* ── Browsing ───────────────────────────────────────────────────────── */
  search: { c: [[10.8, 10.8, 6.4]], d: ['M15.4 15.4 20.5 20.5'] },
  heart: {
    d: [
      'M12 20.2 4.6 12.8a4.6 4.6 0 0 1 6.5-6.5l.9.9.9-.9a4.6 4.6 0 1 1 6.5 6.5z',
    ],
  },
  disc: { c: [[12, 12, 8.4], [12, 12, 2.2]] },
  list: { d: ['M8.5 6.5h11', 'M8.5 12h11', 'M8.5 17.5h11'], c: [[4.6, 6.5, 1], [4.6, 12, 1], [4.6, 17.5, 1]] },
  radio: {
    d: ['M8.2 8.6a5 5 0 0 0 0 6.8', 'M15.8 8.6a5 5 0 0 1 0 6.8', 'M5.2 5.6a9 9 0 0 0 0 12.8', 'M18.8 5.6a9 9 0 0 1 0 12.8'],
    c: [[12, 12, 1.6]],
  },

  /* ── Status and chrome ──────────────────────────────────────────────── */
  chevronRight: { d: ['M9.5 5.5 16 12l-6.5 6.5'] },
  chevronLeft: { d: ['M14.5 5.5 8 12l6.5 6.5'] },
  chevronDown: { d: ['M5.5 9.5 12 16l6.5-6.5'] },
  chevronUp: { d: ['M5.5 14.5 12 8l6.5 6.5'] },
  close: { d: ['M6 6l12 12', 'M18 6 6 18'] },
  check: { d: ['M4.8 12.6 9.6 17.4 19.2 6.6'] },
  minus: { d: ['M5 12h14'] },
  plus: { d: ['M12 5v14', 'M5 12h14'] },
  alert: {
    d: ['M10.3 4.2 2.6 17.4a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z',
        'M12 9.2v4.4', 'M12 17.1v.1'],
  },
  link: {
    d: ['M2.5 12.2a7.5 7.5 0 0 1 4.1-6.7', 'M21.5 12.2a7.5 7.5 0 0 0-4.1-6.7',
        'M6.2 14.2a4.4 4.4 0 0 1 2.6-4', 'M17.8 14.2a4.4 4.4 0 0 0-2.6-4'],
    c: [[12, 17.4, 1.9]],
  },
  linkOff: {
    d: ['M2.5 12.2a7.5 7.5 0 0 1 2.2-5.3', 'M21.5 12.2a7.5 7.5 0 0 0-2.2-5.3',
        'M3 3l18 18'],
    c: [[12, 17.4, 1.9]],
  },
  refresh: {
    d: ['M20.2 12a8.2 8.2 0 1 1-2.6-6', 'M20.5 4.2v4.6h-4.6'],
  },
  sun: {
    c: [[12, 12, 4]],
    d: ['M12 2.6v2.2', 'M12 19.2v2.2', 'M4.3 4.3l1.6 1.6', 'M18.1 18.1l1.6 1.6',
        'M2.6 12h2.2', 'M19.2 12h2.2', 'M4.3 19.7l1.6-1.6', 'M18.1 5.9l1.6-1.6'],
  },
  cloud: {
    d: ['M7 18.5a4.2 4.2 0 0 1-.4-8.4A5.6 5.6 0 0 1 17.4 10a3.8 3.8 0 0 1 .6 8.5z'],
  },
  droplet: { d: ['M12 3.4c3 3.6 5.4 6.5 5.4 9.2A5.4 5.4 0 0 1 6.6 12.6c0-2.7 2.4-5.6 5.4-9.2z'] },
  clock: { c: [[12, 12, 8.4]], d: ['M12 7.2V12l3.2 2'] },
  dots: { c: [[5.5, 12, 1.4], [12, 12, 1.4], [18.5, 12, 1.4]] },
};

export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: string;
  /** Any CSS length. Defaults to 1.5em so icons scale with their context. */
  size?: string;
  /** Stroke width in viewBox units. */
  weight?: number;
  class?: string;
}

export function Icon({ name, size = '1.5em', weight = 1.7, class: cls }: IconProps) {
  const spec = ICONS[name];
  if (!spec) return null;

  const body: VNode[] = [];

  for (const d of spec.f ?? []) {
    body.push(<path d={d} fill="currentColor" stroke="none" />);
  }
  for (const d of spec.d ?? []) {
    body.push(<path d={d} />);
  }
  for (const [cx, cy, r] of spec.c ?? []) {
    body.push(<circle cx={cx} cy={cy} r={r} />);
  }

  const content = spec.rot
    ? spec.rot.map((deg) => <g transform={`rotate(${deg} 12 12)`}>{body}</g>)
    : body;

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width={weight}
      stroke-linecap="round"
      stroke-linejoin="round"
      class={cls}
      aria-hidden="true"
      focusable="false"
      /* The icon is decorative in every current use; the accessible name
         always comes from the surrounding control's label. */
    >
      {content}
    </svg>
  );
}

export function hasIcon(name: string): boolean {
  return name in ICONS;
}
