// Builds the managed release the installer writes: the Claude Code render, the self-contained
// installed CLI (`factory/cli.ts`), and the installed contract (`factory/CONTRACT.md`).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '@factory/contract';
import { renderClaudeCode, stampCli, stampContract } from '@factory/templates';

// This source tree's root (packages/cli/src -> the repo). The installer always runs from source.
const SOURCE_ROOT = join(import.meta.dir, '..', '..', '..');
const ENTRY = 'packages/cli/src/installed.ts';
const CONTRACT = join(SOURCE_ROOT, 'docs', 'contract', 'v1.md');

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

/** The stamped installed CLI; bundled once per process. */
export function installedCli(): Promise<string> {
  if (cliCache === null) {
    cliCache = bundleCli().then(stampCli);
    cliCache.catch(() => {
      cliCache = null;
    });
  }
  return cliCache;
}

/** The stamped installed contract: `docs/contract/v1.md`'s text. */
export async function installedContract(): Promise<string> {
  return stampContract(await readFile(CONTRACT, 'utf8'));
}

/** Every managed file of the release for `config`, by repo-relative path. */
export async function buildRelease(config: Config): Promise<Record<string, string>> {
  const { files } = renderClaudeCode({ config });
  const [cli, contract] = await Promise.all([installedCli(), installedContract()]);
  return { ...files, 'factory/cli.ts': cli, 'factory/CONTRACT.md': contract };
}
