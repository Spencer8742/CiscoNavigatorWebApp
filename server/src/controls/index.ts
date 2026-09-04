import { logger } from '~/lib/log.ts';
import { CompanionClient } from '~/controls/companion.ts';
import { KeyLight } from '~/controls/keylight.ts';
import { WebosClient } from '~/tv/webos.ts';
import type { ControlAction, ControlItem, DashboardConfig, KeyLightOp } from '@shared/config.ts';
import type { EntityState, KeyLightState, TvState } from '@shared/protocol.ts';

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
  /** Called whenever a television's input changes. */
  onTvs: (tvs: TvState[]) => void;
  /** Whether any panel is connected. Polling is pointless when none is. */
  hasPanels: () => boolean;
  /**
   * Where webOS pairing keys are kept.
   *
   * On disk rather than in memory because pairing is a physical act: someone
   * has to accept a prompt on the television with the remote. A key lost on
   * restart means that prompt appears again, on a screen in a meeting room.
   */
  tvKeyFile: string;
}

/** A webhook is unauthenticated and idempotent-ish; still, do not hang on it. */
const WEBHOOK_TIMEOUT_MS = 5000;

export class Controls {
  readonly #deps: ControlsDeps;
  readonly #companion: CompanionClient;
  /** Live key lights, by config id. Rebuilt on every config change. */
  #lights = new Map<string, KeyLight>();
  #tvs = new Map<string, WebosClient>();
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

    /*
     * Televisions are rebuilt only when their address changes.
     *
     * A WebosClient holds the pairing key it loaded and, usually, an open
     * socket. Replacing one on an unrelated config edit would drop that
     * socket and re-read the key file for no reason — and on a set that has
     * never been paired, reconnecting is what puts a prompt back on screen.
     */
    const nextTvs = new Map<string, WebosClient>();
    for (const tv of cfg.tvs) {
      const existing = this.#tvs.get(tv.id);
      if (existing && existing.host === tv.host) {
        nextTvs.set(tv.id, existing);
        continue;
      }
      void existing?.stop();
      const client = new WebosClient({
        host: tv.host,
        ...(tv.mac ? { mac: tv.mac } : {}),
        ...(tv.broadcast ? { broadcast: tv.broadcast } : {}),
        keyFile: this.#deps.tvKeyFile,
      });
      // Pushed rather than polled: the TV tells us when the input changes,
      // including when somebody uses its own remote.
      client.onInputChange(() => this.#deps.onTvs(this.tvSnapshot()));
      nextTvs.set(tv.id, client);
    }
    for (const [id, client] of this.#tvs) {
      if (!nextTvs.has(id)) void client.stop();
    }
    this.#tvs = nextTvs;

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

  /** Every television's current state, for `hello`. */
  tvSnapshot(): TvState[] {
    return [...this.#tvs.entries()].map(([id, tv]) => ({ id, input: tv.currentInput ?? null }));
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
    return this.#runAll(item.actions, item.name);
  }

  /* ── Televisions ───────────────────────────────────────────────────────*/

  /**
   * Power a TV in `controls.tvs`.
   *
   * `toggle` asks whether the set answers and does the opposite. That costs a
   * connection attempt before acting, which is slower than firing blind — but
   * webOS has no toggle of its own, and guessing wrong here means turning off
   * a television somebody is watching.
   */
  /** Any TV operation from a key's action list. */
  async #tvAction(
    tvId: string,
    op: 'on' | 'off' | 'toggle' | 'input' | 'next',
    input?: string,
  ): Promise<string | null> {
    if (op === 'input') {
      if (!input) return 'No input named';
      return this.#tvSwitch(tvId, input);
    }
    if (op === 'next') return this.#tvNext(tvId);
    return this.#tvPower(tvId, op);
  }

  /**
   * Move to the next configured input, wrapping.
   *
   * Where the TV is on an input we know, this steps past it. Where it is off,
   * showing an app, or simply not answering, it goes to the FIRST configured
   * input rather than guessing — which is what somebody pressing the key in
   * that state almost certainly wants.
   */
  async #tvNext(tvId: string): Promise<string | null> {
    const cfg = this.#deps.getConfig().controls.tvs.find((t) => t.id === tvId);
    const tv = this.#tvs.get(tvId);
    if (!cfg || !tv) return 'Unknown TV';
    if (cfg.inputs.length === 0) return 'No inputs configured for this TV';

    // What the TV says, or what we last asked for. See WebosClient.cycleAnchor:
    // the label may only claim what the set confirmed, but a cycle just has to
    // keep moving — and a set whose input we cannot read would otherwise make
    // every press restart at the first one.
    const current = tv.cycleAnchor;
    const at = current ? cfg.inputs.findIndex((i) => i.source === current) : -1;
    const next = cfg.inputs[(at + 1) % cfg.inputs.length];
    if (!next) return 'No inputs configured for this TV';

    return tv.switchInput(next.source);
  }

  /** Switch to one named input, checked against what the config offers. */
  async #tvSwitch(tvId: string, input: string): Promise<string | null> {
    const cfg = this.#deps.getConfig().controls.tvs.find((t) => t.id === tvId);
    const tv = this.#tvs.get(tvId);
    if (!cfg || !tv) return 'Unknown TV';
    if (cfg.inputs.length > 0 && !cfg.inputs.some((i) => i.source === input)) {
      log.warn(`Refused input "${input}" for ${tvId}: not one it offers`);
      return 'Not an input this TV offers';
    }
    return tv.switchInput(input);
  }

  async #tvPower(tvId: string, action: 'toggle' | 'on' | 'off'): Promise<string | null> {
    const tv = this.#tvs.get(tvId);
    if (!tv) {
      log.warn(`Refused TV "${tvId}": not in controls.tvs`);
      return 'Unknown TV';
    }

    let want = action;
    if (action === 'toggle') want = (await tv.isOn()) ? 'off' : 'on';

    log.debug(`TV ${tvId}: ${want}`);
    return want === 'on' ? tv.turnOn() : tv.turnOff();
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

    /*
     * A curated `inputs:` list is the allow-list, and a better one than the
     * device's: it is written down, so it holds while the TV is off and
     * source_list is empty. Only when nothing is curated do we fall back to
     * what the device reports.
     */
    if (item.inputs.length > 0) {
      if (!item.inputs.some((i) => i.source === value)) {
        log.warn(`Refused source "${value}" for ${item.entity}: not in its configured inputs`);
        return 'Unknown input';
      }
    } else {
      const list = this.#deps.getEntity(item.entity)?.a['source_list'];
      if (Array.isArray(list) && list.length > 0 && !list.includes(value)) {
        log.warn(`Refused source "${value}" for ${item.entity}: not in its source_list`);
        return 'Unknown input';
      }
    }

    return this.#deps.callService({
      domain: 'media_player',
      service: 'select_source',
      entity: item.entity,
      data: { source: value },
    });
  }

  /**
   * Run a key's actions in order, stopping at the first failure.
   *
   * Stopping matters: "power the office on" is a Companion macro AND a
   * television, and carrying on after the macro failed would leave the room
   * half-started while the panel reported only the last thing that happened.
   */
  async #runAll(actions: ControlAction[], label: string): Promise<string | null> {
    for (const action of actions) {
      const problem = await this.#run(action, label);
      if (problem) return problem;
    }
    return null;
  }

  async #run(action: ControlAction, label: string): Promise<string | null> {
    switch (action.kind) {
      case 'companion':
        return this.#companion.press(action.page, action.row, action.column);

      case 'webhook':
        return this.#webhook(action.id);

      case 'keylight':
        return this.keyLight(action.light, action.op, action.value);

      case 'tv':
        return this.#tvAction(action.tv, action.op, action.input);

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
      for (const item of page.items) {
        if (item.id === id) return item;
        // A device tile's own keys are real controls the panel can press, so
        // they have to be resolvable here too. Without this they parse, they
        // render, and every tap is refused as "not in dashboard.yaml".
        if (item.type === 'device') {
          for (const key of item.keys) if (key.id === id) return key;
        }
      }
    }
    return null;
  }
}

function isLight(l: KeyLight | undefined): l is KeyLight {
  return l !== undefined;
}
