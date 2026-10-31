// The Andon service's process body, shared by its entries: `main.ts` (from a source clone),
// `release-main.ts` (from the release bundle), and the factory CLI's `factory service run` (from
// either). Each passes the tree it runs in: where the built Andon UI is, and the root and version
// file of the release it reports. Listens on 127.0.0.1:$ANDON_PORT (default 8766) and reads the
// registry at $ANDON_HOME/projects.json (default ~/.andon/projects.json). With $ANDON_TAILNET_HOST
// (recorded in the unit by `factory service install --tailnet`), the guard also accepts that name.
import { join } from 'node:path';
import { registryPath } from '@factory/contract';
import { isTailnetHost, startService } from './index';

export { isTailnetHost } from './index';
import { BUNDLE_VERSION_FILE, SOURCE_VERSION_FILE } from './release';

export interface Tree {
  uiDir: string; // the built Andon UI, served at `/`
  cloneRoot: string; // the tree whose `CHANGELOG.md` and version file `GET /release` reports
  versionFile: string; // the file under `cloneRoot` whose `version` is the release
}

/** A source clone's tree: the UI built into `apps/andon-ui/dist` (`bun run andon:ui:build`), and
 *  the clone's release (`packages/templates/package.json`) and `CHANGELOG.md`. */
export const sourceTree = (cloneRoot: string): Tree => ({ uiDir: join(cloneRoot, 'apps', 'andon-ui', 'dist'), cloneRoot, versionFile: SOURCE_VERSION_FILE });

/** The release bundle's tree: the UI built into `andon/ui/`, and the bundle's own version (its root
 *  `package.json`) and `CHANGELOG.md`. */
export const bundleTree = (bundleRoot: string): Tree => ({ uiDir: join(bundleRoot, 'andon', 'ui'), cloneRoot: bundleRoot, versionFile: BUNDLE_VERSION_FILE });

export async function serve(tree: Tree): Promise<void> {
  const raw = process.env.ANDON_PORT ?? '8766';
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65535) {
    console.error(`andon: ANDON_PORT must be a port number (0-65535), got ${JSON.stringify(raw)}`);
    process.exit(1);
  }
  const tailnetHost = process.env.ANDON_TAILNET_HOST;
  if (tailnetHost !== undefined && !isTailnetHost(tailnetHost)) {
    console.error(`andon: ANDON_TAILNET_HOST must be a lowercase DNS name, got ${JSON.stringify(tailnetHost)}`);
    process.exit(1);
  }
  const registry = registryPath(process.env.ANDON_HOME);
  const service = await startService({ port, registryPath: registry, ...tree, ...(tailnetHost === undefined ? {} : { tailnetHost }) });
  console.log(`Andon service: ${service.url} (registry ${registry})`);
  if (tailnetHost !== undefined) console.log(`Andon service: also https://${tailnetHost}:${new URL(service.url).port}/ through tailscale serve`);

  const shutdown = (): void => {
    void service.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
