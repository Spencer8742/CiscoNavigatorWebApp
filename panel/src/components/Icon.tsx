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
  photos: {
    d: ['M3.5 6.5A2 2 0 0 1 5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
        'M3.6 16.2 8 11.8l3.2 3.2', 'M13.5 13.5 16 11l4.4 4.4'],
    c: [[8.6, 8.8, 1.3]],
  },
  settings: {
    d: ['M4 7h9', 'M17.5 7H20', 'M4 12h3.5', 'M12 12h8', 'M4 17h9', 'M17.5 17H20'],
    c: [[15.2, 7, 2.2], [9.7, 12, 2.2], [15.2, 17, 2.2]],
  },

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

  /* ── Status and chrome ──────────────────────────────────────────────── */
  chevronRight: { d: ['M9.5 5.5 16 12l-6.5 6.5'] },
  chevronLeft: { d: ['M14.5 5.5 8 12l6.5 6.5'] },
  chevronDown: { d: ['M5.5 9.5 12 16l6.5-6.5'] },
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
