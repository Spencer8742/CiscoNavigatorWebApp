import type { JSX } from 'preact';
import type { EntityState } from '@shared/protocol.ts';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Slider } from '~/components/Slider.tsx';
import { OptionRow, PowerButton, SheetSection } from '~/components/Sheet.tsx';
import { attrNumber, attrString } from '~/domains/registry.ts';
import { formatDecimal, formatRelative } from '~/lib/format.ts';
import { ui } from '~/config/index.ts';
import * as act from '~/state/actions.ts';

/**
 * Domain-specific controls, rendered inside a detail sheet.
 *
 * Each domain gets one function here and one line in `CONTROLS`. Adding
 * `vacuum` or `humidifier` support means writing a component and registering
 * it — no screen, no router, and no shared state has to change. That is the
 * whole point of the registry.
 *
 * Every control follows the same contract: read from the entity's signal,
 * write optimistically via `state/actions.ts`, and let Home Assistant's echo
 * reconcile. None of them wait on the network.
 */

interface ControlProps {
  state: EntityState;
  id: string;
}

/* ── Attribute helpers ────────────────────────────────────────────────────*/

function attrStringList(s: EntityState, key: string): string[] {
  const v = s.a[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function supportsColorTemp(s: EntityState): boolean {
  return attrStringList(s, 'supported_color_modes').some((m) => m === 'color_temp');
}

function supportsColor(s: EntityState): boolean {
  return attrStringList(s, 'supported_color_modes').some((m) =>
    ['hs', 'rgb', 'rgbw', 'rgbww', 'xy'].includes(m),
  );
}

function titleCase(v: string): string {
  return v ? v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ') : '';
}

/* ── Light ────────────────────────────────────────────────────────────────*/

function LightControl({ state, id }: ControlProps) {
  const on = state.s === 'on';
  const brightness = attrNumber(state, 'brightness');
  const pct = brightness === undefined ? 0 : Math.round((brightness / 255) * 100);

  const minK = attrNumber(state, 'min_color_temp_kelvin') ?? 2000;
  const maxK = attrNumber(state, 'max_color_temp_kelvin') ?? 6500;
  const kelvin = attrNumber(state, 'color_temp_kelvin') ?? Math.round((minK + maxK) / 2);


  return (
    <>
      <SheetSection>
        <PowerButton on={on} onPress={() => act.toggle(id)} />
      </SheetSection>

      {/* Brightness only appears if the light actually reports it — a
          non-dimmable bulb should not show a slider that does nothing. */}
      {brightness !== undefined || on ? (
        <SheetSection label="Brightness">
          <Slider
            size="lg"
            class="slider-warm"
            value={on ? pct : 0}
            min={1}
            max={100}
            ariaLabel="Brightness"
            readout={`${on ? pct : 0}%`}
            icon={<Icon name="bulb" size="1.25rem" weight={1.8} />}
            onChange={(v, final) => act.setBrightness(id, v, final)}
          />
        </SheetSection>
      ) : null}

      {supportsColorTemp(state) ? (
        <SheetSection label="Colour temperature">
          <Slider
            class="slider-temp"
            value={kelvin}
            min={minK}
            max={maxK}
            step={50}
            ariaLabel="Colour temperature"
            readout={`${Math.round(kelvin)}K`}
            onChange={(v, final) => act.setColorTemp(id, v, final)}
          />
        </SheetSection>
      ) : null}

      {supportsColor(state) ? <ColorSwatches id={id} state={state} /> : null}

    </>
  );
}

/**
 * A fixed palette rather than a colour wheel.
 *
 * A wheel needs precise dragging on a device with no cursor, and RoomOS has
 * no native colour picker (docs/ROOMOS.md §6). Twelve large swatches cover
 * what anyone actually picks from a wall panel, and each is a single tap.
 */
const SWATCHES: [number, number, number][] = [
  [255, 147, 41], // candle
  [255, 197, 143], // warm white
  [255, 255, 251], // neutral
  [201, 226, 255], // cool
  [255, 87, 87], // red
  [255, 138, 61], // orange
  [255, 214, 74], // yellow
  [126, 217, 87], // green
  [64, 200, 224], // cyan
  [91, 157, 255], // blue
  [167, 120, 255], // violet
  [255, 105, 180], // pink
];

function ColorSwatches({ id, state }: { id: string; state: EntityState }) {
  const current = state.a['rgb_color'];
  const currentKey = Array.isArray(current) ? current.join(',') : '';

  return (
    <SheetSection label="Colour">
      <div class="swatches">
        {SWATCHES.map((rgb) => {
          const key = rgb.join(',');
          return (
            <Pressable
              key={key}
              class={key === currentKey ? 'swatch is-selected p-sm' : 'swatch p-sm'}
              onPress={() => act.setLightColor(id, rgb)}
              ariaLabel={`Colour ${key}`}
              style={{ background: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` }}
            />
          );
        })}
      </div>
    </SheetSection>
  );
}

/* ── Switch / input_boolean ───────────────────────────────────────────────*/

function SwitchControl({ state, id }: ControlProps) {
  return (
    <SheetSection>
      <PowerButton on={state.s === 'on'} onPress={() => act.toggle(id)} />
    </SheetSection>
  );
}

/* ── Fan ──────────────────────────────────────────────────────────────────*/

function FanControl({ state, id }: ControlProps) {
  const on = state.s === 'on';
  const pct = attrNumber(state, 'percentage');
  const presets = attrStringList(state, 'preset_modes');

  return (
    <>
      <SheetSection>
        <PowerButton on={on} onPress={() => act.toggle(id)} />
      </SheetSection>

      {pct !== undefined ? (
        <SheetSection label="Speed">
          <Slider
            size="lg"
            value={on ? pct : 0}
            ariaLabel="Fan speed"
            readout={`${Math.round(on ? pct : 0)}%`}
            icon={<Icon name="fan" size="1.25rem" weight={1.8} />}
            onChange={(v, final) => act.setFanSpeed(id, v, final)}
          />
        </SheetSection>
      ) : null}

      {presets.length > 0 ? (
        <SheetSection label="Preset">
          <OptionRow
            options={presets.map((p) => ({ value: p, label: titleCase(p) }))}
            value={attrString(state, 'preset_mode')}
            onSelect={(v) => act.setFanPreset(id, v)}
            ariaLabel="Fan preset"
          />
        </SheetSection>
      ) : null}
    </>
  );
}

/* ── Cover ────────────────────────────────────────────────────────────────*/

function CoverControl({ state, id }: ControlProps) {
  const position = attrNumber(state, 'current_position');

  return (
    <>
      <SheetSection>
        <div class="cover-buttons">
          <Pressable class="cover-button" onPress={() => act.openCover(id)} ariaLabel="Open">
            <Icon name="chevronDown" size="1.6rem" weight={2} class="flip-y" />
            <span>Open</span>
          </Pressable>
          <Pressable class="cover-button" onPress={() => act.stopCover(id)} ariaLabel="Stop">
            <Icon name="minus" size="1.6rem" weight={2} />
            <span>Stop</span>
          </Pressable>
          <Pressable class="cover-button" onPress={() => act.closeCover(id)} ariaLabel="Close">
            <Icon name="chevronDown" size="1.6rem" weight={2} />
            <span>Close</span>
          </Pressable>
        </div>
      </SheetSection>

      {/* Position only when the cover reports it — many roller blinds are
          open/close only, and a fake position slider would lie. */}
      {position !== undefined ? (
        <SheetSection label="Position">
          <Slider
            size="lg"
            value={position}
            ariaLabel="Cover position"
            readout={`${Math.round(position)}%`}
            icon={<Icon name="blinds" size="1.25rem" weight={1.8} />}
            onChange={(v, final) => act.setCoverPosition(id, v, final)}
          />
        </SheetSection>
      ) : null}
    </>
  );
}

/* ── Climate ──────────────────────────────────────────────────────────────*/

function ClimateControl({ state, id }: ControlProps) {
  const locale = ui.value.locale;
  const current = attrNumber(state, 'current_temperature');
  const target = attrNumber(state, 'temperature');
  const minTemp = attrNumber(state, 'min_temp') ?? 7;
  const maxTemp = attrNumber(state, 'max_temp') ?? 35;
  const modes = attrStringList(state, 'hvac_modes');
  const fanModes = attrStringList(state, 'fan_modes');
  const action = attrString(state, 'hvac_action');

  return (
    <>
      <SheetSection>
        <div class="climate-readout">
          <div class="climate-target">
            <Pressable
              class="climate-step p-sm"
              onPress={() => target !== undefined && act.setTargetTemperature(id, target - 0.5, true)}
              disabled={target === undefined}
              ariaLabel="Decrease target temperature"
            >
              <Icon name="minus" size="1.5rem" weight={2.2} />
            </Pressable>

            <div class="climate-value tnum">
              {target !== undefined ? `${formatDecimal(target, locale)}°` : '—'}
            </div>

            <Pressable
              class="climate-step p-sm"
              onPress={() => target !== undefined && act.setTargetTemperature(id, target + 0.5, true)}
              disabled={target === undefined}
              ariaLabel="Increase target temperature"
            >
              <Icon name="plus" size="1.5rem" weight={2.2} />
            </Pressable>
          </div>

          <div class="climate-meta">
            {current !== undefined ? (
              <span>Currently {formatDecimal(current, locale)}°</span>
            ) : null}
            {action ? <span class="climate-action" data-action={action}>{titleCase(action)}</span> : null}
          </div>
        </div>
      </SheetSection>

      {target !== undefined ? (
        <SheetSection>
          <Slider
            size="lg"
            class="slider-warm"
            value={target}
            min={minTemp}
            max={maxTemp}
            step={0.5}
            ariaLabel="Target temperature"
            readout={`${formatDecimal(target, locale)}°`}
            icon={<Icon name="thermometer" size="1.25rem" weight={1.8} />}
            onChange={(v, final) => act.setTargetTemperature(id, v, final)}
          />
        </SheetSection>
      ) : null}

      {modes.length > 0 ? (
        <SheetSection label="Mode">
          <OptionRow
            options={modes.map((m) => ({ value: m, label: titleCase(m) }))}
            value={state.s}
            onSelect={(v) => act.setHvacMode(id, v)}
            ariaLabel="HVAC mode"
          />
        </SheetSection>
      ) : null}

      {fanModes.length > 0 ? (
        <SheetSection label="Fan">
          <OptionRow
            options={fanModes.map((m) => ({ value: m, label: titleCase(m) }))}
            value={attrString(state, 'fan_mode')}
            onSelect={(v) => act.setClimateFanMode(id, v)}
            ariaLabel="Fan mode"
          />
        </SheetSection>
      ) : null}
    </>
  );
}

/* ── Lock ─────────────────────────────────────────────────────────────────*/

function LockControl({ state, id }: ControlProps) {
  const locked = state.s === 'locked';
  const busy = state.s === 'locking' || state.s === 'unlocking';

  return (
    <SheetSection>
      <div class="lock-buttons">
        <Pressable
          class={locked ? 'lock-button is-active' : 'lock-button'}
          onPress={() => act.setLock(id, true)}
          disabled={busy}
          ariaLabel="Lock"
        >
          <Icon name="lock" size="1.6rem" weight={1.9} />
          <span>Lock</span>
        </Pressable>
        <Pressable
          class={!locked && !busy ? 'lock-button is-danger' : 'lock-button'}
          onPress={() => act.setLock(id, false)}
          disabled={busy}
          ariaLabel="Unlock"
        >
          <Icon name="unlock" size="1.6rem" weight={1.9} />
          <span>Unlock</span>
        </Pressable>
      </div>
      {busy ? <div class="sheet-hint">{titleCase(state.s)}…</div> : null}
    </SheetSection>
  );
}

/* ── Scene / script / button ──────────────────────────────────────────────*/

function ActivateControl({ state, id }: ControlProps) {
  const running = state.s === 'on';
  return (
    <SheetSection>
      <Pressable class="activate-button" onPress={() => act.activate(id)} ariaLabel="Activate">
        <Icon name="scene" size="1.5rem" weight={1.9} />
        <span>{running ? 'Running — run again' : 'Activate'}</span>
      </Pressable>
    </SheetSection>
  );
}

/* ── Input helpers ────────────────────────────────────────────────────────*/

function SelectControl({ state, id }: ControlProps) {
  const options = attrStringList(state, 'options');
  return (
    <SheetSection label="Options">
      <OptionRow
        options={options.map((o) => ({ value: o, label: titleCase(o) }))}
        value={state.s}
        onSelect={(v) => act.selectOption(id, v)}
        ariaLabel="Options"
      />
    </SheetSection>
  );
}

function NumberControl({ state, id }: ControlProps) {
  const value = Number.parseFloat(state.s);
  const min = attrNumber(state, 'min') ?? 0;
  const max = attrNumber(state, 'max') ?? 100;
  const step = attrNumber(state, 'step') ?? 1;
  const unit = attrString(state, 'unit_of_measurement') ?? '';

  if (!Number.isFinite(value)) return null;

  return (
    <SheetSection>
      <Slider
        size="lg"
        value={value}
        min={min}
        max={max}
        step={step}
        ariaLabel="Value"
        readout={`${formatDecimal(value, ui.value.locale, 2)}${unit ? ' ' + unit : ''}`}
        onChange={(v, final) => act.setNumber(id, v, final)}
      />
    </SheetSection>
  );
}

/* ── Read-only ────────────────────────────────────────────────────────────*/

function ReadOnlyControl({ state }: ControlProps) {
  const rows: [string, string][] = [];
  const cls = attrString(state, 'device_class');
  if (cls) rows.push(['Class', titleCase(cls)]);
  rows.push(['State', titleCase(state.s)]);
  rows.push(['Last changed', formatRelative(state.lc)]);

  return (
    <SheetSection>
      <div class="rows">
        {rows.map(([k, v]) => (
          <div class="rows-row" key={k}>
            <span class="rows-key">{k}</span>
            <span class="rows-val">{v}</span>
          </div>
        ))}
      </div>
    </SheetSection>
  );
}

/* ── Registry ─────────────────────────────────────────────────────────────*/

type ControlComponent = (props: ControlProps) => JSX.Element | null;

const CONTROLS: Record<string, ControlComponent> = {
  light: LightControl,
  switch: SwitchControl,
  input_boolean: SwitchControl,
  fan: FanControl,
  cover: CoverControl,
  climate: ClimateControl,
  lock: LockControl,
  scene: ActivateControl,
  script: ActivateControl,
  button: ActivateControl,
  input_button: ActivateControl,
  automation: ActivateControl,
  input_select: SelectControl,
  input_number: NumberControl,
  sensor: ReadOnlyControl,
  binary_sensor: ReadOnlyControl,
};

/** The control for an entity's domain, or a read-only fallback. */
export function controlFor(domain: string): ControlComponent {
  return CONTROLS[domain] ?? ReadOnlyControl;
}
