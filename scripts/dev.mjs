#!/usr/bin/env node
/**
 * Development launcher: runs the backend and the Vite dev server together.
 *
 * Worth a script rather than `concurrently` because of one detail: Vite
 * PROXIES /api, /img and /ws to the backend (see panel/vite.config.ts), so
 * the panel is same-origin in development exactly as it is in production.
 * That means CORS never works in dev and then breaks on the device — the
 * single most common way this class of app fails at deployment time.
 *
 *   npm run dev   →  panel on http://localhost:5173
 *                    backend on http://127.0.0.1:8099
 */

import { spawn } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const procs = [];
let shuttingDown = false;

function run(name, args, colour) {
  const child = spawn('npm', args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  const tag = `\x1b[${colour}m${name.padEnd(6)}\x1b[0m │ `;
  const pipe = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(tag + line + '\n');
    });
  };

  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`${tag}exited with code ${code}`);
    // If either half dies the other is useless — stop both so the failure is
    // obvious instead of leaving a half-working dev environment.
    shutdown(code ?? 1);
  });

  procs.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('\nStarting development environment…\n');
run('server', ['run', 'dev', '--workspace', 'server'], '36'); // cyan
run('panel', ['run', 'dev', '--workspace', 'panel'], '35'); // magenta
console.log('\n  Panel:   http://localhost:5173');
console.log('  Backend: http://127.0.0.1:8099\n');
