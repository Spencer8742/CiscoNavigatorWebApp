/**
 * Just enough XML for Sonos.
 *
 * Sonos is XML the whole way down: SOAP envelopes, `ZoneGroupState`, DIDL-Lite
 * track metadata, and — from phase 2 — `LastChange` events, which are
 * XML-escaped XML containing escaped DIDL. Three levels of escaping, and a
 * parser that unescapes once produces plausible-looking nonsense rather than
 * an error. That failure profile is the reason this file exists at all rather
 * than being a few regexes at the call sites.
 *
 * ## Why not a dependency
 *
 * `docs/SONOS.md` §10 recommends `fast-xml-parser` and notes the decision is
 * reversible because it lives behind one interface. This is that interface,
 * and the hand-rolled side of the choice: the server has two runtime
 * dependencies and Sonos emits machine-generated XML with a fixed shape — no
 * namespaces we must resolve, no DTDs, no mixed content worth preserving.
 *
 * What actually needed care is **entity decoding**, which is where a
 * hand-rolled parser silently mangles an album called `Rock & Roll`. It is
 * ten lines and it is tested directly, both here and end-to-end through a
 * mock speaker that sends the nasty cases.
 *
 * Swapping this for a library later means reimplementing four exported
 * functions. Nothing else in `sonos/` knows how the parsing is done.
 */

export interface XmlNode {
  /** Tag name, prefix included: `u:GetVolumeResponse`, `dc:title`. */
  name: string;
  /** Attributes, values already entity-decoded. */
  attrs: Record<string, string>;
  children: XmlNode[];
  /** This element's own text, entity-decoded. Descendants' text is not here. */
  text: string;
}

/** The five XML entities. Sonos emits no others by name. */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const ENTITY_RE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g;

/**
 * Decode XML entities, exactly once.
 *
 * The "exactly once" is the whole point and it is what a naive
 * replace-in-a-loop gets wrong: `&amp;lt;` is an escaped `&lt;`, so it must
 * decode to the four characters `&lt;` and stop. A single `String.replace`
 * pass gives that for free — the scanner resumes after each match, so the `&`
 * it just produced is never re-examined.
 */
export function decodeEntities(raw: string): string {
  // The overwhelmingly common case in a library page is no entities at all.
  if (raw.indexOf('&') === -1) return raw;

  return raw.replace(ENTITY_RE, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (dec !== undefined) return codePoint(Number.parseInt(dec, 10), whole);
    if (hex !== undefined) return codePoint(Number.parseInt(hex, 16), whole);
    // An unknown named entity is left alone rather than dropped: whatever it
    // was, showing it is more honest than showing nothing.
    return (name !== undefined ? NAMED[name] : undefined) ?? whole;
  });
}

/** A numeric reference, or the original text when it does not name a character. */
function codePoint(n: number, whole: string): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return whole;
  // Lone surrogates are not characters; `fromCodePoint` accepts them and
  // produces a string that breaks anything that later re-encodes it.
  if (n >= 0xd800 && n <= 0xdfff) return whole;
  return String.fromCodePoint(n);
}

/** Escape a value for inclusion in an XML text node or attribute. */
export function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Parse a document and return its root element, or null.
 *
 * Deliberately tolerant: a stray closing tag is ignored and an unclosed
 * element is closed by the end of input. A speaker on a wall is not the place
 * to reject a document over a detail nothing downstream reads — every caller
 * here looks up named elements and copes with them being absent.
 */
export function parseXml(source: string): XmlNode | null {
  const doc: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [doc];
  const n = source.length;
  let i = 0;

  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt === -1) break;

    if (lt > i) {
      const top = stack[stack.length - 1];
      if (top) top.text += decodeEntities(source.slice(i, lt));
    }

    if (source.startsWith('<!--', lt)) {
      i = skipPast(source, '-->', lt + 4);
      continue;
    }

    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      const top = stack[stack.length - 1];
      // CDATA is literal by definition — decoding it would be wrong.
      if (top) top.text += source.slice(lt + 9, end === -1 ? n : end);
      i = end === -1 ? n : end + 3;
      continue;
    }

    // <?xml …?> and <!DOCTYPE …>: nothing here reads either.
    if (source.startsWith('<?', lt)) {
      i = skipPast(source, '?>', lt + 2);
      continue;
    }
    if (source.startsWith('<!', lt)) {
      i = skipPast(source, '>', lt + 2);
      continue;
    }

    if (source.startsWith('</', lt)) {
      const end = source.indexOf('>', lt + 2);
      if (end === -1) break;
      const name = source.slice(lt + 2, end).trim();
      // Unwind to the matching element. Searching rather than popping blindly
      // means one unbalanced tag cannot tear down the whole stack.
      for (let d = stack.length - 1; d > 0; d -= 1) {
        if (stack[d]?.name === name) {
          stack.length = d;
          break;
        }
      }
      i = end + 1;
      continue;
    }

    const end = findTagEnd(source, lt + 1);
    if (end === -1) break;

    let inner = source.slice(lt + 1, end);
    const selfClosing = inner.endsWith('/');
    if (selfClosing) inner = inner.slice(0, -1);

    const node = parseTag(inner);
    if (node) {
      stack[stack.length - 1]?.children.push(node);
      if (!selfClosing) stack.push(node);
    }
    i = end + 1;
  }

  return doc.children[0] ?? null;
}

function skipPast(source: string, terminator: string, from: number): number {
  const end = source.indexOf(terminator, from);
  return end === -1 ? source.length : end + terminator.length;
}

/**
 * Find the `>` that closes a start tag.
 *
 * Quote-aware, because an attribute may legitimately contain one — Sonos's
 * `ChannelMapSet` and DIDL `res` attributes both do — and `indexOf('>')`
 * would truncate the tag in exactly those cases.
 */
function findTagEnd(source: string, from: number): number {
  let quote = '';
  for (let i = from; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '>') return i;
  }
  return -1;
}

const ATTR_RE = /([^\s=/<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseTag(inner: string): XmlNode | null {
  const trimmed = inner.trim();
  if (trimmed.length === 0) return null;

  let k = 0;
  while (k < trimmed.length && !isSpace(trimmed[k])) k += 1;

  const name = trimmed.slice(0, k);
  if (name.length === 0) return null;

  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = k;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(trimmed)) !== null) {
    const key = m[1];
    if (key) attrs[key] = decodeEntities(m[2] ?? m[3] ?? '');
  }

  return { name, attrs, children: [], text: '' };
}

function isSpace(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

/* ── Lookups ─────────────────────────────────────────────────────────────
   All three ignore namespace prefixes: `dc:title` is found by `title`, and
   `u:GetVolumeResponse` by `GetVolumeResponse`. Sonos mixes prefixed and
   unprefixed forms for the same field across services and firmware versions,
   so matching on the local name is the thing that keeps working. */

function matches(node: XmlNode, name: string): boolean {
  if (node.name === name) return true;
  const colon = node.name.indexOf(':');
  return colon !== -1 && node.name.slice(colon + 1) === name;
}

/** The first descendant with this name, depth-first. */
export function find(node: XmlNode | null, name: string): XmlNode | null {
  if (!node) return null;
  for (const child of node.children) {
    if (matches(child, name)) return child;
    const deeper = find(child, name);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * Every descendant with this name.
 *
 * Does not descend into a match, so `findAll(groups, 'ZoneGroup')` returns the
 * groups themselves rather than also walking into each one looking for nested
 * ones that do not exist.
 */
export function findAll(node: XmlNode | null, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  if (!node) return out;
  const walk = (parent: XmlNode): void => {
    for (const child of parent.children) {
      if (matches(child, name)) out.push(child);
      else walk(child);
    }
  };
  walk(node);
  return out;
}

/** Trimmed text of the first descendant with this name, or null if empty. */
export function textOf(node: XmlNode | null, name: string): string | null {
  const found = find(node, name);
  if (!found) return null;
  const text = found.text.trim();
  return text.length > 0 ? text : null;
}
