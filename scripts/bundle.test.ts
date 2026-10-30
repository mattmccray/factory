import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitIn, initRepo } from '../packages/cli/src/gitrepo';
import { BIN, SERVICE, UI_DIR, buildBundle, listFiles } from './bundle';

// The release bundle (scripts/bundle.ts), built once from this checkout into a temp dir with no
// source tree reachable from it, and exercised as `bun add -g` would leave it.
const SOURCE = join(import.meta.dir, '..');
const SOURCE_MAIN = join(SOURCE, 'packages', 'cli', 'src', 'main.ts');

let tmp: string;
let bundle: string;
let version: string;
beforeAll(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'factory-bundle-')));
  bundle = join(tmp, 'bundle');
  version = await buildBundle(bundle);
}, 120_000);
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface Ran {
  code: number;
  out: string;
  err: string;
}
function runIn(cwd: string, argv: string[], env: Record<string, string> = {}): Ran {
  const p = Bun.spawnSync(argv, { cwd, env: { ...process.env, ANDON_HOME: join(tmp, 'andon-home'), ...env }, stdout: 'pipe', stderr: 'pipe' });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const viaSource = (cwd: string, ...args: string[]): Ran => runIn(cwd, [process.execPath, SOURCE_MAIN, ...args]);
const viaBundle = (cwd: string, ...args: string[]): Ran => runIn(cwd, [process.execPath, join(bundle, BIN), ...args]);

/** Every file in a repo except `.git/`, by relative path, with its bytes as hex digests. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of await listFiles(dir)) {
    if (rel.startsWith('.git/')) continue;
    out[rel] = createHash('sha256').update(await readFile(join(dir, rel))).digest('hex');
  }
  return out;
}

async function freshRepo(name: string): Promise<string> {
  const repo = join(tmp, name);
  await mkdir(repo, { recursive: true });
  initRepo(repo);
  return repo;
}

const templatesVersion = async (): Promise<string> => {
  const pkg: unknown = JSON.parse(await readFile(join(SOURCE, 'packages', 'templates', 'package.json'), 'utf8'));
  const v = typeof pkg === 'object' && pkg !== null && 'version' in pkg ? pkg.version : undefined;
  if (typeof v !== 'string') throw new Error('no templates version');
  return v;
};

describe('the bundle tree', () => {
  test('a package.json with bin.factory at the templates version; the CLI, the service, the UI, the baked files, and CHANGELOG.md', async () => {
    expect(version).toBe(await templatesVersion());
    const pkg: unknown = JSON.parse(await readFile(join(bundle, 'package.json'), 'utf8'));
    expect(pkg).toMatchObject({ name: 'factory', version, bin: { factory: BIN } });
    const files = await listFiles(bundle);
    for (const f of [BIN, SERVICE, `${UI_DIR}/index.html`, 'managed/cli.ts', 'managed/CONTRACT.md', 'CHANGELOG.md', 'package.json']) expect(files).toContain(f);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect((await stat(join(bundle, BIN))).mode & 0o111).not.toBe(0);
    expect((await readFile(join(bundle, BIN), 'utf8')).startsWith('#!/usr/bin/env bun\n')).toBe(true);
    expect(await readFile(join(bundle, 'CHANGELOG.md'), 'utf8')).toBe(await readFile(join(SOURCE, 'CHANGELOG.md'), 'utf8'));
  });

  test('the same source bundles to the same bytes', async () => {
    const again = join(tmp, 'again');
    await buildBundle(again);
    expect(await tree(again)).toEqual(await tree(bundle));
  }, 120_000);

  test('refuses a non-empty output directory', async () => {
    const out = join(tmp, 'busy');
    await mkdir(out);
    await writeFile(join(out, 'x'), 'x');
    await expect(buildBundle(out)).rejects.toThrow('is not empty');
  });
});

describe('init and upgrade from the bundle (AC1, AC2)', () => {
  test('AC1: init installs byte-identical files to a source init, with no source tree, and doctor passes', async () => {
    const fromSource = await freshRepo('init-source');
    const fromBundle = await freshRepo('init-bundle');
    const s = viaSource(fromSource, 'init');
    const b = viaBundle(fromBundle, 'init');
    expect(s.code).toBe(0);
    expect({ code: b.code, err: b.err }).toEqual({ code: 0, err: '' });
    expect(b.out.split('\n')[0]).toBe(s.out.split('\n')[0] ?? '');
    const want = await tree(fromSource);
    expect(Object.keys(want)).toContain('factory/managed.json');
    expect(Object.keys(want)).toContain('factory/cli.ts');
    expect(Object.keys(want)).toContain('factory/CONTRACT.md');
    expect(await tree(fromBundle)).toEqual(want);
    const doctor = runIn(fromBundle, [process.execPath, 'factory/cli.ts', 'doctor']);
    expect(doctor.code).toBe(0);
  }, 60_000);

  test('AC2: upgrade from an older version replaces the managed core and manifest as a source upgrade does; the overlay is untouched', async () => {
    const seed = await freshRepo('upgrade-seed');
    expect(viaSource(seed, 'init').code).toBe(0);
    // An older install: an older version, an older builder agent, and a file the new render drops.
    const manifest: unknown = JSON.parse(await readFile(join(seed, 'factory', 'managed.json'), 'utf8'));
    if (typeof manifest !== 'object' || manifest === null || !('files' in manifest) || typeof manifest.files !== 'object' || manifest.files === null) throw new Error('bad manifest');
    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(manifest.files)) if (typeof v === 'string') files[k] = v;
    const oldAgent = '---\nname: factory-builder\n---\n<!-- factory 0.0.1 · managed file -->\nold builder\n';
    const gone = '<!-- factory 0.0.1 · managed file -->\nretired\n';
    await writeFile(join(seed, '.claude', 'agents', 'factory-builder.md'), oldAgent);
    await writeFile(join(seed, '.claude', 'agents', 'factory-retired.md'), gone);
    const sha = (t: string): string => createHash('sha256').update(t).digest('hex');
    files['.claude/agents/factory-builder.md'] = sha(oldAgent);
    files['.claude/agents/factory-retired.md'] = sha(gone);
    await writeFile(join(seed, 'factory', 'managed.json'), `${JSON.stringify({ schema: 'factory/v1', version: '0.0.1', files }, null, 2)}\n`);
    // The overlay: an edited config.json and a role overlay.
    const config = `${JSON.stringify({ name: 'Seed', schema: 'factory/v1', reviewers: ['code', 'security'], maxRound: 3, dashboard: { settleAfterHours: 12 } }, null, 2)}\n`;
    await writeFile(join(seed, 'factory', 'config.json'), config);
    await mkdir(join(seed, 'factory', 'roles'));
    await writeFile(join(seed, 'factory', 'roles', 'builder.md'), '# Builder overlay\n\n- Project rule.\n');
    gitIn(seed, 'add', '-A');
    gitIn(seed, 'commit', '--quiet', '-m', 'older install');

    const fromSource = join(tmp, 'upgrade-source');
    const fromBundle = join(tmp, 'upgrade-bundle');
    await cp(seed, fromSource, { recursive: true });
    await cp(seed, fromBundle, { recursive: true });
    const s = viaSource(fromSource, 'upgrade');
    const b = viaBundle(fromBundle, 'upgrade');
    expect(s.code).toBe(0);
    expect({ code: b.code, out: b.out, err: b.err }).toEqual({ code: 0, out: s.out, err: '' });
    expect(b.out).toContain(`upgraded factory 0.0.1 -> ${version}`);
    const after = await tree(fromBundle);
    expect(after).toEqual(await tree(fromSource));
    expect(Object.keys(after)).not.toContain('.claude/agents/factory-retired.md');
    expect(Object.keys(after)).toContain('.claude/agents/factory-security.md');
    expect(await readFile(join(fromBundle, 'factory', 'config.json'), 'utf8')).toBe(config);
    expect(await readFile(join(fromBundle, 'factory', 'roles', 'builder.md'), 'utf8')).toBe('# Builder overlay\n\n- Project rule.\n');
    expect(JSON.parse(await readFile(join(fromBundle, 'factory', 'managed.json'), 'utf8'))).toMatchObject({ version });
  }, 60_000);
});

describe('--version (AC3)', () => {
  test('the bundle\'s CLI prints factory <version> (release)', () => {
    const r = viaBundle(tmp, '--version');
    expect(r).toEqual({ code: 0, out: `factory ${version} (release)\n`, err: '' });
  });
});

// Reads the first stdout line of a started process, then returns the service URL in it.
async function serviceUrl(proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): Promise<string> {
  const reader = proc.stdout.getReader();
  let out = '';
  while (!out.includes('\n')) {
    const { done, value } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const url = out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  if (url === undefined) throw new Error(`no service URL in ${JSON.stringify(out)}`);
  return url;
}

async function checkService(serviceJs: string, root: string, args: string[] = []): Promise<void> {
  const home = join(tmp, `andon-${Math.random().toString(36).slice(2)}`);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'projects.json'), `${JSON.stringify({ schema: 'factory/v1', projects: [{ root: join(home, 'proj') }] })}\n`);
  const proc = Bun.spawn([process.execPath, serviceJs, ...args], { env: { ...process.env, ANDON_HOME: home, ANDON_PORT: '0' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  try {
    const url = await serviceUrl(proc);
    const listed = await fetch(`${url}/projects`);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).toContain(join(home, 'proj'));
    const index = await fetch(`${url}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toBe(await readFile(join(root, UI_DIR, 'index.html'), 'utf8'));
    const res = await fetch(`${url}/release`);
    const body: unknown = await res.json();
    expect(body).toMatchObject({ running: version, onDisk: version });
    const changelog = typeof body === 'object' && body !== null && 'changelog' in body ? body.changelog : undefined;
    expect(Array.isArray(changelog)).toBe(true);
    const text = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
    if (/^## v\d+\.\d+\.\d+ \(/m.test(text)) expect(Array.isArray(changelog) && changelog.length > 0).toBe(true);
  } finally {
    proc.kill();
    await proc.exited;
  }
}

describe('the bundle\'s Andon service (AC7)', () => {
  test('serves the built UI at / and reports the bundle\'s version and CHANGELOG.md on GET /release', async () => {
    await checkService(join(bundle, SERVICE), bundle);
  }, 30_000);

  test('the bundle\'s CLI runs the same tree in the foreground with factory service run (062 AC7)', async () => {
    await checkService(join(bundle, BIN), bundle, ['service', 'run']);
  }, 30_000);
});

describe('bun add -g of a release branch (AC7, slow)', () => {
  test('installs into a temp BUN_INSTALL; with the clone removed, factory --version says (release) and the service runs', async () => {
    const repo = join(tmp, 'release-repo');
    await cp(bundle, repo, { recursive: true });
    gitIn(repo, 'init', '--quiet', '--initial-branch=release');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '--quiet', '-m', 'chore(release): bundle');
    const bunInstall = join(tmp, 'bun-install');
    const env = { BUN_INSTALL: bunInstall, BUN_INSTALL_CACHE_DIR: join(bunInstall, 'cache'), BUN_INSTALL_GLOBAL_DIR: join(bunInstall, 'global'), BUN_INSTALL_BIN: join(bunInstall, 'bin') };
    const add = runIn(tmp, [process.execPath, 'add', '-g', `git+file://${repo}#release`], env);
    expect({ code: add.code, err: add.code === 0 ? '' : add.err }).toEqual({ code: 0, err: '' });
    await rm(repo, { recursive: true, force: true });

    const factory = join(bunInstall, 'bin', 'factory');
    const v = runIn(tmp, [factory, '--version'], env);
    expect(v).toEqual({ code: 0, out: `factory ${version} (release)\n`, err: '' });
    const installed = join(await realpath(factory), '..', '..');
    expect((await readdir(installed)).filter((f) => f !== '.bun-tag').sort()).toEqual((await readdir(bundle)).sort());
    await checkService(join(installed, SERVICE), installed);
  }, 120_000);
});
