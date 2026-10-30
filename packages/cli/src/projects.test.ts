import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRegistry, registryPath } from '@factory/contract';
import { bundleCli } from './bundle';
import { USAGE as CORE_USAGE, runCore } from './core';
import { run, USAGE } from './index';
import { PROJECTS_USAGE, projects, rootState, volumePrefix, volumeUnmounted } from './projects';
import type { PathInfo, Probe } from './projects';

let tmp: string;
let home: string;
let file: string;
let ok: string;
let gone: string;
let plain: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'factory-projects-'));
  home = join(tmp, 'andon');
  file = registryPath(home);
  ok = join(tmp, 'ok');
  gone = join(tmp, 'gone');
  plain = join(tmp, 'plain');
  await mkdir(join(ok, 'factory'), { recursive: true });
  await mkdir(plain);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

interface Result {
  code: number;
  out: string[];
  err: string[];
}
async function cli(...argv: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { root: join(tmp, 'nowhere', 'factory'), registry: file, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out, err };
}
async function seed(...roots: string[]): Promise<string> {
  const text = `${JSON.stringify({ schema: 'factory/v1', projects: roots.map((root) => ({ root })) }, null, 2)}\n`;
  await mkdir(home, { recursive: true });
  await writeFile(file, text);
  return text;
}
const listed = async (): Promise<string[]> => parseRegistry(JSON.parse(await readFile(file, 'utf8'))).projects.map((p) => p.root);

describe('projects lists every root with its state (AC1)', () => {
  test('ok, missing, and not a factory project, in registry order; the file is unchanged', async () => {
    const before = await seed(ok, gone, plain);
    expect(await cli('projects')).toEqual({ code: 0, out: [`ok  ${ok}`, `missing  ${gone}`, `not a factory project  ${plain}`], err: [] });
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  test('a factory file that is not a directory is not a factory project', async () => {
    await writeFile(join(plain, 'factory'), 'x');
    await seed(plain);
    expect((await cli('projects')).out).toEqual([`not a factory project  ${plain}`]);
  });
});

describe('projects prune (AC2)', () => {
  test('--dry-run names exactly the two dead roots and writes nothing', async () => {
    const before = await seed(ok, gone, plain);
    const mtime = (await stat(file)).mtimeMs;
    expect(await cli('projects', 'prune', '--dry-run')).toEqual({
      code: 0,
      out: [`would remove ${gone} (missing)`, `would remove ${plain} (not a factory project)`],
      err: [],
    });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(mtime);
  });

  test('prune removes the two dead roots and keeps the ok one', async () => {
    await seed(ok, gone, plain);
    expect(await cli('projects', 'prune')).toEqual({
      code: 0,
      out: [`removed ${gone} (missing)`, `removed ${plain} (not a factory project)`],
      err: [],
    });
    expect(await listed()).toEqual([ok]);
    expect(await readdir(home)).toEqual(['projects.json']);
  });

  test('nothing dead prints one line and writes nothing', async () => {
    const before = await seed(ok);
    expect(await cli('projects', 'prune')).toEqual({ code: 0, out: ['nothing to prune'], err: [] });
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});

// An in-memory filesystem: each listed path exists with its device id; anything else is missing.
function fakeFs(entries: Record<string, number | { dev: number; dir: boolean }>): Probe {
  return async (path) => {
    const e = entries[path];
    if (e === undefined) return null;
    const info: PathInfo = typeof e === 'number' ? { dev: e, dir: true } : e;
    return info;
  };
}

describe('removable volumes (AC3)', () => {
  test('volumePrefix covers /Volumes/<name>, /media/…, /run/media/…, /mnt/<name>, and nothing else', () => {
    expect(volumePrefix('/Volumes/Disk/p')).toBe('/Volumes');
    expect(volumePrefix('/Volumes/Disk')).toBe('/Volumes');
    expect(volumePrefix('/media/user/disk/p')).toBe('/media');
    expect(volumePrefix('/run/media/user/disk/p')).toBe('/run/media');
    expect(volumePrefix('/mnt/data/p')).toBe('/mnt');
    expect(volumePrefix('/Volumes')).toBeNull();
    expect(volumePrefix('/mnt')).toBeNull();
    expect(volumePrefix('/Users/me/p')).toBeNull();
    expect(volumePrefix('/VolumesX/p')).toBeNull();
    expect(volumePrefix('/srv/media/p')).toBeNull();
  });

  const roots = ['/Volumes/Disk/p', '/media/user/disk/p', '/run/media/user/disk/p', '/mnt/data/p'];
  for (const root of roots) {
    const prefix = volumePrefix(root) ?? '';
    test(`${root}: unmounted when nothing below ${prefix} exists or changes device`, async () => {
      expect(await volumeUnmounted(root, fakeFs({ [prefix]: 1 }))).toBe(true);
      // A leftover mount directory on the same device is not a mount point.
      const parts = root.split('/');
      const volume = parts.slice(0, -1).join('/');
      expect(await volumeUnmounted(root, fakeFs({ [prefix]: 1, [volume]: 1, '/media/user': 1, '/run/media/user': 1 }))).toBe(true);
    });
    test(`${root}: mounted when a directory below ${prefix} is on another device`, async () => {
      const volume = root.split('/').slice(0, -1).join('/');
      expect(await volumeUnmounted(root, fakeFs({ [prefix]: 1, '/media/user': 1, '/run/media/user': 1, [volume]: 2 }))).toBe(false);
    });
  }

  test('a root outside every prefix is never on an unmounted volume', async () => {
    expect(await volumeUnmounted('/srv/gone', fakeFs({}))).toBe(false);
  });

  test('rootState uses the probe', async () => {
    const probe = fakeFs({ '/a': 1, '/a/factory': 1, '/b': 1, '/c': 1, '/c/factory': { dev: 1, dir: false } });
    expect(await rootState('/a', probe)).toBe('ok');
    expect(await rootState('/b', probe)).toBe('not a factory project');
    expect(await rootState('/c', probe)).toBe('not a factory project');
    expect(await rootState('/d', probe)).toBe('missing');
  });

  test('prune skips a root on an unmounted volume, removes a dead root on a mounted one, and handles the rest', async () => {
    const unmounted = '/Volumes/Gone/p';
    const mountedDead = '/Volumes/Here/dead';
    const before = await seed(unmounted, mountedDead, '/srv/gone', '/srv/live');
    const probe = fakeFs({ '/Volumes': 1, '/Volumes/Here': 2, '/srv': 1, '/srv/live': 1, '/srv/live/factory': 1 });
    const run = async (rest: string[]): Promise<string[]> => {
      const out: string[] = [];
      expect(await projects(rest, { registry: file, stdout: (l) => out.push(l), probe })).toBe(0);
      return out;
    };

    const list = await run([]);
    expect(list).toEqual([`missing  ${unmounted}  (volume not mounted)`, `missing  ${mountedDead}`, 'missing  /srv/gone', 'ok  /srv/live']);

    expect(await run(['prune', '--dry-run'])).toEqual([
      `skipped ${unmounted}: volume not mounted`,
      `would remove ${mountedDead} (missing)`,
      'would remove /srv/gone (missing)',
    ]);
    expect(await readFile(file, 'utf8')).toBe(before);

    expect(await run(['prune'])).toEqual([`skipped ${unmounted}: volume not mounted`, `removed ${mountedDead} (missing)`, 'removed /srv/gone (missing)']);
    expect(await listed()).toEqual([unmounted, '/srv/live']);
  });
});

describe('projects remove (AC4)', () => {
  test('removes exactly that root, even an ok one', async () => {
    await seed(ok, gone, plain);
    expect(await cli('projects', 'remove', ok)).toEqual({ code: 0, out: [`removed ${ok}`], err: [] });
    expect(await listed()).toEqual([gone, plain]);
    expect(await cli('projects', 'remove', `${gone}/`)).toEqual({ code: 0, out: [`removed ${gone}`], err: [] });
    expect(await listed()).toEqual([plain]);
  });

  test('a relative path is resolved against the cwd and normalized, not realpathed', async () => {
    await seed(ok, gone);
    const out: string[] = [];
    expect(await projects(['remove', './x/../gone'], { registry: file, stdout: (l) => out.push(l), cwd: tmp })).toBe(0);
    expect(out).toEqual([`removed ${gone}`]);
    expect(await listed()).toEqual([ok]);
  });

  test('a path not listed prints not registered and writes nothing', async () => {
    const before = await seed(ok);
    const mtime = (await stat(file)).mtimeMs;
    expect(await cli('projects', 'remove', gone)).toEqual({ code: 0, out: [`not registered: ${gone}`], err: [] });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(mtime);
  });

  test('with no registry, not registered and no file is created', async () => {
    expect(await cli('projects', 'remove', gone)).toEqual({ code: 0, out: [`not registered: ${gone}`], err: [] });
    expect(await Bun.file(home).exists()).toBe(false);
  });
});

describe('empty and invalid registries (AC5)', () => {
  test('a missing registry: no projects registered, nothing created', async () => {
    expect(await cli('projects')).toEqual({ code: 0, out: ['no projects registered'], err: [] });
    expect(await cli('projects', 'prune')).toEqual({ code: 0, out: ['no projects registered'], err: [] });
    expect(await cli('projects', 'prune', '--dry-run')).toEqual({ code: 0, out: ['no projects registered'], err: [] });
    expect(await Bun.file(home).exists()).toBe(false);
  });

  test('an empty registry: no projects registered, nothing written', async () => {
    const before = await seed();
    const mtime = (await stat(file)).mtimeMs;
    expect(await cli('projects')).toEqual({ code: 0, out: ['no projects registered'], err: [] });
    expect(await cli('projects', 'prune')).toEqual({ code: 0, out: ['no projects registered'], err: [] });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(mtime);
    expect(await readdir(home)).toEqual(['projects.json']);
  });

  const invalid: Record<string, string> = {
    'a bad schema': JSON.stringify({ schema: 'factory/v2', projects: [] }),
    'an unknown key': JSON.stringify({ schema: 'factory/v1', projects: [], extra: 1 }),
    'not JSON': '{',
  };
  for (const [name, text] of Object.entries(invalid)) {
    test(`${name}: every subcommand exits 1 with one stderr line and writes nothing`, async () => {
      await mkdir(home, { recursive: true });
      await writeFile(file, text);
      const mtime = (await stat(file)).mtimeMs;
      for (const argv of [['projects'], ['projects', 'prune'], ['projects', 'prune', '--dry-run'], ['projects', 'remove', gone]]) {
        const r = await cli(...argv);
        expect(r.code).toBe(1);
        expect(r.out).toEqual([]);
        expect(r.err.length).toBe(1);
        expect(r.err[0]).toStartWith('registry:');
      }
      expect(await readFile(file, 'utf8')).toBe(text);
      expect((await stat(file)).mtimeMs).toBe(mtime);
      expect(await readdir(home)).toEqual(['projects.json']);
    });
  }
});

describe('usage (AC6)', () => {
  const bad = [
    ['projects', 'frobnicate'],
    ['projects', 'prune', '--force'],
    ['projects', 'prune', '--dry-run', 'x'],
    ['projects', 'remove'],
    ['projects', 'remove', ''],
    ['projects', 'remove', 'a', 'b'],
    ['projects', 'list'],
  ];
  for (const argv of bad) {
    test(`${argv.join(' ')} is a usage error that writes nothing`, async () => {
      const before = await seed(ok, gone);
      expect(await cli(...argv)).toEqual({ code: 1, out: [], err: [PROJECTS_USAGE] });
      expect(await readFile(file, 'utf8')).toBe(before);
    });
  }

  test('a usage error with no registry creates nothing', async () => {
    expect((await cli('projects', 'nope')).code).toBe(1);
    expect(await Bun.file(home).exists()).toBe(false);
  });

  test('the usage line, and the top-level lines are unchanged', () => {
    expect(USAGE.projects).toBe('usage: projects [prune [--dry-run] | remove <path>]');
    expect(USAGE.all).toBe('usage: claim <slug> [k=v …] | event <id> <type> [k=v …] | rebuild <id>|--all | show <id>');
    // `projects` is not on the top-level line; ` | --version` comes from 060-cli-global-install.
    expect(USAGE.source).toBe(`${USAGE.all} | doctor | init [--force] | upgrade [--force] | --version`);
  });

  test('the installed CLI does not offer projects', async () => {
    await mkdir(join(tmp, 'factory'));
    await writeFile(join(tmp, 'factory', 'config.json'), JSON.stringify({ schema: 'factory/v1', reviewers: ['code'], maxRound: 2, dashboard: { settleAfterHours: 24 } }));
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCore(['projects'], { root: join(tmp, 'factory'), registry: file, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
    expect({ code, out, err }).toEqual({ code: 1, out: [], err: [CORE_USAGE.all] });
    const bundle = await bundleCli();
    expect(bundle).not.toContain(PROJECTS_USAGE);
    expect(bundle).not.toContain('volume not mounted');
  });
});
