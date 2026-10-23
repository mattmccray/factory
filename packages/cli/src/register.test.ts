import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registryPath } from '@factory/contract';
import { run } from './index';

// AC2: `init` registers the project root in the Andon registry as its last step.
let tmp: string;
let project: string;
let home: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'factory-register-'));
  project = join(tmp, 'project');
  home = join(tmp, 'andon');
  await mkdir(project);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface Result {
  code: number;
  out: string[];
  err: string[];
}
async function cli(registry: string, ...argv: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { root: join(project, 'factory'), registry, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out, err };
}
const roots = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'));

describe('init registers the project with Andon (AC2)', () => {
  test('a successful init lists the absolute root once; init --force again does not duplicate it', async () => {
    const file = registryPath(home);
    const first = await cli(file, 'init');
    expect(first.err).toEqual([]);
    expect(first.code).toBe(0);
    expect(first.out.some((l) => l.startsWith('note:'))).toBe(false);
    const root = await realpath(project);
    expect(await roots(file)).toEqual({ schema: 'factory/v1', projects: [{ root }] });

    await rm(join(project, 'factory', 'managed.json'));
    const again = await cli(file, 'init', '--force');
    expect(again.code).toBe(0);
    expect(await roots(file)).toEqual({ schema: 'factory/v1', projects: [{ root }] });
  });

  test('a refused init leaves the registry unchanged', async () => {
    const file = registryPath(home);
    await mkdir(home, { recursive: true });
    const before = `${JSON.stringify({ schema: 'factory/v1', projects: [{ root: '/srv/other' }] })}\n`;
    await writeFile(file, before);
    await mkdir(join(project, 'factory'), { recursive: true });
    await writeFile(join(project, 'factory', 'managed.json'), '{}');
    const r = await cli(file, 'init');
    expect(r.code).toBe(1);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await readdir(home)).toEqual(['projects.json']);
  });

  test('a refused init with no registry creates nothing', async () => {
    const file = registryPath(home);
    await mkdir(join(project, 'factory'), { recursive: true });
    await writeFile(join(project, 'factory', 'managed.json'), '{}');
    expect((await cli(file, 'init')).code).toBe(1);
    expect(await Bun.file(home).exists()).toBe(false);
  });

  test('an unwritable ANDON_HOME still installs, exits 0, and prints one note: line', async () => {
    const blocker = join(tmp, 'blocker');
    await writeFile(blocker, 'a file, not a directory');
    const file = registryPath(join(blocker, 'andon'));
    const r = await cli(file, 'init');
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    expect(await Bun.file(join(project, 'factory', 'managed.json')).exists()).toBe(true);
    const notes = r.out.filter((l) => l.startsWith('note:'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(file);
    expect(r.out).toHaveLength(2);
    expect(r.out[0]).toStartWith('installed factory');
  });

  test('an invalid registry file is a note, not a failure, and is left as is', async () => {
    const file = registryPath(home);
    await mkdir(home, { recursive: true });
    await writeFile(file, '{"schema":"factory/v2","projects":[]}');
    const r = await cli(file, 'init');
    expect(r.code).toBe(0);
    expect(r.out.filter((l) => l.startsWith('note:'))).toEqual([`note: not registered with Andon (${file}): registry: schema must be "factory/v1"`]);
    expect(await readFile(file, 'utf8')).toBe('{"schema":"factory/v2","projects":[]}');
  });

  test('upgrade does not register', async () => {
    expect((await cli(registryPath(join(tmp, 'first')), 'init')).code).toBe(0);
    const file = registryPath(home);
    expect((await cli(file, 'upgrade')).code).toBe(0);
    expect(await Bun.file(file).exists()).toBe(false);
  });

  test('the process entry takes the registry from ANDON_HOME', async () => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'main.ts'), 'init'], {
      cwd: project,
      env: { ...process.env, ANDON_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await proc.exited).toBe(0);
    expect(await roots(registryPath(home))).toEqual({ schema: 'factory/v1', projects: [{ root: await realpath(project) }] });
  });
});
