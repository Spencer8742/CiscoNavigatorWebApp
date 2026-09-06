import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '~/lib/log.ts';
import {
  BOOLEAN_PREFS,
  DEFAULT_PREFS,
  LAYOUT_LIMITS,
  PANEL_PAGES,
  PREF_VALUES,
  panelIdOf,
  type PanelPrefs,
  type PanelPage,
  type PlayerLayout,
} from '@shared/protocol.ts';

const log = logger('prefs');
const PREFS_SCHEMA = 2;

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
 *
 * ## Per panel
 *
 * Settings are held per panel, keyed by the id a panel names itself with
 * (`?panel=office` in its URL — see shared/protocol.ts `panelIdOf` for why
 * the URL is the only place that identity can live).
 *
 * Two scopes, resolved in order: the built-in defaults, then the `default`
 * block every panel shares, then that panel's own block. The merge is
 * per KEY, not per block — so setting the shared default for one preference
 * still reaches a panel that has only ever overridden a different one.
 *
 * A panel with no id reads and writes the shared `default` block, which is
 * exactly how this behaved before panels could be told apart. That is what
 * makes the change safe to deploy before re-provisioning anything.
 */

/** The shared block's key in `#scopes`. Not a legal panel id, so it cannot collide. */
const SHARED = '';

export class PrefsStore {
  readonly #path: string;
  /** Panel id (or SHARED) → only the preferences that scope actually sets. */
  #scopes = new Map<string, Partial<PanelPrefs>>();
  #listeners = new Set<() => void>();

  constructor(configPath: string) {
    this.#path = join(dirname(configPath), 'panel-prefs.json');
    this.#load();
  }

  /**
   * The preferences this panel should be shown.
   *
   * Always a complete `PanelPrefs`: the panel is never handed a partial and
   * left to work out what a missing key means.
   */
  for(panelId: string | null): PanelPrefs {
    const shared = this.#scopes.get(SHARED) ?? {};
    const own = (panelId && this.#scopes.get(panelId)) || {};
    return { ...DEFAULT_PREFS, ...shared, ...own };
  }

  /**
   * Notify that something changed, somewhere.
   *
   * Deliberately carries no payload. Which panels are affected depends on
   * which scope changed AND on which of them override the key, and working
   * that out here would duplicate the resolution above — the hub asks each
   * connected panel for its own answer instead, which cannot disagree with
   * what a panel would get on a fresh connection.
   */
  onChange(fn: () => void): void {
    this.#listeners.add(fn);
  }

  #announce(): void {
    for (const fn of this.#listeners) fn();
  }

  /** Write one preference into a scope and persist. */
  #apply(panelId: string | null, patch: Partial<PanelPrefs>): void {
    const scope = panelId ?? SHARED;
    this.#scopes.set(scope, { ...(this.#scopes.get(scope) ?? {}), ...patch });
    this.#save();
    this.#announce();
  }

  #load(): void {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#path, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      const file = raw as Record<string, unknown>;
      const version = Number(file['version'] ?? 1);

      /*
       * The file used to be one flat object of preferences, before panels
       * could be told apart. Read that shape as the shared block rather than
       * ignoring it: the alternative is that upgrading silently resets every
       * setting somebody had already chosen, on a wall panel, with no message
       * anywhere saying why.
       */
      const legacy = !('default' in file) && !('panels' in file);
      let migrated = false;

      if (legacy) {
        const { scope, changed } = readScope(file, version);
        this.#scopes.set(SHARED, scope);
        migrated = changed;
        log.info(`Loaded panel preferences from ${this.#path} (shared, pre-per-panel format)`);
      } else {
        const shared = readScope(file['default'], version);
        this.#scopes.set(SHARED, shared.scope);
        migrated = shared.changed;

        const panels = file['panels'];
        if (panels && typeof panels === 'object' && !Array.isArray(panels)) {
          for (const [name, value] of Object.entries(panels as Record<string, unknown>)) {
            const id = panelIdOf(name);
            // A key that is not a legal panel id can never be matched by a
            // connecting panel, so keeping it would just be a scope nothing
            // reads. Say so rather than dropping it silently — it is almost
            // certainly a typo in a URL somewhere.
            if (!id) {
              log.warn(`Ignoring "${name}" in ${this.#path}: not a valid panel id`);
              continue;
            }
            const { scope, changed } = readScope(value, version);
            this.#scopes.set(id, scope);
            migrated = migrated || changed;
          }
        }

        const named = [...this.#scopes.keys()].filter((k) => k !== SHARED);
        log.info(
          `Loaded panel preferences from ${this.#path}` +
            (named.length ? ` (shared, plus ${named.join(', ')})` : ''),
        );
      }

      // Either the schema-2 page migration fired, or the file is in the old
      // flat shape. Both are worth writing back once, so the next start has
      // nothing left to migrate.
      if (migrated || legacy) this.#save();
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
  set(key: string, value: unknown, panelId: string | null = null): string | null {
    // Compared against what this panel currently SEES, not against what its
    // own block holds: a panel inheriting the shared value has not asked for
    // anything to change by choosing the value it is already showing.
    const current = this.for(panelId);
    const who = panelId ?? 'all panels';

    if (key === 'visiblePages') {
      const visiblePages = sanitizeVisiblePages(value);
      if (!visiblePages) {
        return `Invalid visiblePages (expected only ${PANEL_PAGES.join(', ')})`;
      }
      if (sameStrings(current.visiblePages, visiblePages)) return null;

      this.#apply(panelId, { visiblePages });
      log.info(`Preference visiblePages = ${visiblePages.join(', ') || '(none)'} (${who})`);
      return null;
    }

    if ((BOOLEAN_PREFS as readonly string[]).includes(key)) {
      if (typeof value !== 'boolean') {
        return `"${value}" is not valid for ${key} (expected true or false)`;
      }
      if ((current as unknown as Record<string, unknown>)[key] === value) return null;

      this.#apply(panelId, { [key]: value } as Partial<PanelPrefs>);
      log.info(`Preference ${key} = ${value} (${who})`);
      return null;
    }

    const allowed = Object.prototype.hasOwnProperty.call(PREF_VALUES, key)
      ? (PREF_VALUES as Record<string, readonly string[]>)[key]
      : undefined;
    if (!allowed) return `Unknown preference "${key}"`;
    if (typeof value !== 'string' || !allowed.includes(value)) {
      return `"${value}" is not valid for ${key} (expected ${allowed.join(' or ')})`;
    }

    if ((current as unknown as Record<string, string>)[key] === value) return null;

    this.#apply(panelId, { [key]: value } as Partial<PanelPrefs>);
    log.info(`Preference ${key} = ${value} (${who})`);
    return null;
  }

  /**
   * Replace the player layout.
   *
   * `sections` is the list the config currently declares; a heading the
   * config does not know about is dropped, because it would render as an
   * empty group nobody could remove from the panel.
   */
  setLayout(
    raw: unknown,
    sections: readonly string[],
    panelId: string | null = null,
  ): string | null {
    const layout = sanitizeLayout(raw, sections);
    if (!layout) return 'Invalid layout';

    this.#apply(panelId, { players: layout });
    return null;
  }

  #save(): void {
    const panels: Record<string, Partial<PanelPrefs>> = {};
    for (const [id, scope] of this.#scopes) {
      if (id !== SHARED && Object.keys(scope).length > 0) panels[id] = scope;
    }
    const file = { version: PREFS_SCHEMA, default: this.#scopes.get(SHARED) ?? {}, panels };

    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      // Write-then-rename, so a container killed mid-write leaves the previous
      // file intact rather than a truncated one that fails to parse.
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.#path);
    } catch (err) {
      // A read-only or unwritable volume must not break the panel: the change
      // still applies in memory, it just will not survive a restart.
      log.warn(`Could not persist preferences to ${this.#path}:`, err);
    }
  }
}

/**
 * The preferences one scope sets, ignoring anything unusable.
 *
 * Validated on the way IN as well as on the way out. The file is
 * machine-written, but it sits in a user-mounted volume and a half-written or
 * hand-edited one must not take the panel down.
 *
 * `changed` reports that the schema-2 page migration rewrote this scope, so
 * the caller knows the file is worth saving back.
 */
function readScope(
  raw: unknown,
  version: number,
): { scope: Partial<PanelPrefs>; changed: boolean } {
  const scope: Partial<PanelPrefs> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { scope, changed: false };
  const stored = raw as Record<string, unknown>;
  let changed = false;

  for (const [key, allowed] of Object.entries(PREF_VALUES)) {
    const value = stored[key];
    if (typeof value === 'string' && allowed.includes(value)) {
      (scope as Record<string, unknown>)[key] = value;
    }
  }

  for (const key of BOOLEAN_PREFS) {
    if (typeof stored[key] === 'boolean') {
      (scope as Record<string, unknown>)[key] = stored[key];
    }
  }

  let visiblePages = sanitizeVisiblePages(stored['visiblePages']);
  if (visiblePages && version < PREFS_SCHEMA) {
    // Apple TV became a first-class page in schema 2. Existing panels
    // should see it once; later user choices are stored with version 2
    // and are respected, including deliberately hiding it.
    visiblePages = PANEL_PAGES.filter(
      (page) => page === 'apple-tv' || visiblePages!.includes(page),
    );
    changed = true;
  }
  if (visiblePages) scope.visiblePages = visiblePages;

  // The layout is shape-checked rather than enum-checked. Section names are
  // NOT validated here: the config may legitimately have changed since this
  // was written, and dropping a whole arrangement because a heading was
  // renamed would be worse than carrying a stale key the panel ignores.
  const layout = sanitizeLayout(stored['players'], null);
  if (layout) scope.players = layout;

  return { scope, changed };
}

function sanitizeVisiblePages(raw: unknown): PanelPage[] | null {
  if (!Array.isArray(raw) || raw.length > PANEL_PAGES.length) return null;
  if (raw.some((page) => typeof page !== 'string' || !PANEL_PAGES.includes(page as PanelPage))) {
    return null;
  }
  if (new Set(raw).size !== raw.length) return null;
  return PANEL_PAGES.filter((page) => raw.includes(page));
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
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
