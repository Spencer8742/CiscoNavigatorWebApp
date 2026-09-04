import { findAll, parseXml, type XmlNode } from '~/sonos/xml.ts';

/**
 * The household: every zone, which group it is in, and who coordinates it.
 *
 * One call to `ZoneGroupTopology.GetZoneGroupState` on **any single speaker**
 * describes the whole system. That is why `SONOS_HOST` never needs to be more
 * than one address, and why losing one speaker does not lose the household —
 * every other member's IP is in the answer.
 *
 * ## The two things that must be filtered
 *
 * A `ZoneGroupMember` is not the same thing as a speaker somebody points at.
 * The right channel of a stereo pair, a bonded subwoofer and home-theatre
 * surrounds are all real members, and all carry `Invisible="1"`. Showing them
 * puts "Living Room (R)" and "Sub" in the player picker — the exact bug
 * `mass/store.ts` avoids with its `HIDDEN_TYPES` set.
 *
 * Satellites are worse, because they are nested *inside* the member they are
 * bonded to rather than sitting beside it. They are `<Satellite>` elements, so
 * looking for `ZoneGroupMember` by name skips them for free.
 */

export interface SonosZone {
  /** `RINCON_…`, stable across reboots and renames. */
  uuid: string;
  name: string;
  /** The speaker's own address — where its SOAP and event endpoints live. */
  host: string;
  /** 'stereo_pair' when two speakers are bonded L/R, else 'player'. */
  kind: 'player' | 'stereo_pair';
  /** UUID of the group's coordinator. Equal to `uuid` when this zone leads. */
  coordinator: string;
  /** Every VISIBLE zone playing in sync with this one, coordinator first. */
  group: string[];
}

export interface Household {
  /** Visible zones only, keyed by UUID. */
  zones: Map<string, SonosZone>;
  /**
   * Every member address we saw, visible or not.
   *
   * Kept for failover: any of them can answer `GetZoneGroupState`, so the
   * household survives the seed speaker being unplugged.
   */
  hosts: string[];
}

export const EMPTY_HOUSEHOLD: Household = { zones: new Map(), hosts: [] };

/**
 * Parse the `ZoneGroupState` payload.
 *
 * The argument is the *inner* document — `GetZoneGroupState` returns it
 * escaped inside the SOAP response, so the caller decodes one level first.
 * Newer firmware wraps the groups in a second `<ZoneGroupState>` alongside
 * `<VanishedDevices>`; older firmware does not. Searching for `ZoneGroup`
 * rather than walking a fixed path handles both without a version check.
 */
export function parseZoneGroupState(xml: string): Household {
  const root = parseXml(xml);
  const zones = new Map<string, SonosZone>();
  const hosts: string[] = [];
  const seenHosts = new Set<string>();

  for (const group of findAll(root, 'ZoneGroup')) {
    const coordinator = group.attrs['Coordinator'] ?? '';
    const members = findAll(group, 'ZoneGroupMember');

    const visible: SonosZone[] = [];
    for (const member of members) {
      const host = hostOf(member.attrs['Location']);
      if (host && !seenHosts.has(host)) {
        seenHosts.add(host);
        hosts.push(host);
      }

      const zone = describe(member, coordinator, host);
      if (zone) visible.push(zone);
    }

    if (visible.length === 0) continue;

    /*
     * Coordinator first, so `describeGroup` on the panel reads "Living Room +
     * Kitchen" rather than whichever order the speaker happened to answer in.
     * A group whose coordinator is invisible cannot happen — Sonos never
     * elects a bonded satellite — but ordering by a missing id would silently
     * shuffle the list, so it is written as a sort rather than an assumption.
     */
    const ids = visible
      .map((z) => z.uuid)
      .sort((a, b) => Number(b === coordinator) - Number(a === coordinator));

    for (const zone of visible) {
      zone.group = ids;
      zones.set(zone.uuid, zone);
    }
  }

  return { zones, hosts };
}

function describe(member: XmlNode, coordinator: string, host: string | null): SonosZone | null {
  // `Invisible="1"` is the user's own system telling us this is not a speaker
  // anyone points at: a bonded sub, a surround, the right half of a pair.
  if (member.attrs['Invisible'] === '1') return null;

  const uuid = member.attrs['UUID'];
  const name = member.attrs['ZoneName'];
  if (!uuid || !name || !host) return null;

  // A non-empty ChannelMapSet means two speakers are bonded as one zone. They
  // present as a single player and are controlled as one, so this is a label
  // rather than a behaviour — but it is the label the panel already draws
  // differently, so it is worth getting right.
  const paired = (member.attrs['ChannelMapSet'] ?? '').length > 0;

  return {
    uuid,
    name,
    host,
    kind: paired ? 'stereo_pair' : 'player',
    coordinator: coordinator || uuid,
    group: [],
  };
}

/**
 * `http://192.168.1.51:1400/xml/device_description.xml` → `192.168.1.51:1400`.
 *
 * The **port is kept**. It is always 1400 on real hardware, so this looks
 * redundant — but taking the speaker's own word for where it listens is both
 * more honest than assuming and what lets the test suite run a household of
 * mock speakers on ordinary ports.
 *
 * Parsed rather than sliced: `url.host` brackets IPv6 literals, which a manual
 * split on `:` mangles.
 */
function hostOf(location: string | undefined): string | null {
  if (!location) return null;
  try {
    const { host } = new URL(location);
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}
