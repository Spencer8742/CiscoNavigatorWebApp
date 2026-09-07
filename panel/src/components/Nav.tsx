import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { ui } from '~/config/index.ts';
import {
  assistListenRequests,
  assistOpen,
  assistWakePaused,
  linkStatus,
  markActivity,
  narrow,
  navigate,
  route,
  visibleRoutes,
  type Route,
} from '~/state/ui.ts';

/**
 * Primary navigation.
 *
 * Position is configurable (`ui.navPosition`), defaulting to a LEFT RAIL.
 * The reasoning, for a 10.1" 16:10 panel:
 *
 *  - Vertical space is the scarce resource for card grids at 1280x800. A
 *    5.25rem rail costs ~7% of the width; the equivalent bottom bar costs
 *    ~12% of the height.
 *  - The rail does not move when the RoomOS soft keyboard slides up, which a
 *    bottom bar does — and the keyboard on this device is tall.
 *  - It reads like an appliance rather than a mobile app, which is the target.
 *
 * Set `navPosition: bottom` if the panel is table-mounted and thumb reach
 * matters more; both layouts are first-class and share this component.
 */

const LABELS: Record<Route, string> = {
  home: 'Home',
  rooms: 'Rooms',
  controls: 'Controls',
  'apple-tv': 'Apple TV',
  media: 'Media',
  photos: 'Photos',
  settings: 'Settings',
};

const ICONS: Record<Route, string> = {
  home: 'home',
  rooms: 'rooms',
  controls: 'grid',
  'apple-tv': 'tv',
  media: 'media',
  photos: 'photos',
  settings: 'settings',
};

export function Nav() {
  // A narrow screen overrides the configured position. `navPosition` is
  // describing a preference for a wall panel; on a phone a left rail costs a
  // fifth of the width and cannot fit seven destinations across.
  const pos = narrow.value ? 'bottom' : ui.value.navPosition;
  const active = route.value;
  const status = linkStatus.value;

  return (
    <nav class="nav" data-pos={pos} aria-label="Primary">
      {visibleRoutes.value.map((r) => (
        <Pressable
          key={r}
          class={r === active ? 'nav-item is-active' : 'nav-item'}
          onPress={() => navigate(r)}
          ariaLabel={LABELS[r]}
          ariaPressed={r === active}
        >
          <span class="nav-item-marker" />
          <Icon name={ICONS[r]} size="1.55rem" weight={r === active ? 2 : 1.7} />
          <span class="nav-item-label">{LABELS[r]}</span>
        </Pressable>
      ))}

      <Pressable
        class="nav-assist p-sm"
        onPress={() => {
          assistWakePaused.value = true;
          assistOpen.value = true;
          assistListenRequests.value += 1;
          markActivity();
        }}
        ariaLabel="Assist"
      >
        <Icon name="mic" size="1.45rem" weight={1.9} />
      </Pressable>

      {/*
        Connection indicator. A dot, not a banner: the link is healthy
        99.9% of the time and a persistent status bar would be permanent
        clutter on a screen this size. When it goes red, Settings has the
        detail.
      */}
      <div
        class="nav-status"
        title={`Connection: ${status}`}
        role="status"
        aria-live="polite"
      >
        <span class="status-dot" data-state={status} />
        <span class="visually-hidden">Connection {status}</span>
      </div>
    </nav>
  );
}
