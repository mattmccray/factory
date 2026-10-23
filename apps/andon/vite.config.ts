// Builds the Andon UI into dist/, which the Andon agent serves at `/`. In development
// (`bun run andon:dev`), Vite serves the UI and proxies the agent's API paths to the running agent
// on $ANDON_PORT (default 8766), with the agent's own Host and no Origin, so its guard passes.
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const agent = `http://127.0.0.1:${process.env.ANDON_PORT ?? '8766'}`;
const toAgent = {
  target: agent,
  changeOrigin: true,
  configure: (proxy: { on(event: 'proxyReq', fn: (req: { removeHeader(name: string): void }) => void): void }) => {
    proxy.on('proxyReq', (req) => req.removeHeader('origin'));
  },
};

export default defineConfig({
  plugins: [svelte()],
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/projects': toAgent, '/events': toAgent } },
});
