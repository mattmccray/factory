import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '@factory/templates';
import { bakedRelease, BAKED_CLI, BAKED_CONTRACT, BAKED_DIR, SOURCE_ROOT } from './bundle';
import { run, USAGE, versionLine } from './index';

// AC3: `factory --version` from source names the checkout's root; from the release bundle it says
// `(release)`. The version is always `@factory/templates`' version.
let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'factory-version-')));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function cli(argv: string[], origin?: Parameters<typeof run>[2]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { root: join(dir, 'factory'), stdout: (l) => out.push(l), stderr: (l) => err.push(l) }, origin);
  return { code, out, err };
}

const checkoutRoot = (): string => {
  const p = Bun.spawnSync(['git', '-C', import.meta.dir, 'rev-parse', '--show-toplevel'], { stdout: 'pipe' });
  return p.stdout.toString().trim();
};

test('from source: factory <version> (source: <clone path>), exit 0, with no config read', async () => {
  expect(await realpath(SOURCE_ROOT)).toBe(await realpath(checkoutRoot()));
  expect(await cli(['--version'])).toEqual({ code: 0, out: [`factory ${VERSION} (source: ${SOURCE_ROOT})`], err: [] });
});

test('from the release bundle: factory <version> (release), exit 0', async () => {
  expect(await cli(['--version'], { kind: 'release', root: dir, files: bakedRelease(dir) })).toEqual({ code: 0, out: [`factory ${VERSION} (release)`], err: [] });
  expect(versionLine({ kind: 'release', root: dir, files: bakedRelease(dir) })).toBe(`factory ${VERSION} (release)`);
});

test('--version takes no arguments', async () => {
  expect(await cli(['--version', 'x'])).toEqual({ code: 1, out: [], err: [USAGE.version] });
});

test('the source process entry prints the checkout root', () => {
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, 'main.ts'), '--version'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  expect(p.exitCode).toBe(0);
  expect(p.stdout.toString()).toBe(`factory ${VERSION} (source: ${SOURCE_ROOT})\n`);
});

test('the baked release files are read from the bundle, never built (AC1)', async () => {
  await mkdir(join(dir, BAKED_DIR));
  await writeFile(join(dir, BAKED_DIR, BAKED_CLI), '// baked cli\n');
  await writeFile(join(dir, BAKED_DIR, BAKED_CONTRACT), 'baked contract\n');
  const files = bakedRelease(dir);
  expect(await files.cli()).toBe('// baked cli\n');
  expect(await files.contract()).toBe('baked contract\n');
  await rm(join(dir, BAKED_DIR), { recursive: true });
  await expect(files.cli()).rejects.toThrow(`bundle: ${BAKED_DIR}/${BAKED_CLI}`);
});
