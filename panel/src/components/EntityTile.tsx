import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import type { DescribedEntity } from '~/state/selectors.ts';

/**
 * The standard entity tile.
 *
 * Used for favourites and inside rooms. Two sizes, one component, because
 * consistency between the Home screen and a room is most of what makes the
 * panel feel like one product.
 *
 * The `tone` attribute drives the colour of the icon well and the active
 * fill, entirely in CSS — so a light going on is a class change on one
 * element, not a re-render.
 */

export interface EntityTileProps {
  item: DescribedEntity;
  size?: 'md' | 'lg';
  onPress?: () => void;
  onLongPress?: () => void;
}

export function EntityTile({ item, size = 'md', onPress, onLongPress }: EntityTileProps) {
  return (
    <Pressable
      as="div"
      class={`tile p-lg tile-${size}`}
      onPress={onPress}
      onLongPress={onLongPress}
      ariaLabel={`${item.name}, ${item.value}`}
      ariaPressed={item.active}
    >
      {/* data-* rather than conditional classNames: the CSS reads better and
          a state change touches one attribute. */}
      <div
        class="tile-icon"
        data-tone={item.tone}
        data-active={item.active ? '' : undefined}
        data-unavailable={item.unavailable ? '' : undefined}
      >
        <Icon name={item.icon} size={size === 'lg' ? '1.6rem' : '1.4rem'} weight={1.7} />
      </div>

      <div class="tile-text">
        <div class="tile-name truncate">{item.name}</div>
        <div class="tile-value truncate" data-tone={item.tone}>
          {item.value}
        </div>
      </div>
    </Pressable>
  );
}
