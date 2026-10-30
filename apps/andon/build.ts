// Bundles the Mac app's backend (src/backend.ts) into the plain-ESM JavaScript entry Tiny runs
// (build/backend.js, named by tinyjs.json's "backend"). This repo's root is fixed here, for the
// lantern images under apps/andon/assets, and so is the app's version (this package.json's
// `version`, which the release script stamps), for the About window. The app starts no service (`factory service install`
// does), so no `bun` path is built in. `bun build.ts` from apps/andon, or `bun run andon:build`.
import { join, resolve } from 'node:path';

export const APP_DIR = import.meta.dir;
export const BACKEND_OUT = join(APP_DIR, 'build', 'backend.js');

/** The Mac app's version: this package.json's `version`. */
export async function appVersion(): Promise<string> {
  const pkg: unknown = await Bun.file(join(APP_DIR, 'package.json')).json();
  const version = typeof pkg === 'object' && pkg !== null && 'version' in pkg ? pkg.version : undefined;
  if (typeof version !== 'string') throw new Error('apps/andon/package.json has no version');
  return version;
}

export async function bundleBackend(opts: { repo?: string } = {}): Promise<string> {
  const repo = opts.repo ?? resolve(APP_DIR, '..', '..');
  const result = await Bun.build({
    entrypoints: [join(APP_DIR, 'src', 'backend.ts')],
    target: 'browser', // no Node or Bun shims: txiki.js provides fetch-era globals only
    format: 'esm',
    define: { __ANDON_REPO__: JSON.stringify(repo), __ANDON_VERSION__: JSON.stringify(await appVersion()) },
  });
  if (!result.success) throw new Error(result.logs.map(String).join('\n'));
  const out = result.outputs[0];
  if (out === undefined) throw new Error('bun build produced no output');
  return out.text();
}

if (import.meta.main) {
  await Bun.write(BACKEND_OUT, await bundleBackend());
  console.log(`andon: bundled ${BACKEND_OUT}`);
}
