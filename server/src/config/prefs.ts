import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '~/lib/log.ts';
import {
  DEFAULT_PREFS,
  LAYOUT_LIMITS,
  PREF_VALUES,
  type PanelPrefs,
  type PlayerLayout,
} from '@shared/protocol.ts';

const log = logger('prefs');

/**
 * The handful of settings a panel can change by tapping.
 *
 * **Why these live on the server.** RoomOS deletes web storage daily by
 * default (docs/ROOMOS.md §3), so anything kept in the browser silently
 * reverts overnight — the worst kind of setting, one that appears to work.
 * Holding them here also means several panels agree, and that a panel
 * reconnecting after a reboot comes back to the same screen it had.
 *
 * **Why a separate file from dashboard.yaml.** That file is the user's,
 * hand-written and commented, and quite possibly in version control.
 * Rewriting it from a tap on a wall panel would destroy the comments and
 * reorder the keys. This is a small machine-owned JSON file instead, and the
 * YAML is never written to.
 */
export class PrefsStore {
  readonly #path: string;
  #prefs: PanelPrefs = { ...DEFAULT_PREFS };
  #listeners = new Set<(p: PanelPrefs) => void>();

  constructor(configPath: string) {
    this.#path = join(dirname(configPath), 'panel-prefs.json');
    this.#load();
  }

  get current(): PanelPrefs {
    return this.#prefs;
  }

  onChange(fn: (p: PanelPrefs) => void): void {
    this.#listeners.add(fn);
  }

  #load(): void {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#path, 'utf8'));
      if (raw && typeof raw === 'object') {
        // Validate on the way IN as well as on the way out. The file is
        // machine-written, but it sits in a user-mounted volume and a
        // half-written or hand-edited one must not take the panel down.
        for (const [key, allowed] of Object.entries(PREF_VALUES)) {
          const value = (raw as Record<string, unknown>)[key];
          if (typeof value === 'string' && allowed.includes(value)) {
            this.#prefs = { ...this.#prefs, [key]: value };
          }
        }
        // The layout is shape-checked rather than enum-checked. Section names
        // are NOT validated here: the config may legitimately have changed
        // since this was written, and dropping a whole arrangement because a
        // heading was renamed would be worse than carrying a stale key that
        // the panel simply ignores.
        const players = (raw as Record<string, unknown>)['players'];
        const layout = sanitizeLayout(players, null);
        if (layout) this.#prefs = { ...this.#prefs, players: layout };
      }
      log.info(`Loaded panel preferences from ${this.#path}`);
    } catch (err) {
      // Missing is the normal first-run case, and defaults are correct then.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`Could not read ${this.#path}, using defaults:`, err);
      }
    }
  }

  /**
   * Apply a change from a panel.
   *
   * Returns an error string, or null on success. The key and value are both
   * checked against the allow-list: this is a message from a client, and the
   * fact that it can only reach a small enum is what keeps it uninteresting
   * to an attacker who has the panel token.
   */
  set(key: string, value: string): string | null {
    const allowed = (PREF_VALUES as Record<string, readonly string[]>)[key];
    if (!allowed) return `Unknown preference "${key}"`;
    if (!allowed.includes(value)) {
      return `"${value}" is not valid for ${key} (expected ${allowed.join(' or ')})`;
    }

    if ((this.#prefs as unknown as Record<string, string>)[key] === value) return null;

    this.#prefs = { ...this.#prefs, [key]: value };
    this.#save();
    for (const fn of this.#listeners) fn(this.#prefs);
    log.info(`Preference ${key} = ${value}`);
    return null;
  }

  /**
   * Replace the player layout.
   *
   * `sections` is the list the config currently declares; a heading the
   * config does not know about is dropped, because it would render as an
   * empty group nobody could remove from the panel.
   */
  setLayout(raw: unknown, sections: readonly string[]): string | null {
    const layout = sanitizeLayout(raw, sections);
    if (!layout) return 'Invalid layout';

    this.#prefs = { ...this.#prefs, players: layout };
    this.#save();
    for (const fn of this.#listeners) fn(this.#prefs);
    return null;
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      // Write-then-rename, so a container killed mid-write leaves the previous
      // file intact rather than a truncated one that fails to parse.
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.#prefs, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.#path);
    } catch (err) {
      // A read-only or unwritable volume must not break the panel: the change
      // still applies in memory, it just will not survive a restart.
      log.warn(`Could not persist preferences to ${this.#path}:`, err);
    }
  }
}

/**
 * Validate a layout arriving from a panel.
 *
 * Everything here is bounded: this ends up on disk, and a client is allowed
 * to write it. Entity ids must look like media players, sections must be
 * declared (when a list is supplied), and every collection is capped.
 *
 * Returns null when the value is not a layout at all; unusable PARTS are
 * dropped rather than rejecting the whole thing, so one bad entry cannot cost
 * someone their arrangement.
 */
function sanitizeLayout(raw: unknown, sections: readonly string[] | null): PlayerLayout | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;

  const ids = (value: unknown, cap: number): string[] => {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      if (!item.startsWith('media_player.')) continue;
      // A speaker in two places at once would render twice and toggle
      // unpredictably.
      if (out.includes(item)) continue;
      out.push(item);
      if (out.length >= cap) break;
    }
    return out;
  };

  const outSections: Record<string, string[]> = {};
  const rawSections = input['sections'];
  if (rawSections && typeof rawSections === 'object' && !Array.isArray(rawSections)) {
    let count = 0;
    for (const [name, value] of Object.entries(rawSections as Record<string, unknown>)) {
      if (count >= LAYOUT_LIMITS.sections) break;
      if (sections && !sections.includes(name)) continue;
      outSections[name] = ids(value, LAYOUT_LIMITS.playersPerSection);
      count += 1;
    }
  }

  return { sections: outSections, hidden: ids(input['hidden'], LAYOUT_LIMITS.hidden) };
}
