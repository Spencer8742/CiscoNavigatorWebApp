import { logger } from '~/lib/log.ts';
import { CompanionClient } from '~/controls/companion.ts';
import { KeyLight } from '~/controls/keylight.ts';
import type { ControlAction, ControlItem, DashboardConfig, KeyLightOp } from '@shared/config.ts';
import type { EntityState, KeyLightState } from '@shared/protocol.ts';

const log = logger('controls');

/**
 * The macro pages: what a button press actually does.
 *
 * This is the replacement for `companion_bridge.js`, the RoomOS macro this
 * app's Controls screen exists to retire. That macro mapped Navigator widget
 * taps onto HTTP calls, and it lived *on the device* — so a factory reset
 * destroyed it along with the panel XML and the HttpClient config, with no
 * artefact to reapply. The device now holds a URL and this holds the map.
 *
 * The one rule worth stating plainly, because everything else follows from
 * it: **the panel names a button, never a request.** It sends `deskpro.join`
 * and this resolves that against the config it already has. A panel is a
 * screen on a wall that anyone in the room can touch; it is trusted to drive
 * the dashboard, not to compose arbitrary HTTP requests to things on the LAN.
 * The Home Assistant side has always worked this way (ha/services.ts) and
 * there is no reason for Companion or a key light to be looser.
 *
 * Failures are reported, never retried. Every action here is a transport
 * command — hang up, mute, lights off — and a duplicate arriving a second
 * later because the first response was slow is worse than nothing arriving.
 */

export interface ControlsDeps {
  getConfig: () => DashboardConfig;
  /** Companion base URL, or '' when it is not configured. */
  companionUrl: string;
  /** Home Assistant base URL, for webhooks. '' disables them. */
  haUrl: string;
  /** The ServiceGuard, so `entity:` buttons obey the same allow-list as tiles. */
  callService: (call: {
    domain: string;
    service: string;
    entity: string;
    data?: Record<string, unknown>;
  }) => Promise<string | null>;
  /** One entity's current state, for validating a chosen input. */
  getEntity: (entityId: string) => EntityState | null;
  /** Called whenever any key light's state changes. */
  onLights: (lights: KeyLightState[]) => void;
  /** Whether any panel is connected. Polling is pointless when none is. */
  hasPanels: () => boolean;
}

/** A webhook is unauthenticated and idempotent-ish; still, do not hang on it. */
const WEBHOOK_TIMEOUT_MS = 5000;

export class Controls {
  readonly #deps: ControlsDeps;
  readonly #companion: CompanionClient;
  /** Live key lights, by config id. Rebuilt on every config change. */
  #lights = new Map<string, KeyLight>();
  #poll: ReturnType<typeof setInterval> | undefined;
  /** The interval currently armed, so a config edit only re-arms on a change. */
  #pollSeconds = 0;

  constructor(deps: ControlsDeps) {
    this.#deps = deps;
    this.#companion = new CompanionClient(deps.companionUrl);
    this.reload();
  }

  /* ── Configuration ─────────────────────────────────────────────────────*/

  /**
   * Rebuild from the current config.
   *
   * A light whose id AND address are unchanged keeps its existing instance,
   * so editing an unrelated part of dashboard.yaml does not blank every
   * light's state and make the screen flicker through "unreachable" on its
   * way back to where it was.
   */
  reload(): void {
    const cfg = this.#deps.getConfig().controls;
    const next = new Map<string, KeyLight>();

    let changed = cfg.keylights.length !== this.#lights.size;

    for (const light of cfg.keylights) {
      const existing = this.#lights.get(light.id);
      if (existing?.matches(light)) {
        if (existing.name !== light.name) {
          existing.name = light.name;
          changed = true;
        }
        next.set(light.id, existing);
      } else {
        next.set(light.id, new KeyLight(light));
        changed = true;
      }
    }

    this.#lights = next;

    this.#arm(cfg.pollSeconds);
    // Only a change to the LIST — a light added, removed or renamed — is
    // worth a push from here. Each light's own state is pushed by the poll,
    // so broadcasting on every unrelated config edit would be noise.
    if (changed) this.#publish();
    if (next.size > 0) void this.#refreshAll();
  }

  /** Every light's current state, for `hello`. */
  snapshot(): KeyLightState[] {
    return [...this.#lights.values()].map((l) => l.state);
  }

  stop(): void {
    clearInterval(this.#poll);
    this.#poll = undefined;
  }

  /* ── Running a button ──────────────────────────────────────────────────*/

  /**
   * Run the button with this id. Resolves to an error for the panel, or null.
   *
   * An unknown id is refused rather than ignored: it means the panel is
   * showing a page the backend no longer has, which the person tapping it
   * should be told about rather than left to tap harder.
   */
  async press(buttonId: string): Promise<string | null> {
    const item = this.#find(buttonId);
    if (!item) {
      log.warn(`Refused control "${buttonId}": not in dashboard.yaml`);
      return 'Unknown button';
    }
    if (item.type !== 'button') return 'Not a button';
    return this.#run(item.action, item.name);
  }

  /**
   * Choose an input on a `sources:` key.
   *
   * The entity comes from the config, never from the panel. The VALUE is
   * checked against the device's own `source_list` where it has published
   * one — a panel should not be able to push an arbitrary string at a TV,
   * and "HDMI 2" is only meaningful because the device said so.
   *
   * When the device has published no list, the value is forwarded anyway: an
   * empty source_list is normal while a TV is off, and refusing then would
   * make the control stop working exactly when it looks most broken.
   */
  async selectSource(itemId: string, value: string): Promise<string | null> {
    const item = this.#find(itemId);
    if (!item || item.type !== 'sources') {
      log.warn(`Refused source "${itemId}": not a sources key in dashboard.yaml`);
      return 'Unknown control';
    }

    const state = this.#deps.getEntity(item.entity);
    const list = state?.a['source_list'];
    if (Array.isArray(list) && list.length > 0 && !list.includes(value)) {
      log.warn(`Refused source "${value}" for ${item.entity}: not in its source_list`);
      return 'Unknown input';
    }

    return this.#deps.callService({
      domain: 'media_player',
      service: 'select_source',
      entity: item.entity,
      data: { source: value },
    });
  }

  async #run(action: ControlAction, label: string): Promise<string | null> {
    switch (action.kind) {
      case 'companion':
        return this.#companion.press(action.page, action.row, action.column);

      case 'webhook':
        return this.#webhook(action.id);

      case 'keylight':
        return this.keyLight(action.light, action.op, action.value);

      case 'entity': {
        const domain = action.entity.slice(0, action.entity.indexOf('.'));
        log.debug(`${label}: ${domain}.${action.service} ${action.entity}`);
        return this.#deps.callService({
          domain,
          service: action.service,
          entity: action.entity,
          ...(action.data ? { data: action.data } : {}),
        });
      }
    }
  }

  async #webhook(id: string): Promise<string | null> {
    const base = this.#deps.haUrl;
    if (!base) return 'Home Assistant is not configured';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    try {
      const res = await fetch(`${base}/api/webhook/${id}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });

      /*
       * Home Assistant answers 200 for a webhook that fired AND for one that
       * does not exist — deliberately, so a webhook id cannot be probed. So
       * a success here means "delivered", not "something happened", and a
       * button that appears to do nothing is a missing automation rather
       * than a broken panel. Worth knowing before debugging the wrong end.
       */
      if (!res.ok) {
        log.warn(`Webhook ${id} returned ${res.status}`);
        return `Webhook returned ${res.status}`;
      }
      log.debug(`Fired webhook ${id}`);
      return null;
    } catch (err) {
      log.warn(`Webhook ${id} failed: ${err instanceof Error ? err.message : err}`);
      return 'Home Assistant unreachable';
    } finally {
      clearTimeout(timer);
    }
  }

  /* ── Key lights ────────────────────────────────────────────────────────*/

  /**
   * Drive one key light, or every one at once with `all`.
   *
   * `all` is not a loop the panel writes: two lights either side of a desk
   * are one control, and making the panel send two commands would let them
   * disagree if one failed. A toggle on `all` decides its direction ONCE,
   * from whether any light is currently on, so a pair that has drifted out of
   * sync converges instead of swapping.
   */
  async keyLight(light: string, op: KeyLightOp, value?: number): Promise<string | null> {
    const targets =
      light === 'all' ? [...this.#lights.values()] : [this.#lights.get(light)].filter(isLight);

    if (targets.length === 0) {
      log.warn(`Refused key light "${light}": not in dashboard.yaml`);
      return light === 'all' ? 'No key lights configured' : 'Unknown light';
    }

    const patch =
      op === 'toggle'
        ? { on: !targets.some((l) => l.isOn) }
        : op === 'on'
          ? { on: true }
          : op === 'off'
            ? { on: false }
            : op === 'brightness'
              ? // Setting brightness on a light that is off should turn it on;
                // otherwise the slider moves and the room stays dark.
                { brightness: value ?? 0, on: (value ?? 0) > 0 }
              : { temperature: value ?? 4500 };

    const results = await Promise.all(targets.map((l) => l.apply(patch)));
    if (results.some(Boolean)) this.#publish();

    // Reachability is the honest failure signal: `apply` returning false only
    // means nothing changed, which is also true of setting a light to what it
    // already was.
    return targets.every((l) => !l.state.reachable) ? 'Light unreachable' : null;
  }

  /* ── Polling ───────────────────────────────────────────────────────────*/

  /**
   * Elgato lights push nothing, so a light switched off at the light itself
   * is invisible until we ask. This is only about noticing changes made
   * elsewhere — the panel's own commands adopt the response they get back —
   * which is why it can be this slow, and why it stops when nobody is
   * looking.
   */
  #arm(seconds: number): void {
    if (seconds === this.#pollSeconds && this.#poll) return;
    clearInterval(this.#poll);
    this.#poll = undefined;
    this.#pollSeconds = seconds;
    if (seconds <= 0) return;

    this.#poll = setInterval(() => {
      if (!this.#deps.hasPanels()) return;
      void this.#refreshAll();
    }, seconds * 1000);
    this.#poll.unref();
  }

  async #refreshAll(): Promise<void> {
    if (this.#lights.size === 0) return;
    const results = await Promise.all([...this.#lights.values()].map((l) => l.read()));
    if (results.some(Boolean)) this.#publish();
  }

  #publish(): void {
    this.#deps.onLights(this.snapshot());
  }

  #find(id: string): ControlItem | null {
    for (const page of this.#deps.getConfig().controls.pages) {
      for (const item of page.items) if (item.id === id) return item;
    }
    return null;
  }
}

function isLight(l: KeyLight | undefined): l is KeyLight {
  return l !== undefined;
}
