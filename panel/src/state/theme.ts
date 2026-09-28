import { computed, effect } from '@preact/signals';
import { ui } from '~/config/index.ts';
import { now } from '~/state/clock.ts';
import { prefs } from '~/state/ui.ts';
import { resolveTheme } from '~/lib/theme.ts';

/**
 * The theme on screen, re-decided each minute by the shared clock so `auto`
 * flips at the hour boundary without a timer of its own.
 */
export const theme = computed(() => resolveTheme(prefs.value.theme, now.value, ui.value.timezone));

/**
 * Keep `<html data-theme>` and the browser chrome in step with `theme`.
 *
 * An attribute on the root rather than a class on the app: tokens.css keys
 * the whole palette off it, so switching repaints without re-rendering a
 * single component.
 */
export function startTheme(): void {
  effect(() => {
    const t = theme.value;
    const root = document.documentElement;
    root.dataset.theme = t;
    root.style.colorScheme = t;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', t === 'light' ? '#F3F4F7' : '#08090C');
  });
}
