import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTarget } from './git';
import { gitIn, initRepo } from './gitrepo';

let repo: string;
beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'factory-git-')));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('resolveTarget', () => {
  test('current is the checkout branch', async () => {
    initRepo(repo, 'master');
    expect(await resolveTarget(repo, 'current')).toBe('master');
    gitIn(repo, 'checkout', '--quiet', '-b', 'feature/x');
    expect(await resolveTarget(repo, 'current')).toBe('feature/x');
  });

  test('a branch name must exist, whatever the checkout is on', async () => {
    initRepo(repo, 'main');
    gitIn(repo, 'branch', 'develop');
    expect(await resolveTarget(repo, 'develop')).toBe('develop');
    await expect(resolveTarget(repo, 'release')).rejects.toThrow("merge.target 'release': no branch refs/heads/release");
  });

  test('a checkout branch with shell metacharacters is refused, even when it exists', async () => {
    initRepo(repo, 'main');
    for (const name of ["a'b", 'x$(id)', 'a;b']) {
      gitIn(repo, 'checkout', '--quiet', '-b', name);
      let message = '';
      try {
        await resolveTarget(repo, 'current');
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toMatch(/^merge\.target 'current': branch ".*" is not an allowed target name/);
      expect(message).not.toContain('\n');
    }
  });

  test('an inherited GIT_DIR does not redirect resolution', async () => {
    initRepo(repo, 'master');
    const before = process.env.GIT_DIR;
    process.env.GIT_DIR = join(repo, 'nowhere');
    try {
      expect(await resolveTarget(repo, 'current')).toBe('master');
    } finally {
      if (before === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = before;
    }
  });

  test('a detached HEAD refuses current with a one-line reason', async () => {
    initRepo(repo, 'main');
    gitIn(repo, 'checkout', '--quiet', '--detach');
    await expect(resolveTarget(repo, 'current')).rejects.toThrow(/detached HEAD/);
  });

  test('a directory that is not a repo is a one-line git failure', async () => {
    let message = '';
    try {
      await resolveTarget(repo, 'current');
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/^merge\.target 'current': git failed/);
    expect(message).not.toContain('\n');
  });
});
