import { useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { markActivity } from '~/state/ui.ts';

/**
 * The detail sheet: a panel that slides up over the screen with an entity's
 * full controls.
 *
 * A sheet rather than a separate route, because the context matters — you
 * opened *this* light from *this* room, and the dashboard staying visible
 * behind it says so. It also means dismissing is a tap anywhere outside,
 * which is far more forgiving on a wall panel than hunting for a back button.
 *
 * Notes:
 *  - Enters with `transform`/`opacity` only. No height or top animation.
 *  - The scrim is a flat colour by default; blur only when `ui.blur` is on,
 *    via the `--scrim` token (docs/ROOMOS.md §2).
 *  - Any interaction inside counts as activity, so the screensaver cannot
 *    take over while someone is mid-adjustment.
 */

export interface SheetProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children?: ComponentChildren;
}

export function Sheet({ title, subtitle, onClose, children }: SheetProps) {
  const panel = useRef<HTMLDivElement | null>(null);

  // Escape closes it. Irrelevant on the Navigator, essential when developing
  // in a desktop browser.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div class="sheet-layer" onPointerDown={() => markActivity()}>
      {/* Scrim. Pointer-down (not click) so dismissal feels immediate. */}
      <div class="sheet-scrim" onPointerDown={onClose} />

      <div class="sheet" ref={panel} role="dialog" aria-label={title} aria-modal="true">
        <div class="sheet-head">
          <div class="sheet-titles">
            <h2 class="sheet-title truncate">{title}</h2>
            {subtitle ? <div class="sheet-subtitle truncate">{subtitle}</div> : null}
          </div>
          <Pressable class="sheet-close p-sm" onPress={onClose} ariaLabel="Close">
            <Icon name="close" size="1.4rem" weight={2} />
          </Pressable>
        </div>

        <div class="sheet-body scroll">{children}</div>
      </div>
    </div>
  );
}

/** A labelled group inside a sheet. */
export function SheetSection({
  label,
  children,
}: {
  label?: string;
  children?: ComponentChildren;
}) {
  return (
    <div class="sheet-section">
      {label ? <div class="sheet-section-label">{label}</div> : null}
      {children}
    </div>
  );
}

/**
 * A row of mutually exclusive options — HVAC modes, fan presets, sources.
 *
 * Wraps rather than scrolls: a horizontally scrolling strip of options on a
 * touch panel hides choices behind a gesture nobody discovers.
 */
export function OptionRow({
  options,
  value,
  onSelect,
  ariaLabel,
}: {
  options: { value: string; label: string; icon?: string }[];
  value: string | undefined;
  onSelect: (value: string) => void;
  ariaLabel?: string;
}) {
  return (
    <div class="option-row" role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <Pressable
          key={opt.value}
          class={opt.value === value ? 'option is-selected' : 'option'}
          onPress={() => onSelect(opt.value)}
          ariaPressed={opt.value === value}
          ariaLabel={opt.label}
        >
          {opt.icon ? <Icon name={opt.icon} size="1.1rem" weight={1.8} /> : null}
          <span class="truncate">{opt.label}</span>
        </Pressable>
      ))}
    </div>
  );
}

/** A big primary on/off control for the top of a sheet. */
export function PowerButton({
  on,
  onPress,
  disabled,
  labelOn = 'On',
  labelOff = 'Off',
}: {
  on: boolean;
  onPress: () => void;
  disabled?: boolean;
  labelOn?: string;
  labelOff?: string;
}) {
  return (
    <Pressable
      class={on ? 'power-button is-on' : 'power-button'}
      onPress={onPress}
      disabled={disabled}
      ariaPressed={on}
      ariaLabel={on ? labelOn : labelOff}
    >
      <Icon name="power" size="1.5rem" weight={2} />
      <span>{on ? labelOn : labelOff}</span>
    </Pressable>
  );
}
