// The Andon service's process body, shared by its two entries: `main.ts` (from a source clone) and
// `release-main.ts` (from the release bundle). Each passes the tree it runs in: where the built Andon
// UI is, and the root and version file of the release it reports. Listens on 127.0.0.1:$ANDON_PORT
// (default 8766) and reads the registry at $ANDON_HOME/projects.json (default ~/.andon/projects.json).
import { registryPath } from '@factory/contract';
import { startService } from './index';

export interface Tree {
  uiDir: string; // the built Andon UI, served at `/`
  cloneRoot: string; // the tree whose `CHANGELOG.md` and version file `GET /release` reports
  versionFile: string; // the file under `cloneRoot` whose `version` is the release
}

export async function serve(tree: Tree): Promise<void> {
  const raw = process.env.ANDON_PORT ?? '8766';
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65535) {
    console.error(`andon: ANDON_PORT must be a port number (0-65535), got ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  const registry = registryPath(process.env.ANDON_HOME);
  const service = await startService({ port, registryPath: registry, ...tree });
  console.log(`Andon service: ${service.url} (registry ${registry})`);

  const shutdown = (): void => {
    void service.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
