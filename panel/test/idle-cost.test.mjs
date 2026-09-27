import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * What the panel costs while nobody is touching it.
 *
 * A wall panel spends almost all of its life on the screensaver, so anything
 * that runs continuously there runs continuously, full stop. The failure is
 * not a crash: the renderer simply never reaches idle, and every touch after
 * that competes with work that was already saturating the CPU the device
 * grudgingly lends the web engine (docs/ROOMOS.md §2).
 *
 * This bit us for real. Logs pulled from a Room Navigator on ce26.7.1.12
 * showed `QtWebEngineProcess` holding ~58% of a core for a 21-hour uptime —
 * flat, not climbing, and with resident memory steady at 157 MB, so not a
 * leak. Two `infinite alternate` keyframe animations on the screensaver were
 * producing a composited frame every vsync for as long as the panel was up.
 * "Composited" makes a frame cheap; it does not stop there being one.
 *
 * These are source assertions rather than rendered-style assertions on
 * purpose. There is no engine here to compute styles with, and the thing
 * worth preventing is someone reaching for `infinite` again — which is
 * visible in the stylesheet.
 */

const css = Object.fromEntries(
  ['screens', 'components', 'tokens', 'base', 'timers'].map((name) => [
    name,
    readFileSync(new URL(`../src/styles/${name}.css`, import.meta.url), 'utf8'),
  ]),
);

/**
 * Innermost `selector { body }` blocks.
 *
 * Innermost is what makes this safe around `@keyframes` and `@media`: the
 * wrapper never matches as a block of its own, so every hit is a real rule.
 */
function rules(source) {
  const found = [];
  // Comments first, or a selector arrives with the prose above it attached —
  // and prose in this file talks about `infinite` for the reasons it must
  // not be used, which would make this test fail on its own explanation.
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, selector, body] of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // The capture reaches back to the previous block's closing brace; the
    // selector is whatever follows it.
    const clean = selector.slice(selector.lastIndexOf('}') + 1).trim().replace(/\s+/g, ' ');
    if (clean) found.push({ selector: clean, body });
  }
  return found;
}

/**
 * Animations allowed to run forever, and why each one is bounded in practice.
 *
 * Every entry here is a spinner or a pulse that exists only while something
 * is genuinely pending, so it stops on its own. Adding to this list means
 * claiming the same is true of the new one.
 */
const TRANSIENT = [
  // Only while the socket is reconnecting.
  ".status-dot[data-state='connecting']",
  // Only while a track has no known duration.
  ".np-progress-track[data-indeterminate] .np-progress-fill",
  // Only while something is still loading — the boot spinner, and the same
  // spinner reused inside sheets that are waiting on a reply.
  '.spinner',
];

test('no element animates forever on a screen the panel sits on', () => {
  const offenders = [];

  for (const [name, source] of Object.entries(css)) {
    for (const { selector, body } of rules(source)) {
      if (!/animation\s*:/.test(body)) continue;
      if (!/\binfinite\b/.test(body)) continue;
      if (TRANSIENT.includes(selector)) continue;
      offenders.push(`${name}.css: ${selector}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'these run every vsync for as long as they are on screen; step the value '
      + 'on a state change instead, or add the selector to TRANSIENT with a '
      + 'reason it stops on its own:\n  ' + offenders.join('\n  '),
  );
});

test('the screensaver never carries an infinite animation', () => {
  for (const [name, source] of Object.entries(css)) {
    for (const { selector, body } of rules(source)) {
      if (!selector.includes('.saver')) continue;
      assert.ok(
        !/\binfinite\b/.test(body),
        `${name}.css: ${selector} animates forever on the screen the panel idles on`,
      );
    }
  }
});

test('burn-in drift steps through discrete positions instead of animating', () => {
  const positions = [...css.screens.matchAll(/\.saver-info\[data-drift='(\d)'\]/g)];
  assert.ok(
    positions.length >= 4,
    `expected several discrete drift positions, found ${positions.length}`,
  );

  // Four corners against five offsets: the cycles stay out of step, so the
  // clock visits twenty places rather than four before repeating.
  const corners = new Set(
    [...css.screens.matchAll(/\.saver-info\[data-corner='(\d)'\]/g)].map(([, n]) => n),
  );
  const offsets = new Set(positions.map(([, n]) => n));
  assert.equal(corners.size, 4);
  assert.notEqual(
    offsets.size % corners.size,
    0,
    `${offsets.size} offsets against ${corners.size} corners share a factor, `
      + 'so the two cycles lock together and cover fewer positions than they look like',
  );
});

test('screensaver movement honours the ui.motion escape hatch', () => {
  /*
   * `--motion: 0` is documented in tokens.css as the way to stop animation on
   * a struggling device, and `prefers-reduced-motion` scales it to ~0 too.
   * A keyframe animation with a hard-coded duration ignored both — which is
   * exactly the situation someone reaches for that setting to fix.
   */
  for (const selector of ['.saver-info', '.saver-np-layout']) {
    const rule = rules(css.screens).find((r) => r.selector === selector);
    assert.ok(rule, `${selector} not found`);
    assert.match(
      rule.body,
      /transition:\s*transform[^;]*var\(--motion\)/,
      `${selector} must scale its movement with --motion`,
    );
  }
});
