/**
 * Responsive audit — every screen, at every viewport worth caring about.
 *
 * This exists because "does it fit?" kept being answered by looking at one
 * panel and hoping. It measures three things that are facts rather than
 * opinions, so a change can be shown to have improved something:
 *
 *   overflow  anything forcing the page wider than the viewport
 *   cramped   interactive targets under 44px in either axis
 *   clipped   labels truncated past ~1.5x, i.e. unreadable rather than tidy
 *
 * It is NOT in CI: it needs a running backend and a real browser. Run it
 * after any layout change.
 *
 *   1. npm run build
 *   2. start the backend on :18580 with a PANEL_TOKEN of `shot`
 *   3. chromium --headless=new --remote-debugging-port=9260 about:blank
 *   4. node scripts/responsive-audit.mjs        (VERBOSE=1 for the detail)
 *
 * **It does not measure whether the result looks good**, and the difference
 * matters. Every one of these numbers was clean on an iPad in portrait while
 * the content sat in the top third of the screen with two thirds empty, and
 * clean again on a phone whose navigation labels were overlapping. Take a
 * screenshot at the extremes as well; this catches the regressions, your eyes
 * catch the design.
 *
 * **And it only sees what the backend gives it.** The first run of this found
 * nothing wrong with the Media screen or the Home now-playing card, because
 * the harness had no music configured and neither screen rendered anything.
 * A real phone showed six controls running off the right edge and an album
 * cover squashed to a strip. Point it at a backend with speakers, photos and
 * a device tile actually present, or it will confidently pass the screens it
 * never drew.
 */

import { WebSocket } from 'ws';

const SIZES = [
  ['navigator', 1325, 681],
  ['navigator-alt', 1280, 800],
  ['ipad-land', 1133, 744],
  ['ipad-port', 744, 1133],
  ['hub-max', 1024, 600],
  ['hub', 800, 480],
  ['phone', 390, 844],
  ['desktop', 1920, 1080],
];
const SCREENS = ['Home', 'Rooms', 'Controls', 'Media', 'Photos', 'Settings'];

const t = (await (await fetch('http://127.0.0.1:9260/json')).json()).find((x) => x.type === 'page');
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
await new Promise((r) => ws.once('open', r));
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalx = async (e) => (await send('Runtime.evaluate', { returnByValue: true, expression: e })).result?.value;

const AUDIT = `(() => {
  const out = { overflow: 0, cramped: [], clipped: [] };
  const de = document.documentElement;
  out.overflow = Math.max(0, de.scrollWidth - de.clientWidth);

  for (const el of document.querySelectorAll('.pressable, button, [role="button"], .nav-item')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;           // not rendered
    if (r.width < 44 || r.height < 44) {
      out.cramped.push((el.className || el.tagName) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
  }
  // A .truncate element showing an ellipsis is doing its job — flagging that
  // measures the design, not a bug. Only SEVERE truncation counts: past ~1.5x
  // the label is a word and a half and tells you nothing.
  for (const el of document.querySelectorAll('.truncate, .nav-item-label, .macro-btn-name, .rows-key, .rows-val, .card-title, .tile-name')) {
    if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth * 1.5) {
      out.clipped.push((el.className || el.tagName) + ' ' + el.scrollWidth + '>' + el.clientWidth);
    }
  }
  out.cramped = [...new Set(out.cramped)].slice(0, 4);
  out.clipped = [...new Set(out.clipped)].slice(0, 4);
  return JSON.stringify(out);
})()`;

const tap = async (label) => {
  const b = await evalx(`(()=>{const el=[...document.querySelectorAll('.nav-item')].find(n=>(n.getAttribute('aria-label')||n.textContent||'').trim().startsWith(${JSON.stringify(label)}));
   if(!el)return null;const r=el.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});})()`);
  if (!b) return false;
  const { x, y } = JSON.parse(b);
  for (const ty of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent', { type: ty, x, y, button: 'left', clickCount: 1, pointerType: 'touch' });
  await sleep(450); return true;
};

await send('Page.enable'); await send('Runtime.enable');
let totalOverflow = 0, totalCramped = 0, totalClipped = 0;

for (const [name, w, h] of SIZES) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:18580/?t=shot&panel=audit' });
  await sleep(2600);
  const rows = [];
  for (const screen of SCREENS) {
    if (!(await tap(screen))) { rows.push(`${screen}:no-nav`); continue; }
    const r = JSON.parse(await evalx(AUDIT));
    totalOverflow += r.overflow > 0 ? 1 : 0;
    totalCramped += r.cramped.length; totalClipped += r.clipped.length;
    const bits = [];
    if (r.overflow > 0) bits.push(`overflow+${r.overflow}`);
    if (r.cramped.length) bits.push(`cramped:${r.cramped.length}`);
    if (r.clipped.length) bits.push(`clipped:${r.clipped.length}`);
    rows.push(`${screen}:${bits.length ? bits.join(',') : 'ok'}`);
    if (process.env.VERBOSE && (r.cramped.length || r.clipped.length)) {
      for (const c of r.cramped) console.log(`      cramped ${name}/${screen} ${c}`);
      for (const c of r.clipped) console.log(`      clipped ${name}/${screen} ${c}`);
    }
  }
  console.log(`${name.padEnd(14)} ${w}x${h}  ${rows.join('  ')}`);
}
console.log(`TOTALS overflowing-screens=${totalOverflow} cramped=${totalCramped} clipped=${totalClipped}`);
ws.close();
