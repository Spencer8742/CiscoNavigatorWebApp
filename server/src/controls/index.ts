import { logger } from '~/lib/log.ts';
import { KeyLight } from '~/controls/keylight.ts';
import { WebosClient } from '~/tv/webos.ts';
import { RoomosClient } from '~/roomos/xapi.ts';
import { SshRunner } from '~/ssh/runner.ts';
import type {
  AppleTvKeyOp,
  ControlAction,
  ControlItem,
  DashboardConfig,
  KeyLightOp,
} from '@shared/config.ts';
import type { EntityState, KeyLightState, RoomosState, TvState } from '@shared/protocol.ts';

const log = logger('controls');

/**
 * The macro pages: what a button press actually does.
 *
 * This is the replacement for `companion_bridge.js`, the RoomOS macro this
 * app's Controls screen exists to retire — and, since, for Bitfocus Companion
 * itself: every step now goes straight to the device it drives. That macro mapped Navigator widget
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
 * there is no reason for an xCommand, an SSH command or a key light to be
 * looser.
 *
 * Failures are reported, never retried. Every action here is a transport
 * command — hang up, mute, lights off — and a duplicate arriving a second
 * later because the first response was slow is worse than nothing arriving.
 */

export interface ControlsDeps {
  getConfig: () => DashboardConfig;
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
  /** Called whenever a RoomOS device's presentation or reachability changes. */
  onRoomos: (devices: RoomosState[]) => void;
  /**
   * The xAPI password for one `controls.roomos` device, from the environment.
   * Never in dashboard.yaml: that file is sent to every panel.
   */
  roomosPassword: (id: string) => string;
  /** An Apple TV command, through the same bridge its remote uses. */
  appleTvCommand: (device: string, op: AppleTvKeyOp) => Promise<string | null>;
  /**
   * The credential for one `controls.ssh` host, from the environment. Read
   * at press time, so a key file mounted after start-up is picked up.
   */
  sshCredential: (id: string) => Promise<{ privateKey?: string; password?: string }>;
  /** Where SSH host keys are pinned. Beside the config, like tv-keys.json. */
  sshKnownHostsFile: string;
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
  readonly #ssh: SshRunner;
  /** Live key lights, by config id. Rebuilt on every config change. */
  #lights = new Map<string, KeyLight>();
  #tvs = new Map<string, WebosClient>();
  #roomos = new Map<string, RoomosClient>();
  #poll: ReturnType<typeof setInterval> | undefined;
  /** The interval currently armed, so a config edit only re-arms on a change. */
  #pollSeconds = 0;

  constructor(deps: ControlsDeps) {
    this.#deps = deps;
    this.#ssh = new SshRunner(deps.sshKnownHostsFile);
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

    /*
     * RoomOS devices, held open permanently.
     *
     * Not polled and not gated on a panel being connected, unlike the lights:
     * the device pushes every change down one socket that costs nothing while
     * idle, and a panel that connects should find the key already right
     * rather than wait for a first read.
     */
    const nextRoomos = new Map<string, RoomosClient>();
    for (const dev of cfg.roomos) {
      const opts = {
        id: dev.id,
        host: dev.host,
        username: dev.username,
        password: this.#deps.roomosPassword(dev.id),
      };
      const existing = this.#roomos.get(dev.id);
      if (existing?.matches(opts)) {
        nextRoomos.set(dev.id, existing);
        continue;
      }
      existing?.stop();
      if (!opts.password) {
        log.warn(
          `controls.roomos "${dev.id}": no password — set ROOMOS_PASSWORD ` +
            `(or ROOMOS_PASSWORD_${dev.id.toUpperCase()}) in .env`,
        );
      }
      const client = new RoomosClient(opts);
      client.onChange(() => this.#deps.onRoomos(this.roomosSnapshot()));
      client.start();
      nextRoomos.set(dev.id, client);
    }
    for (const [id, client] of this.#roomos) {
      if (!nextRoomos.has(id)) client.stop();
    }
    const roomosChanged =
      nextRoomos.size !== this.#roomos.size ||
      [...nextRoomos].some(([id, c]) => this.#roomos.get(id) !== c);
    this.#roomos = nextRoomos;
    if (roomosChanged) this.#deps.onRoomos(this.roomosSnapshot());

    this.#arm(cfg.pollSeconds);
    // Only a change to the LIST — a light added, removed or renamed — is
    // worth a push from here. Each light's own state is pushed by the poll,
    // so broadcasting on every unrelated config edit would be noise.
    if (changed) this.#publish();
    if (next.size > 0 || this.#tvs.size > 0) void this.#refreshAll();
  }

  /** Every light's current state, for `hello`. */
  snapshot(): KeyLightState[] {
    return [...this.#lights.values()].map((l) => l.state);
  }

  /** Every television's current state, for `hello`. */
  tvSnapshot(): TvState[] {
    return [...this.#tvs.entries()].map(([id, tv]) => {
      const confirmed = tv.currentInput;
      return {
        id,
        input: confirmed ?? tv.assumedInput ?? null,
        confirmed: confirmed !== undefined,
      };
    });
  }

  /** Every RoomOS device's presentation, for `hello`. */
  roomosSnapshot(): RoomosState[] {
    return [...this.#roomos.values()].map((d) => d.state);
  }

  stop(): void {
    clearInterval(this.#poll);
    this.#poll = undefined;
    for (const d of this.#roomos.values()) d.stop();
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

  /* ── RoomOS presentation ───────────────────────────────────────────────*/

  async #roomosAction(
    deviceId: string,
    op: 'next' | 'input' | 'stop',
    connector?: number,
  ): Promise<string | null> {
    const cfg = this.#deps.getConfig().controls.roomos.find((d) => d.id === deviceId);
    const dev = this.#roomos.get(deviceId);
    if (!cfg || !dev) {
      log.warn(`Refused RoomOS "${deviceId}": not in controls.roomos`);
      return 'Unknown device';
    }
    if (!dev.state.reachable) return `${cfg.name} is not reachable`;

    if (op === 'stop') return dev.stopPresenting();
    if (op === 'input') {
      if (connector === undefined) return 'No connector named';
      return dev.present(connector);
    }

    /*
     * Step to the next input AFTER the one the device says it is presenting.
     *
     * The anchor is the device's own answer, never the last input this key
     * chose: that is the whole difference from the Companion key this
     * replaces, which counted its own presses and so fell out of step the
     * first time anybody plugged a laptop in.
     *
     * An input the device reports as unplugged is skipped, so a press never
     * lands on a black screen while the other input has a laptop on it. When
     * every other input is empty the press stays where it is; when nothing is
     * presented at all it starts on the next input regardless — the device
     * can say "no signal" on its own screen better than a key can.
     */
    const inputs =
      cfg.inputs.length > 0
        ? cfg.inputs.map((i) => i.connector)
        : dev.inputConnectors.map((c) => c.id);
    if (inputs.length === 0) return 'No inputs to switch between';

    const plugged = new Map(dev.inputConnectors.map((c) => [c.id, c.connected]));
    const current = dev.connector;
    const at = current === null ? -1 : inputs.indexOf(current);
    let next: number | undefined;
    for (let step = 1; step <= inputs.length; step++) {
      const candidate = inputs[(at + step) % inputs.length]!;
      if (candidate === current) continue;
      if (plugged.get(candidate) !== false) {
        next = candidate;
        break;
      }
    }
    if (next === undefined) {
      if (current !== null) return null;
      next = inputs[(at + 1) % inputs.length]!;
    }
    return dev.present(next);
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
   * Run a key's actions in order — all of them — and report the first failure.
   *
   * Carrying on is deliberate. "Shut Down Office" is a Desk Pro, the lights,
   * an Apple TV, a Mac and a television, and a Desk Pro that happens not to
   * answer should not leave the lights on. The step that failed is still what
   * the key reports, and a key with more than one failure says how many, so
   * a partly-started room does not read as a clean press.
   */
  async #runAll(actions: ControlAction[], label: string): Promise<string | null> {
    const problems: string[] = [];
    for (const action of actions) {
      let problem: string | null;
      try {
        problem = await this.#run(action, label);
      } catch (err) {
        problem = err instanceof Error ? err.message : String(err);
      }
      if (problem) {
        log.warn(`${label}: step ${action.kind} failed: ${problem}`);
        problems.push(problem);
      }
    }
    if (problems.length === 0) return null;
    return problems.length === 1 ? problems[0]! : `${problems[0]} (+${problems.length - 1} more)`;
  }

  async #run(action: ControlAction, label: string): Promise<string | null> {
    switch (action.kind) {
      case 'webhook':
        return this.#webhook(action.id);

      case 'keylight':
        return this.keyLight(action.light, action.op, action.value);

      case 'tv':
        return this.#tvAction(action.tv, action.op, action.input);

      case 'roomos':
        return this.#roomosAction(action.device, action.op, action.connector);

      case 'xcommand': {
        const dev = this.#roomos.get(action.device);
        if (!dev) {
          log.warn(`Refused RoomOS "${action.device}": not in controls.roomos`);
          return 'Unknown device';
        }
        return dev.xcommand(action.command, action.params);
      }

      case 'ssh': {
        const cfg = this.#deps.getConfig().controls.ssh.find((h) => h.id === action.host);
        if (!cfg) {
          log.warn(`Refused SSH host "${action.host}": not in controls.ssh`);
          return 'Unknown host';
        }
        const credential = await this.#deps.sshCredential(cfg.id);
        return this.#ssh.run({ ...cfg, ...credential }, action.run);
      }

      case 'appletv':
        return this.#deps.appleTvCommand(action.device, action.op);

      case 'wait':
        await new Promise((resolve) => setTimeout(resolve, action.seconds * 1000));
        return null;

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
    /*
     * Televisions first, and independently of the lights: a set that is on
     * should be connected whether or not this room has any key lights in it.
     *
     * Connecting is what subscribes to the foreground app, so this is also
     * what puts the current input on the panel BEFORE anybody presses the
     * key — and what picks the change up when somebody switches input with
     * the TV's own remote. WebosClient.ensureConnected does nothing to a set
     * that is already connected, and nothing at all to one that has never
     * been paired.
     */
    await Promise.all([...this.#tvs.values()].map((tv) => tv.ensureConnected()));

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
