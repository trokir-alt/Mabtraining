import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

/** where the /api functions are served while developing; see scripts/api-server.mjs */
const API_TARGET = process.env.API_TARGET ?? 'http://127.0.0.1:4181'
const proxy = { '/api': { target: API_TARGET, changeOrigin: false } }

export default defineConfig({
  // the commit is baked in so any exported file says which build made it;
  // without that, "I deployed a fix" and "the fix is running" look the same
  define: { __BUILD__: JSON.stringify((process.env.COMMIT_REF ?? 'dev').slice(0, 7)) },
  plugins: [
    react(),
    /**
     * Offline. A coach in a hall has whatever wifi the hall has, and the app
     * has to open regardless: the shell, the fonts and the brand assets are
     * precached, and the exercises come from IndexedDB.
     *
     * Nothing under /api is cached or faked. A stale answer from a service
     * worker would look exactly like a successful sync and would be the one
     * failure the coach could not see - so the API is left to the network and
     * the sync engine's own "no connection" state handles the rest.
     */
    VitePWA({
      registerType: 'autoUpdate',
      // src/lib/updates.ts registers the worker and, unlike the script this
      // plugin injects, actually checks for a new one and reloads
      injectRegister: false,
      includeAssets: ['brand/icon.svg', 'brand/icon-180.png', 'fonts/*.woff2'],
      manifest: {
        name: 'Упражнения · МАБ',
        short_name: 'Упражнения МАБ',
        description: 'Конструктор упражнений по русскому бильярду и американскому пулу — Международная Академия Бильярда.',
        lang: 'ru',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#16191d',
        theme_color: '#16191d',
        icons: [
          { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/brand/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/brand/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // both are needed for the app to be able to replace itself: skipWaiting
        // lets the new worker activate without waiting for every tab to close,
        // clientsClaim lets it take over the page that is already open. Without
        // the second one the page keeps its old worker and old bundle, and a
        // device can stay on a stale build indefinitely.
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ['**/*.{js,css,html,woff2,svg,png}'],
        navigateFallback: '/index.html',
        // a navigation to /api/... must reach the function, not the app shell
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
        // the bundle is one chunk and larger than the 2 MB default
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: { proxy },
  preview: { proxy },
})
