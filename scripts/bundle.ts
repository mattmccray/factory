// `bun scripts/bundle.ts <out>`: builds the factory's release bundle from the source tree this script
// sits in (docs/decisions.md, decisions 6 and 14). The bundle is a self-contained tree that needs
// only `bun`: no workspace packages, no `node_modules`, no dev dependencies. `bun run release`
// builds it from the tree it is about to commit and commits it onto the `release` branch, and
// `bun add -g github:mattmccray/factory#release` installs it. Its layout:
//   package.json        `factory`, the release version, `bin: { factory: "bin/factory.js" }`
//   bin/factory.js      the factory CLI (packages/cli/src/release-main.ts, bundled)
//   managed/cli.ts      the installed CLI `init` and `upgrade` write as `factory/cli.ts`, stamped
//   managed/CONTRACT.md the installed contract they write as `factory/CONTRACT.md`, stamped
//   andon/service.js    the Andon service (packages/andon-service/src/release-main.ts, bundled)
//   andon/ui/           the built Andon UI
//   CHANGELOG.md        the release's changelog (when the tree has one)
// Every step writes only under `<out>`, which must not exist or be empty. The same source always
// bundles to the same bytes.
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { BAKED_CLI, BAKED_CONTRACT, BAKED_DIR, SOURCE_ROOT, installedCli, installedContract } from '../packages/cli/src/bundle';

/** The bundle's executable: the `bin` its `package.json` names. */
export const BIN = 'bin/factory.js';
export const SERVICE = 'andon/service.js';
export const UI_DIR = 'andon/ui';

const SHEBANG = '#!/usr/bin/env bun\n';
const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

async function spawn(argv: string[], cwd: string, what: string): Promise<void> {
  const proc = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${what} failed: ${firstLine(err) || firstLine(out) || `exit ${code}`}`);
}

// One entry, bundled into one file that runs with `bun` alone. The cwd is pinned to the source
// root, so the bundler's per-module comments (relative to the cwd) are the same wherever it runs.
async function bundleEntry(entry: string, outfile: string): Promise<void> {
  await spawn([process.execPath, 'build', entry, '--target=bun', '--format=esm', '--outfile', outfile], SOURCE_ROOT, `bun build ${entry}`);
  const text = await readFile(outfile, 'utf8');
  if (!text.startsWith('#!')) await writeFile(outfile, `${SHEBANG}${text}`);
}

async function templatesVersion(): Promise<string> {
  const pkg: unknown = JSON.parse(await readFile(join(SOURCE_ROOT, 'packages', 'templates', 'package.json'), 'utf8'));
  const version = typeof pkg === 'object' && pkg !== null && 'version' in pkg ? pkg.version : undefined;
  if (typeof version !== 'string') throw new Error('packages/templates/package.json has no string "version"');
  return version;
}

/** The bundle's `package.json`: a plain package an npm publish could take as it is. */
export function bundlePackage(version: string): string {
  const pkg = {
    name: 'factory',
    version,
    description: 'The factory CLI and the Andon service, built to run with bun alone',
    type: 'module',
    bin: { factory: BIN },
    engines: { bun: '>=1.4.0' },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** Every file under `dir`, repo-style relative paths, sorted. */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split('\\').join('/'))
    .sort();
}

/** Builds the bundle of this source tree into `out`. Returns its version. Throws a one-line reason. */
export async function buildBundle(out: string): Promise<string> {
  const at = resolve(out);
  await mkdir(at, { recursive: true });
  if ((await readdir(at)).length > 0) throw new Error(`bundle: ${at} is not empty`);
  const version = await templatesVersion();

  await bundleEntry('packages/cli/src/release-main.ts', join(at, BIN));
  await chmod(join(at, BIN), 0o755);
  await bundleEntry('packages/andon-service/src/release-main.ts', join(at, SERVICE));
  await mkdir(join(at, BAKED_DIR));
  await writeFile(join(at, BAKED_DIR, BAKED_CLI), await installedCli());
  await writeFile(join(at, BAKED_DIR, BAKED_CONTRACT), await installedContract());
  await spawn([process.execPath, 'run', 'build', '--outDir', join(at, UI_DIR), '--emptyOutDir'], join(SOURCE_ROOT, 'apps', 'andon-ui'), 'the Andon UI build');
  try {
    await writeFile(join(at, 'CHANGELOG.md'), await readFile(join(SOURCE_ROOT, 'CHANGELOG.md')));
  } catch (e) {
    if (!(typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT')) throw e;
  }
  await writeFile(join(at, 'package.json'), bundlePackage(version));
  return version;
}

if (import.meta.main) {
  const [out, ...extra] = process.argv.slice(2);
  if (out === undefined || extra.length > 0) {
    process.stderr.write('usage: bun scripts/bundle.ts <out dir>\n');
    process.exit(2);
  }
  try {
    const version = await buildBundle(out);
    process.stdout.write(`built the factory ${version} bundle in ${resolve(out)}\n`);
  } catch (e) {
    process.stderr.write(`bundle failed: ${firstLine(e instanceof Error ? e.message : String(e))}\n`);
    process.exit(1);
  }
}
