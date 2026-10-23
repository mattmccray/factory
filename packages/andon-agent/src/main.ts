#!/usr/bin/env bun
// Process entry for the Andon agent (`bun run andon`). Listens on 127.0.0.1:$ANDON_PORT (default
// 8766) and reads the registry at $ANDON_HOME/projects.json (default ~/.andon/projects.json).
import { registryPath } from '@factory/contract';
import { startAgent } from './index';

const raw = process.env.ANDON_PORT ?? '8766';
const port = Number(raw);
if (!/^\d+$/.test(raw) || port > 65535) {
  console.error(`andon: ANDON_PORT must be a port number (0-65535), got ${JSON.stringify(raw)}`);
  process.exit(1);
}
const registry = registryPath(process.env.ANDON_HOME);
const agent = await startAgent({ port, registryPath: registry });
console.log(`Andon agent: ${agent.url} (registry ${registry})`);

const shutdown = (): void => {
  void agent.stop().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
