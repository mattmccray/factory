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
