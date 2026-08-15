import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { openEntity, markActivity } from '~/state/ui.ts';
import { canToggle, toggle, activate } from '~/state/actions.ts';
import { domainOf } from '~/lib/format.ts';
import type { DescribedEntity } from '~/state/selectors.ts';

/**
 * The standard entity tile.
 *
 * ## Interaction model
 *
 * **Tap does the obvious thing. Long-press opens the detail.**
 *
 *   light, switch, fan     tap toggles
 *   scene, script, button  tap activates
 *   everything else        tap opens the sheet
 *
 * A wall panel's most common interaction by an order of magnitude is "turn
 * that light off". Making that a single tap, with the detail sheet a
 * long-press away, matches what Apple Home and Control4 do and what people
 * already expect.
 *
 * The risk with long-press is discoverability, so tiles that hide a sheet
 * behind it show a small dot affordance. Domains with no sensible tap action
 * open the sheet on tap instead, so nothing is ever unreachable by tapping.
 */

export interface EntityTileProps {
  item: DescribedEntity;
  size?: 'md' | 'lg';
}

export function EntityTile({ item, size = 'md' }: EntityTileProps) {
  const domain = domainOf(item.id);
  const isActivatable = ACTIVATABLE.has(domain);
  const tapToggles = canToggle(item.id) && !item.unavailable;
  const tapActivates = isActivatable && !item.unavailable;
  // Everything else opens the sheet on tap, so no tile is a dead end.
  const tapOpens = !tapToggles && !tapActivates;

  const openSheet = () => {
    openEntity.value = item.id;
    markActivity();
  };

  const onPress = () => {
    if (tapToggles) toggle(item.id);
    else if (tapActivates) activate(item.id);
    else openSheet();
  };

  return (
    <Pressable
      as="div"
      class={`tile p-lg tile-${size}`}
      onPress={onPress}
      onLongPress={tapOpens ? undefined : openSheet}
      ariaLabel={`${item.name}, ${item.value}`}
      ariaPressed={item.active}
      disabled={item.unavailable}
    >
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

      {/* Affordance for the sheet hidden behind a long-press. Deliberately
          faint — it is a hint, not a button. */}
      {!tapOpens && !item.unavailable ? (
        <span class="tile-more" aria-hidden="true">
          <Icon name="dots" size="1rem" weight={2} />
        </span>
      ) : null}
    </Pressable>
  );
}

const ACTIVATABLE = new Set(['scene', 'script', 'button', 'input_button']);
