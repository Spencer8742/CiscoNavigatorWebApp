import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { ui } from '~/config/index.ts';
import { linkStatus, navigate, route, ROUTES, type Route } from '~/state/ui.ts';

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
  media: 'Media',
  photos: 'Photos',
  settings: 'Settings',
};

const ICONS: Record<Route, string> = {
  home: 'home',
  rooms: 'rooms',
  media: 'media',
  photos: 'photos',
  settings: 'settings',
};

export function Nav() {
  const pos = ui.value.navPosition;
  const active = route.value;
  const status = linkStatus.value;

  return (
    <nav class="nav" data-pos={pos} aria-label="Primary">
      {ROUTES.map((r) => (
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
