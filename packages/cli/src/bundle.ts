// Builds the managed release the installer writes: the Claude Code render, the self-contained
// installed CLI (`factory/cli.ts`), and the installed contract (`factory/CONTRACT.md`).
// The render comes from the templates, which every build of the CLI carries. The installed CLI and
// the contract come from one of two places (`ReleaseFiles`):
// - from source (`SOURCE_RELEASE`): `bun build` over this source tree, and `docs/contract/v1.md`;
// - from the release bundle (`bakedRelease`): the same bytes, built into the bundle's `managed/`
//   directory when the bundle was made (scripts/bundle.ts), read as files, with no source tree.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '@factory/contract';
import { renderClaudeCode, stampCli, stampContract } from '@factory/templates';

/** This source tree's root (packages/cli/src -> the repo), the clone the source CLI runs from. */
export const SOURCE_ROOT = join(import.meta.dir, '..', '..', '..');
const ENTRY = 'packages/cli/src/installed.ts';
const CONTRACT = join(SOURCE_ROOT, 'docs', 'contract', 'v1.md');

/** Where the release bundle keeps the baked managed files, relative to the bundle's root. */
export const BAKED_DIR = 'managed';
/** The baked files' names in `BAKED_DIR`: exactly the text the installer writes. */
export const BAKED_CLI = 'cli.ts';
export const BAKED_CONTRACT = 'CONTRACT.md';

/** The installed CLI and the installed contract, stamped, as the installer writes them. */
export interface ReleaseFiles {
  cli: () => Promise<string>;
  contract: () => Promise<string>;
}

/**
 * Bundles `installed.ts` into one file that runs with `bun` alone (no workspace packages, no
 * node_modules). `bun build` runs as a child with its cwd pinned to the source root, because the
 * bundler's per-module comments are relative to the cwd: pinning it makes the same source give the
 * same bytes wherever the installer is run from.
 */
export async function bundleCli(): Promise<string> {
  const proc = Bun.spawn([process.execPath, 'build', ENTRY, '--target=bun', '--format=esm'], {
    cwd: SOURCE_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 || out === '') throw new Error(`bundle: bun build failed: ${err.trim().split('\n')[0] ?? `exit ${code}`}`);
  return out;
}

let cliCache: Promise<string> | null = null;

/** The stamped installed CLI, from source; bundled once per process. */
export function installedCli(): Promise<string> {
  if (cliCache === null) {
    cliCache = bundleCli().then(stampCli);
    cliCache.catch(() => {
      cliCache = null;
    });
  }
  return cliCache;
}

/** The stamped installed contract, from source: `docs/contract/v1.md`'s text. */
export async function installedContract(): Promise<string> {
  return stampContract(await readFile(CONTRACT, 'utf8'));
}

/** The release files from this source tree. */
export const SOURCE_RELEASE: ReleaseFiles = { cli: installedCli, contract: installedContract };

/** The release files baked into the release bundle rooted at `bundleRoot`: read, never built. */
export function bakedRelease(bundleRoot: string): ReleaseFiles {
  const read = (name: string) => async (): Promise<string> => {
    try {
      return await readFile(join(bundleRoot, BAKED_DIR, name), 'utf8');
    } catch (e) {
      throw new Error(`bundle: ${BAKED_DIR}/${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return { cli: read(BAKED_CLI), contract: read(BAKED_CONTRACT) };
}

/** Every managed file of the release for `config`, by repo-relative path. */
export async function buildRelease(config: Config, from: ReleaseFiles = SOURCE_RELEASE): Promise<Record<string, string>> {
  const { files } = renderClaudeCode({ config });
  const [cli, contract] = await Promise.all([from.cli(), from.contract()]);
  return { ...files, 'factory/cli.ts': cli, 'factory/CONTRACT.md': contract };
}
