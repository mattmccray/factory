#!/usr/bin/env bun
// Process entry for the Andon service (`bun run andon:service`). Listens on 127.0.0.1:$ANDON_PORT (default
// 8766) and reads the registry at $ANDON_HOME/projects.json (default ~/.andon/projects.json).
// It serves the Andon UI from this repo's `apps/andon-ui/dist` (built by `bun run andon:ui:build`).
import { join } from 'node:path';
import { registryPath } from '@factory/contract';
import { startService } from './index';

const raw = process.env.ANDON_PORT ?? '8766';
const port = Number(raw);
if (!/^\d+$/.test(raw) || port > 65535) {
  console.error(`andon: ANDON_PORT must be a port number (0-65535), got ${JSON.stringify(raw)}`);
  process.exit(1);
}
const registry = registryPath(process.env.ANDON_HOME);
const uiDir = join(import.meta.dir, '..', '..', '..', 'apps', 'andon-ui', 'dist');
const service = await startService({ port, registryPath: registry, uiDir });
console.log(`Andon service: ${service.url} (registry ${registry})`);

const shutdown = (): void => {
  void service.stop().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
