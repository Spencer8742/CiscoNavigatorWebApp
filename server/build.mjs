import { build, context } from 'esbuild';
import { copyFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

/**
 * Server build.
 *
 * esbuild rather than plain `tsc` for one reason: the backend and the panel
 * share type definitions from `shared/`, and path aliases need to survive
 * into the emitted JavaScript. `tsc` does not rewrite them; esbuild does, in
 * about 40 ms, with no extra tooling.
 *
 * `ws` and `yaml` stay external — they are real runtime dependencies
 * installed in the container, not something to inline.
 */

const shared = fileURLToPath(new URL('./../shared', import.meta.url));
const src = fileURLToPath(new URL('./src', import.meta.url));

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/index.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  packages: 'external',
  alias: {
    '~': src,
    '@shared': shared,
  },
  // Node's ESM loader has no `require`; a few transitive CJS deps expect one.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
};

/**
 * A second bundle, for the test suite only.
 *
 * `dist/server.js` starts listening when it is imported, so it cannot be
 * imported to test a function. This exposes the pieces that are worth
 * exercising directly — see src/testkit.ts. Nothing ships it; the container's
 * entry point is dist/server.js as before.
 */
/** @type {import('esbuild').BuildOptions} */
const testkit = {
  ...options,
  entryPoints: ['src/testkit.ts'],
  outfile: 'dist/testkit.js',
};

if (process.argv.includes('--run')) {
  // `npm run dev` path: rebuild on change. Node's own --watch restarts the
  // process when dist/server.js is rewritten.
  const ctx = await context(options);
  await ctx.rebuild();
  await copyFile('src/apple-tv/bridge.py', 'dist/apple-tv-bridge.py');
  await ctx.watch();
  await import('./dist/server.js');
} else {
  await Promise.all([build(options), build(testkit)]);
  await copyFile('src/apple-tv/bridge.py', 'dist/apple-tv-bridge.py');
}
