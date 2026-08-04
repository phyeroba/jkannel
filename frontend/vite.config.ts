import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Vite rejects any request whose Host header is not allow-listed. Behind a
    // reverse proxy the dev server receives the PUBLIC hostname, so without this
    // every proxied request returns 403 "This host is not allowed" — which is
    // what happens the moment the console is put behind a domain. Set
    // VITE_ALLOWED_HOSTS to a comma-separated list (a leading dot allows a whole
    // suffix, e.g. `.example.com`) when deploying behind one.
    allowedHosts: (process.env.VITE_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .concat(['localhost', '127.0.0.1']),
    // The HMR client connects back on the page's own origin. Through a TLS
    // terminating proxy that is wss://<public-host>:443, which nginx upgrades.
    hmr: process.env.VITE_HMR_CLIENT_PORT
      ? { clientPort: Number(process.env.VITE_HMR_CLIENT_PORT), protocol: 'wss' }
      : true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    clearMocks: true,
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});
