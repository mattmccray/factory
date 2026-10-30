// Builds the Andon UI into dist/, which the Andon service serves at `/`. In development
// (`bun run andon:ui:dev`), Vite serves the UI and proxies the service's API paths to the running service
// on $ANDON_PORT (default 8766), with the service's own Host and no Origin, so its guard passes.
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const service = `http://127.0.0.1:${process.env.ANDON_PORT ?? '8766'}`;
const toService = {
  target: service,
  changeOrigin: true,
  configure: (proxy: { on(event: 'proxyReq', fn: (req: { removeHeader(name: string): void }) => void): void }) => {
    proxy.on('proxyReq', (req) => req.removeHeader('origin'));
  },
};

export default defineConfig({
  plugins: [svelte()],
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true },
  // Loopback only, and no CORS: the dev server is as local as the service it proxies to.
  server: { host: '127.0.0.1', cors: false, proxy: { '/projects': toService, '/events': toService, '/release': toService } },
});
