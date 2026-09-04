import { logger } from '~/lib/log.ts';
import { discoverHost } from '~/sonos/discovery.ts';
import { soapCall, type SoapArgs, type SonosService } from '~/sonos/soap.ts';
import { EMPTY_HOUSEHOLD, parseZoneGroupState, type Household } from '~/sonos/topology.ts';
import { textOf } from '~/sonos/xml.ts';
import type { Env } from '~/env.ts';
import type { LinkState } from '@shared/protocol.ts';
import type { XmlNode } from '~/sonos/xml.ts';

const log = logger('sonos');

/**
 * Reachability, and the household it describes.
 *
 * The deliberate difference from `mass/client.ts` and `ha/client.ts`: there is
 * **no connection to manage**. Sonos control is stateless HTTP POSTs to port
 * 1400, so "connected" here means *we asked a speaker something recently and
 * it answered* — not that a socket is open. The only long-lived state in this
 * integration arrives in phase 2, when GENA event subscriptions do need
 * renewing and tearing down.
 *
 * What this class therefore owns is narrow and worth stating:
 *
 *  - **which address to talk to**, including failover when the seed speaker is
 *    unplugged. Every household member's IP comes back in the topology, so
 *    losing one is not losing the system.
 *  - **the household itself**, because "can we reach Sonos" and "what is the
 *    household" are the same fact learned from the same call. Splitting them
 *    would mean asking twice.
 *  - **a specific reason when it is down**, for the Settings screen. An
 *    unreachable speaker and a household that has never been found need
 *    different things done about them and read identically as "disconnected".
 */

export interface SonosClientEvents {
  onStateChange(state: LinkState): void;
}

/** How long a discovery sweep may take before we give up and report it. */
const DISCOVERY_TIMEOUT_MS = 3000;

export class SonosClient {
  readonly #env: Env['sonos'];
  readonly #events: SonosClientEvents;

  #state: LinkState = 'disconnected';
  #closed = false;
  #lastError: string | null = null;

  #household: Household = EMPTY_HOUSEHOLD;
  /** Addresses worth trying, best first. Seeded from env, grown by topology. */
  #candidates: string[] = [];

  /** In-flight refresh, so two callers cannot probe the household at once. */
  #refreshing: Promise<boolean> | null = null;

  constructor(env: Env['sonos'], events: SonosClientEvents) {
    this.#env = env;
    this.#events = events;
    if (env.host) this.#candidates = [env.host];
  }

  get state(): LinkState {
    return this.#state;
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  get enabled(): boolean {
    return this.#env.enabled;
  }

  get household(): Household {
    return this.#household;
  }

  /**
   * There is deliberately no timer here.
   *
   * Nothing to connect, so nothing to reconnect: `refresh()` is both the
   * liveness check and the way state is read, and the store owns when it runs.
   * One cadence in one place beats a retry loop here racing a poll there —
   * and it is why a household that goes away recovers on the next poll rather
   * than on a backoff curve nobody can see.
   */
  start(): void {
    if (!this.#env.enabled) {
      log.info('SONOS_HOST not set and SONOS_DISCOVERY off — Sonos client not started');
      return;
    }
    this.#closed = false;
  }

  stop(): void {
    this.#closed = true;
    this.#household = EMPTY_HOUSEHOLD;
    this.#setState('disconnected');
  }

  /** Run one SOAP action against a specific speaker. */
  call(host: string, service: SonosService, action: string, args?: SoapArgs): Promise<XmlNode> {
    return soapCall(host, service, action, args);
  }

  /**
   * Re-read the household.
   *
   * Also the liveness check: this is the call whose success defines
   * "connected". Returns whether it worked, so a caller that is about to fetch
   * per-player state can skip doing so against a system it cannot reach.
   */
  refresh(): Promise<boolean> {
    if (!this.#env.enabled || this.#closed) return Promise.resolve(false);
    // Collapse concurrent callers onto one request rather than letting the
    // poll and a backoff retry both hit the speaker.
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<boolean> {
    /*
     * 'connecting' is only honest before the first failure. Setting it on
     * every attempt would make a household that is genuinely down flap
     * disconnected → connecting → disconnected once per poll, broadcasting two
     * health frames every five seconds to say nothing has changed.
     */
    if (this.#state === 'disconnected' && this.#lastError === null) this.#setState('connecting');

    const hosts = await this.#hostsToTry();
    if (hosts.length === 0) {
      this.#fail(
        this.#env.host
          ? `SONOS_HOST is set to "${this.#env.host}" but it could not be reached.`
          : 'No speaker answered discovery on this network. Set SONOS_HOST to the ' +
              'IP address of one Sonos speaker.',
      );
      return false;
    }

    let lastProblem = '';
    for (const host of hosts) {
      try {
        const response = await this.call(host, 'ZoneGroupTopology', 'GetZoneGroupState');

        /*
         * The payload is escaped XML inside the SOAP response — `textOf`
         * decodes exactly one level, which is the level that gets it back to a
         * document. Decoding twice would turn a zone called "Ben & Jerry"
         * into malformed XML; decoding once too few leaves entity soup.
         */
        const inner = textOf(response, 'ZoneGroupState');
        if (!inner) {
          lastProblem = `${host} returned an empty topology`;
          continue;
        }

        const household = parseZoneGroupState(inner);
        if (household.zones.size === 0) {
          lastProblem = `${host} reported no visible zones`;
          continue;
        }

        this.#adopt(household, host);
        return true;
      } catch (err) {
        lastProblem = err instanceof Error ? err.message : String(err);
        log.debug(`Topology from ${host} failed: ${lastProblem}`);
      }
    }

    this.#fail(
      `Could not read the Sonos topology (${lastProblem}). If the address is right, ` +
        'check that UPnP is enabled in the Sonos app under Settings → App Preferences → Privacy.',
    );
    return false;
  }

  #adopt(household: Household, via: string): void {
    const first = this.#household.zones.size === 0;
    this.#household = household;

    /*
     * Reorder the candidate list so the speaker that just answered is tried
     * first next time, with the rest of the household behind it. This is what
     * makes unplugging the seed speaker a non-event: the next refresh walks
     * straight past it to one that is still there.
     */
    this.#candidates = [via, ...household.hosts.filter((h) => h !== via)];

    this.#lastError = null;
    this.#setState('connected');

    if (first) {
      const names = [...household.zones.values()].map((z) => z.name).join(', ');
      log.info(`Sonos household: ${household.zones.size} zones (${names})`);
    }
  }

  /** The seed, plus everything the last topology told us about. */
  async #hostsToTry(): Promise<string[]> {
    if (this.#candidates.length > 0) return this.#candidates;
    if (!this.#env.discovery) return [];

    const found = await discoverHost(DISCOVERY_TIMEOUT_MS);
    return found ? [found] : [];
  }

  #fail(message: string): void {
    // Recorded rather than only logged: an empty Media screen and an
    // unreachable household look identical on a wall, and the Settings screen
    // is the only place anyone can find out which one they have.
    const changed = this.#lastError !== message;
    this.#lastError = message;
    this.#household = EMPTY_HOUSEHOLD;

    if (changed) log.warn(message);
    this.#setState('disconnected');
  }

  #setState(next: LinkState): void {
    if (this.#state === next) return;
    this.#state = next;
    log.info(`Sonos link: ${next}`);
    this.#events.onStateChange(next);
  }
}
