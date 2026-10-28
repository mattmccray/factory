// Bundles the Mac app's backend (src/backend.ts) into the plain-ESM JavaScript entry Tiny runs
// (build/backend.js, named by tinyjs.json's "backend"). The service's location is fixed here: this
// repo's root, and the absolute path of the `bun` running the build (a packaged app launched
// from Finder has no shell PATH). `bun build.ts` from apps/andon, or `bun run andon:build`.
import { join, resolve } from 'node:path';

export const APP_DIR = import.meta.dir;
export const BACKEND_OUT = join(APP_DIR, 'build', 'backend.js');

export async function bundleBackend(opts: { repo?: string; bun?: string } = {}): Promise<string> {
  const repo = opts.repo ?? resolve(APP_DIR, '..', '..');
  const bun = opts.bun ?? process.execPath;
  const result = await Bun.build({
    entrypoints: [join(APP_DIR, 'src', 'backend.ts')],
    target: 'browser', // no Node or Bun shims: txiki.js provides fetch-era globals only
    format: 'esm',
    define: { __ANDON_REPO__: JSON.stringify(repo), __ANDON_BUN__: JSON.stringify(bun) },
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
