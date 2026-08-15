import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath, URL } from 'node:url';

// The backend during `npm run dev`. Vite proxies to it so the panel is
// same-origin in development exactly as it is in production — no CORS in
// either environment, so nothing works in dev that would break on device.
const DEV_BACKEND = process.env.DEV_BACKEND ?? 'http://127.0.0.1:8099';

// Surfaced in Settings so the build running on a wall-mounted panel can be
// identified without SSHing anywhere.
const APP_VERSION = process.env.APP_VERSION ?? 'dev';

export default defineConfig({
  plugins: [preact()],

  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },

  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./src', import.meta.url)),
      // Types shared verbatim with the backend: the config schema and the
      // panel<->server wire protocol. One definition, both ends.
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },

  build: {
    // The floor documented in docs/ROOMOS.md §1. RoomOS runs Qt WebEngine
    // pinned to an older Chromium (102 as of Cisco's last published figure).
    // Raising this without testing on the device WILL produce a white screen
    // on a panel you cannot open DevTools on from the sofa.
    target: 'chrome102',

    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 4096,
    cssCodeSplit: false,

    // Source maps are built but not referenced by the shipped bundle, so they
    // cost the device nothing and are there when you attach remote DevTools.
    sourcemap: true,

    // We ship a shell, not a document. Chunk splitting would mean extra RTTs
    // before first paint for no caching benefit — the whole app changes
    // together on every deploy anyway.
    rollupOptions: {
      output: {
        manualChunks: undefined,
        entryFileNames: 'a/[name].[hash].js',
        chunkFileNames: 'a/[name].[hash].js',
        assetFileNames: 'a/[name].[hash][extname]',
      },
    },

    reportCompressedSize: true,
    // Budget from docs/ARCHITECTURE.md. Vite warns past this; treat a warning
    // as a bug, not as noise.
    chunkSizeWarningLimit: 150,
  },

  esbuild: {
    // Comments and legal banners are dead weight on a constrained device.
    legalComments: 'none',
  },

  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: DEV_BACKEND, changeOrigin: true },
      '/img': { target: DEV_BACKEND, changeOrigin: true },
      '/ws': { target: DEV_BACKEND, ws: true, changeOrigin: true },
    },
  },
});
