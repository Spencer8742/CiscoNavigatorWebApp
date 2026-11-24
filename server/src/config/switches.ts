import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '~/lib/log.ts';
import type { ControlButton, ControlItem, DashboardConfig } from '@shared/config.ts';

const log = logger('switches');

/**
 * Devices switched on or off from the panel's Settings.
 *
 * "The Desk Pro is out of the room while I try another screen" is a tap, not
 * an edit to dashboard.yaml — and it has to be undone just as easily. So the
 * choice lives in a small machine-owned file beside the YAML, like
 * panel-prefs.json and for the same reason: the YAML is the user's,
 * hand-written and commented, and is never written to.
 *
 * Only what was switched is stored. A device the file does not mention
 * follows `enabled:` in the YAML (on, when that is not written either).
 */
export class DeviceSwitches {
  readonly #path: string;
  /** roomos device id → on/off, for the devices somebody has switched. */
  #roomos = new Map<string, boolean>();

  constructor(configPath: string) {
    this.#path = join(dirname(configPath), 'device-switches.json');
    this.#load();
  }

  get roomos(): ReadonlyMap<string, boolean> {
    return this.#roomos;
  }

  /** Record a switch. Returns false when nothing changed. */
  setRoomos(id: string, enabled: boolean): boolean {
    if (this.#roomos.get(id) === enabled) return false;
    this.#roomos.set(id, enabled);
    this.#save();
    return true;
  }

  #load(): void {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#path, 'utf8'));
      const roomos = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['roomos'] : null;
      if (!roomos || typeof roomos !== 'object' || Array.isArray(roomos)) return;
      for (const [id, value] of Object.entries(roomos as Record<string, unknown>)) {
        if (typeof value === 'boolean') this.#roomos.set(id, value);
      }
      const off = [...this.#roomos].filter(([, on]) => !on).map(([id]) => id);
      if (off.length > 0) log.info(`Switched off in Settings: ${off.join(', ')}`);
    } catch (err) {
      // Missing is the normal case: nothing has been switched yet.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`Could not read ${this.#path}; every device follows dashboard.yaml:`, err);
      }
    }
  }

  #save(): void {
    const file = { version: 1, roomos: Object.fromEntries(this.#roomos) };
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      // Write-then-rename, as panel-prefs.json does: a container killed
      // mid-write keeps the previous file rather than a truncated one.
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.#path);
    } catch (err) {
      // The switch still applies until the next restart.
      log.warn(`Could not persist device switches to ${this.#path}:`, err);
    }
  }
}

/**
 * The config with each device's switch applied, and everything that drives a
 * device that is off taken out of `controls.pages`.
 *
 * Taken out rather than flagged, because the pages are what every consumer
 * walks: the panel draws them, the backend resolves key presses against
 * them, the meeting refresher and the meeting notifications read device
 * tiles off them. Removing the device's items here is one change that all of
 * them obey, where a flag would be a check each of them had to remember.
 *
 * What goes:
 *   - a `device:` tile linked to the device (see ControlDevice.roomos)
 *   - a `volume:` card for it
 *   - each key step on it (`roomos:` and `xcommand`) — the rest of a
 *     multi-device key still runs, so "Office Power" keeps the lights and TV
 *   - a key left with no steps at all, and a page left with no items
 *
 * The device itself stays in `controls.roomos`, marked `enabled: false`:
 * that is what Settings lists so it can be switched back on.
 */
export function applyDeviceSwitches(
  cfg: DashboardConfig,
  roomosSwitches: ReadonlyMap<string, boolean>,
): DashboardConfig {
  const roomos = cfg.controls.roomos.map((d) => ({
    ...d,
    // `?? true`: a config object built without the field (older tests,
    // hand-built fixtures) means a device that is in use.
    enabled: roomosSwitches.get(d.id) ?? d.enabled ?? true,
  }));
  const off = new Set(roomos.filter((d) => !d.enabled).map((d) => d.id));
  if (off.size === 0) return { ...cfg, controls: { ...cfg.controls, roomos } };

  const keyWithout = (key: ControlButton): ControlButton | null => {
    const actions = key.actions.filter(
      (a) => !((a.kind === 'roomos' || a.kind === 'xcommand') && off.has(a.device)),
    );
    if (actions.length === key.actions.length) return key;
    return actions.length > 0 ? { ...key, actions } : null;
  };

  const itemWithout = (item: ControlItem): ControlItem | null => {
    switch (item.type) {
      case 'device':
        if (item.roomos !== undefined && off.has(item.roomos)) return null;
        return {
          ...item,
          keys: item.keys.map(keyWithout).filter((k): k is ControlButton => k !== null),
        };
      case 'volume':
        return off.has(item.device) ? null : item;
      case 'button':
        return keyWithout(item);
      default:
        return item;
    }
  };

  const pages = cfg.controls.pages
    .map((page) => ({
      page,
      items: page.items.map(itemWithout).filter((i): i is ControlItem => i !== null),
    }))
    // An empty page that was ALREADY empty stays: it is the user's, and the
    // panel explains how to fill it. One emptied by a switch is just noise.
    .filter(({ page, items }) => items.length > 0 || page.items.length === 0)
    .map(({ page, items }) => ({ ...page, items }));

  return { ...cfg, controls: { ...cfg.controls, roomos, pages } };
}
