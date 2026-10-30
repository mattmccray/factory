import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitIn } from '../packages/cli/src/gitrepo';
import { type BuildBundle, release } from './release';
import { installLine, releasePush } from './release-push';

// 060 AC6: `bun run release:push` against a local bare `origin`, never the real one.
let root: string;
let repo: string;
let origin: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'factory-release-push-')));
  repo = join(root, 'repo');
  origin = join(root, 'origin.git');
  await mkdir(repo);
  gitIn(root, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const fakeBuild: BuildBundle = (_tree, out) => {
  mkdirSync(join(out, 'bin'));
  writeFileSync(join(out, 'bin', 'factory.js'), '#!/usr/bin/env bun\n');
  writeFileSync(join(out, 'package.json'), '{ "name": "factory", "bin": { "factory": "bin/factory.js" } }\n');
};

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), text);
}
let n = 0;
async function commit(subject: string): Promise<void> {
  n += 1;
  await put(`notes/${n}.txt`, `${n}\n`);
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '--quiet', '-m', subject);
}

/** A repo on `main` with v0.1.0 pushed to origin, then a cut v0.2.0 (both tags) that is not. */
async function cutRelease(): Promise<void> {
  gitIn(repo, 'init', '--quiet', '--initial-branch=main');
  for (const [k, v] of [
    ['user.name', 'factory-test'],
    ['user.email', 'test@example.invalid'],
    ['commit.gpgsign', 'false'],
    ['tag.gpgsign', 'false'],
  ]) gitIn(repo, 'config', k ?? '', v ?? '');
  await put('package.json', '{\n  "name": "factory",\n  "version": "0.1.0"\n}\n');
  await put('packages/templates/package.json', '{\n  "name": "@factory/templates",\n  "version": "0.1.0"\n}\n');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '--quiet', '-m', 'chore: seed');
  gitIn(repo, 'tag', '-a', 'v0.1.0', '-m', 'factory v0.1.0');
  gitIn(repo, 'remote', 'add', 'origin', origin);
  gitIn(repo, 'push', '--quiet', 'origin', 'main', 'v0.1.0');
  gitIn(repo, 'branch', 'factory/archive');
  await commit('feat(cli): add c');
  const r = release(repo, { dryRun: false, today: '2026-10-30', build: fakeBuild });
  if (r.code !== 0) throw new Error(r.out);
  await commit('chore(factory): promote v0.2.0');
}

const remoteRefs = (): string => {
  const p = Bun.spawnSync(['git', '-C', origin, 'for-each-ref', '--format=%(refname) %(objectname)'], { stdout: 'pipe' });
  return p.stdout.toString().trim();
};

describe('release:push (AC6)', () => {
  test('pushes main, release, vX.Y.Z, and release-vX.Y.Z atomically, prints them and the install line; a second run says nothing to push', async () => {
    await cutRelease();
    const r = releasePush(repo);
    expect(r).toEqual({ code: 0, out: 'pushed main\npushed release\npushed v0.2.0\npushed release-v0.2.0\ninstall: bun add -g github:mattmccray/factory#release-v0.2.0\n' });
    expect(installLine('0.2.0')).toBe('bun add -g github:mattmccray/factory#release-v0.2.0');
    for (const ref of ['refs/heads/main', 'refs/heads/release', 'refs/tags/v0.2.0', 'refs/tags/release-v0.2.0']) {
      expect(gitIn(origin, 'rev-parse', ref)).toBe(gitIn(repo, 'rev-parse', ref));
    }
    expect(remoteRefs()).not.toContain('refs/heads/factory/');

    const before = remoteRefs();
    const again = releasePush(repo);
    expect(again.code).not.toBe(0);
    expect(again.out.trimEnd().split('\n')).toHaveLength(1);
    expect(again.out).toContain('nothing to push');
    expect(remoteRefs()).toBe(before);
  });

  test('the script runs from the command line', async () => {
    await cutRelease();
    const p = Bun.spawnSync([process.execPath, join(import.meta.dir, 'release-push.ts')], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toContain('install: bun add -g github:mattmccray/factory#release-v0.2.0');
  });

  describe('each refusal pushes nothing and prints one line', () => {
    async function refuses(reason: RegExp): Promise<void> {
      const before = remoteRefs();
      const r = releasePush(repo);
      expect(r.code).not.toBe(0);
      expect(r.out.trimEnd().split('\n')).toHaveLength(1);
      expect(r.out).toMatch(reason);
      expect(remoteRefs()).toBe(before);
    }

    test('off main', async () => {
      await cutRelease();
      gitIn(repo, 'checkout', '--quiet', '-b', 'feature');
      await refuses(/not on main.*feature/);
    });

    test('detached', async () => {
      await cutRelease();
      gitIn(repo, 'checkout', '--quiet', '--detach', 'HEAD');
      await refuses(/not on main.*detached HEAD/);
    });

    test('a dirty tree', async () => {
      await cutRelease();
      await put('stray.txt', 'x\n');
      await refuses(/working tree is dirty/);
    });

    test('the newest v* tag without its release-v* tag', async () => {
      await cutRelease();
      gitIn(repo, 'tag', '-d', 'release-v0.2.0');
      await refuses(/v0\.2\.0 has no release-v0\.2\.0 tag/);
    });

    test('origin/main ahead of the local main', async () => {
      await cutRelease();
      const other = join(root, 'other');
      gitIn(root, 'clone', '--quiet', origin, other);
      writeFileSync(join(other, 'theirs.txt'), 'x\n');
      gitIn(other, 'add', '-A');
      gitIn(other, '-c', 'user.name=o', '-c', 'user.email=o@example.invalid', 'commit', '--quiet', '-m', 'chore: theirs');
      gitIn(other, 'push', '--quiet', 'origin', 'main');
      await refuses(/origin\/main has commits the local main lacks/);
    });
  });
});
