import type { ComponentChildren } from 'preact';
import { Icon } from '~/components/Icon.tsx';

/**
 * Placeholder for a screen that has nothing to show.
 *
 * Not decoration. On a kiosk panel with no browser chrome, a blank pane is
 * indistinguishable from a crash — and the user cannot hit reload to find
 * out. Every empty state here says what is missing and, where it applies,
 * which file to edit to fix it.
 */
export function Empty({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children?: ComponentChildren;
}) {
  return (
    <div class="empty">
      <Icon name={icon} size="2.75rem" weight={1.4} class="empty-icon" />
      <div class="empty-title">{title}</div>
      {children ? <div class="empty-body">{children}</div> : null}
    </div>
  );
}
