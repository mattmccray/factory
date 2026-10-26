import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitIn, initRepo } from './gitrepo';
import { USAGE, run } from './index';

const CONFIG = { schema: 'factory/v1', reviewers: ['code'], maxRound: 2, dashboard: { settleAfterHours: 24 } };
const ID = '001-example';
const BRANCH = `factory/${ID}`;

// `repo` is a git repo (the main checkout); `root` its factory/; the job has a worktree on BRANCH.
let repo: string;
let root: string;
let worktree: string;
beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'factory-abandon-')));
  initRepo(repo, 'main');
  root = join(repo, 'factory');
  worktree = join(root, '.worktrees', ID);
  await mkdir(root);
  await writeFile(join(root, 'config.json'), JSON.stringify(CONFIG));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

interface Result {
  code: number;
  out: string[];
  err: string[];
}
async function cli(...argv: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { root, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out, err };
}

const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
const hasBranch = (name: string): boolean => gitIn(repo, 'branch', '--list', name) !== '';
const logText = (): Promise<string> => readFile(join(root, 'jobs', ID, 'events.jsonl'), 'utf8');
const lastEvent = async (): Promise<unknown> => JSON.parse((await logText()).trim().split('\n').at(-1) ?? '');

// Every file under jobs/, with its bytes, so a rejection can be checked as a byte-for-byte no-op.
async function snapshotJobs(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = join(dir, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        out[`${r}/`] = '';
        await walk(p, r);
      } else out[r] = await readFile(p, 'utf8');
    }
  };
  await walk(join(root, 'jobs'), 'jobs');
  return out;
}

async function event(...args: string[]): Promise<void> {
  const r = await cli('event', ID, ...args);
  if (r.code !== 0) throw new Error(`event ${args.join(' ')}: ${r.err.join(' ')}`);
}

// Claims the job, makes its worktree and branch, and drives it to `build`.
async function toBuild(): Promise<void> {
  const claimed = await cli('claim', 'example');
  if (claimed.code !== 0 || claimed.out[0] !== ID) throw new Error(`claim: ${claimed.err.join(' ')}`);
  await event('stage.entered', 'stage=spec');
  gitIn(repo, 'worktree', 'add', '--quiet', '-b', BRANCH, 'factory/.worktrees/' + ID, 'main');
  await event('stage.entered', 'stage=build');
  await event('agent.started', 'role=builder', `name=builder-${ID}`);
}
async function toNeedsHuman(): Promise<void> {
  await toBuild();
  await event('job.escalated', 'reason=stuck');
}

describe('abandon from needs-human', () => {
  test('exits 0, prints abandoned, removes the worktree, keeps the branch, and logs job.abandoned', async () => {
    await toNeedsHuman();
    expect(await exists(worktree)).toBe(true);
    expect(await cli('abandon', ID, 'why')).toEqual({ code: 0, out: ['abandoned'], err: [] });
    expect(await exists(worktree)).toBe(false);
    expect(hasBranch(BRANCH)).toBe(true);
    expect(await lastEvent()).toMatchObject({ type: 'job.abandoned', reason: 'why' });
    const snap: unknown = JSON.parse(await readFile(join(root, 'jobs', ID, 'job.json'), 'utf8'));
    expect(snap).toMatchObject({ stage: 'abandoned', note: 'why', stoppedBy: 'escalated', stoppedFrom: 'build' });
    expect(gitIn(repo, 'worktree', 'list', '--porcelain')).not.toContain(`.worktrees/${ID}`);
  });

  test('with --delete-branch, the branch is gone too', async () => {
    await toNeedsHuman();
    expect(await cli('abandon', ID, 'why', '--delete-branch')).toEqual({ code: 0, out: ['abandoned'], err: [] });
    expect(await exists(worktree)).toBe(false);
    expect(hasBranch(BRANCH)).toBe(false);
  });

  test('a worktree with uncommitted changes is still removed', async () => {
    await toNeedsHuman();
    await writeFile(join(worktree, 'scratch.txt'), 'dirty\n');
    expect((await cli('abandon', ID, 'why')).code).toBe(0);
    expect(await exists(worktree)).toBe(false);
  });

  test('a missing worktree is not an error', async () => {
    await toNeedsHuman();
    gitIn(repo, 'worktree', 'remove', '--force', `factory/.worktrees/${ID}`);
    expect(await cli('abandon', ID, 'why')).toEqual({ code: 0, out: ['abandoned'], err: [] });
    expect(hasBranch(BRANCH)).toBe(true);
  });

  test('a missing worktree and branch with --delete-branch is not an error', async () => {
    await toNeedsHuman();
    gitIn(repo, 'worktree', 'remove', '--force', `factory/.worktrees/${ID}`);
    gitIn(repo, 'branch', '-D', BRANCH);
    expect(await cli('abandon', ID, 'why', '--delete-branch')).toEqual({ code: 0, out: ['abandoned'], err: [] });
  });

  test('the flags may come in either order', async () => {
    await toNeedsHuman();
    expect(await cli('abandon', ID, 'why', '--delete-branch', '--force')).toEqual({ code: 0, out: ['abandoned'], err: [] });
    expect(hasBranch(BRANCH)).toBe(false);
  });
});

describe('abandon from a working stage', () => {
  test('from build, exits 1 without --force and writes nothing; with --force it succeeds', async () => {
    await toBuild();
    const before = await snapshotJobs();
    const r = await cli('abandon', ID, 'why');
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toMatch(/force/);
    expect(await snapshotJobs()).toEqual(before);
    expect(await exists(worktree)).toBe(true);

    expect(await cli('abandon', ID, 'why', '--force')).toEqual({ code: 0, out: ['abandoned'], err: [] });
    expect(await exists(worktree)).toBe(false);
    expect(hasBranch(BRANCH)).toBe(true);
    const last = await lastEvent();
    expect(last).toMatchObject({ type: 'job.abandoned', reason: 'why' });
    expect(typeof last === 'object' && last !== null && 'force' in last).toBe(false);
  });

  test('event <id> job.abandoned reason=x from build is rejected', async () => {
    await toBuild();
    const before = await snapshotJobs();
    const r = await cli('event', ID, 'job.abandoned', 'reason=x');
    expect(r.code).toBe(1);
    expect(r.err).toHaveLength(1);
    expect(await snapshotJobs()).toEqual(before);
  });

  test('event <id> job.abandoned reason=x from needs-human is accepted', async () => {
    await toNeedsHuman();
    expect(await cli('event', ID, 'job.abandoned', 'reason=x')).toEqual({ code: 0, out: ['abandoned'], err: [] });
  });
});

describe('abandon on a terminal job', () => {
  test('a second abandon exits 1 and writes nothing, with or without --force', async () => {
    await toNeedsHuman();
    await cli('abandon', ID, 'why');
    const before = await snapshotJobs();
    for (const argv of [['abandon', ID, 'again'], ['abandon', ID, 'again', '--force']]) {
      const r = await cli(...argv);
      expect(r.code).toBe(1);
      expect(r.err).toHaveLength(1);
      expect(r.err[0]).toMatch(/terminal/);
    }
    expect(await snapshotJobs()).toEqual(before);
  });
});

describe('abandon usage and rejections', () => {
  const usage = async (argv: string[]): Promise<void> => {
    const before = await snapshotJobs();
    expect(await cli(...argv)).toEqual({ code: 1, out: [], err: [USAGE.abandon] });
    expect(await snapshotJobs()).toEqual(before);
    expect(await exists(worktree)).toBe(true);
  };
  beforeEach(toNeedsHuman);

  test('the usage line', () => {
    expect(USAGE.abandon).toBe('usage: abandon <id> "<reason>" [--force] [--delete-branch]');
  });
  test('no id', () => usage(['abandon']));
  test('a missing reason', () => usage(['abandon', ID]));
  test('an empty reason', () => usage(['abandon', ID, '']));
  test('an unknown flag', () => usage(['abandon', ID, 'why', '--keep']));
  test('a repeated flag', () => usage(['abandon', ID, 'why', '--force', '--force']));
  test('an extra argument', () => usage(['abandon', ID, 'why', 'more']));

  test('a malformed id exits 1 with one line, and nothing is written', async () => {
    const before = await snapshotJobs();
    for (const id of ['../x', 'BAD', `${ID}/..`]) {
      const r = await cli('abandon', id, 'why');
      expect(r.code).toBe(1);
      expect(r.out).toEqual([]);
      expect(r.err).toHaveLength(1);
      expect(r.err[0]).toMatch(/job id/);
    }
    expect(await snapshotJobs()).toEqual(before);
    expect(await exists(worktree)).toBe(true);
  });

  test('an unknown job exits 1 and creates nothing', async () => {
    const before = await snapshotJobs();
    const r = await cli('abandon', '099-missing', 'why');
    expect(r.code).toBe(1);
    expect(r.err).toHaveLength(1);
    expect(await snapshotJobs()).toEqual(before);
  });
});

describe('abandon cleanup failure', () => {
  test('a worktree git cannot remove exits 1 naming what was left behind; the job stays abandoned', async () => {
    await toNeedsHuman();
    // A directory at the worktree path that git doesn't know as a worktree.
    gitIn(repo, 'worktree', 'remove', '--force', `factory/.worktrees/${ID}`);
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, 'stray.txt'), 'x\n');
    const r = await cli('abandon', ID, 'why', '--delete-branch');
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toContain(`factory/.worktrees/${ID}`);
    expect(r.err[0]).not.toContain('\n');
    expect(await lastEvent()).toMatchObject({ type: 'job.abandoned', reason: 'why' });
    expect(JSON.parse(await readFile(join(root, 'jobs', ID, 'job.json'), 'utf8'))).toMatchObject({ stage: 'abandoned' });
  });
});
