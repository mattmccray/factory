import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archivedIds } from './archive';
import { bundleCli, installedCli } from './bundle';
import { gitIn, initRepo } from './gitrepo';
import { run } from './index';

const BASE = { schema: 'factory/v1', reviewers: ['code'], maxRound: 2, dashboard: { settleAfterHours: 24 } };
const ON = { ...BASE, archive: { enabled: true } };
const REF = 'refs/heads/factory/archive';
const SHA = '3e45678';
const HOUR = 3_600_000;
// The test clock: OLD is settled (48 h before), RECENT is not (1 h before).
const NOW = new Date('2026-10-10T00:00:00.000Z');
const OLD = new Date(NOW.getTime() - 48 * HOUR).toISOString();
const RECENT = new Date(NOW.getTime() - HOUR).toISOString();

let tmp: string;
let repo: string;
let root: string;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'factory-prune-test-')));
  repo = join(tmp, 'repo');
  root = await makeRepo(repo);
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

// A git repo on `main` with factory/config.json (archiving on) and an empty jobs/; returns factory/.
async function makeRepo(at: string): Promise<string> {
  await mkdir(at, { recursive: true });
  initRepo(at, 'main');
  gitIn(at, 'config', 'user.name', 'factory-test');
  gitIn(at, 'config', 'user.email', 'test@example.invalid');
  gitIn(at, 'config', 'commit.gpgsign', 'false');
  const factory = join(at, 'factory');
  await mkdir(join(factory, 'jobs'), { recursive: true });
  await writeFile(join(factory, 'config.json'), JSON.stringify(ON));
  return factory;
}

const writeConfig = (v: unknown): Promise<void> => writeFile(join(root, 'config.json'), JSON.stringify(v));

interface Result {
  code: number;
  out: string[];
  err: string[];
}
async function cli(...argv: string[]): Promise<Result> {
  return cliAt(root, NOW, ...argv);
}
async function cliAt(factory: string, now: Date | null, ...argv: string[]): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, { root: factory, stdout: (l) => out.push(l), stderr: (l) => err.push(l), ...(now === null ? {} : { now: () => now }) });
  return { code, out, err };
}

type Kind = 'merged' | 'abandoned' | 'review' | 'needs-human';

// A job whose log ends in `kind` at `ts`, with spec, build, a review and its screenshot, and a
// job.json rebuilt from the log.
async function seedJob(id: string, kind: Kind, ts = OLD, factory = root): Promise<string> {
  const dir = join(factory, 'jobs', id);
  await mkdir(join(dir, 'round-1', 'code'), { recursive: true });
  const claimed = '2026-09-01T00:00:00.000Z';
  const events: Record<string, unknown>[] = [{ ts: claimed, type: 'job.claimed', schema: 'factory/v1', id, maxRound: 2, brief: null, issue: null, target: 'main' }];
  if (kind === 'review') events.push({ ts, type: 'stage.entered', stage: 'spec' }, { ts, type: 'stage.entered', stage: 'build' }, { ts, type: 'round.started', round: 1, reviewers: ['code'] });
  if (kind === 'needs-human') events.push({ ts, type: 'job.escalated', reason: 'stuck' });
  if (kind === 'merged') events.push({ ts, type: 'job.merged', sha: SHA });
  if (kind === 'abandoned') events.push({ ts, type: 'job.abandoned', reason: 'no' });
  await writeFile(join(dir, 'events.jsonl'), events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  await writeFile(join(dir, 'feature.md'), 'feature\n');
  await writeFile(join(dir, 'spec.md'), 'spec\n');
  await writeFile(join(dir, 'build.md'), 'build\n');
  await writeFile(join(dir, 'round-1', 'review-code.md'), 'VERDICT: PASS\n');
  await writeFile(join(dir, 'round-1', 'code', 'shot.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
  const r = await cliAt(factory, NOW, 'rebuild', id);
  expect(r.err).toEqual([]);
  return dir;
}

async function archive(id: string): Promise<void> {
  const r = await cli('archive', id);
  expect(r.err).toEqual([]);
  expect(r.code).toBe(0);
}

const tip = (at = repo): string | null => {
  try {
    return gitIn(at, 'rev-parse', '--verify', '--quiet', REF);
  } catch {
    return null;
  }
};
const objects = (): string => gitIn(repo, 'count-objects', '-v');
const refs = (): string => gitIn(repo, 'for-each-ref');

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

// Every entry under `dir`: each file's hash, each symlink's target, each dir; a byte-for-byte check.
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const abs = join(e.parentPath, e.name);
    const rel = abs.slice(dir.length + 1);
    if (e.isDirectory()) out[`${rel}/`] = '';
    else if (e.isSymbolicLink()) out[rel] = `-> ${await readlink(abs)}`;
    else out[rel] = createHash('sha256').update(await readFile(abs)).digest('hex');
  }
  return out;
}

describe('factory prune (job 048)', () => {
  test('AC1: an archived abandoned job and a settled merged one are removed; the branch and objects are unchanged', async () => {
    await seedJob('001-gave-up', 'abandoned', RECENT); // abandoned: settled at once
    await seedJob('002-landed', 'merged', OLD);
    await archive('001-gave-up');
    await archive('002-landed');
    const before = { tip: tip(), objects: objects(), refs: refs(), head: gitIn(repo, 'rev-parse', 'HEAD'), status: gitIn(repo, 'status', '--porcelain') };

    const r = await cli('prune');
    expect(r).toEqual({ code: 0, out: ['pruned 001-gave-up', 'pruned 002-landed', 'prune: removed 2, kept 0, failed 0'], err: [] });
    expect(await present(join(root, 'jobs', '001-gave-up'))).toBe(false);
    expect(await present(join(root, 'jobs', '002-landed'))).toBe(false);
    expect({ tip: tip(), objects: objects(), refs: refs(), head: gitIn(repo, 'rev-parse', 'HEAD'), status: gitIn(repo, 'status', '--porcelain') }).toEqual(before);
    expect(await archivedIds(repo)).toEqual(['001-gave-up', '002-landed']);
  });

  test('AC2: live, unsettled, unarchived, and changed jobs are each kept byte for byte, naming the reason', async () => {
    await seedJob('001-in-review', 'review');
    await seedJob('002-stuck', 'needs-human');
    await seedJob('003-just-merged', 'merged', RECENT);
    await archive('003-just-merged');
    await seedJob('004-unarchived', 'abandoned');
    const added = await seedJob('005-added', 'merged');
    await archive('005-added');
    await writeFile(join(added, 'late.md'), 'late\n');
    const changed = await seedJob('006-changed', 'abandoned');
    await archive('006-changed');
    await writeFile(join(changed, 'round-1', 'review-code.md'), 'VERDICT: FAIL\n');
    const before = await snapshot(join(root, 'jobs'));
    const head = tip();

    const r = await cli('prune');
    expect(r).toEqual({
      code: 0,
      out: [
        'kept 001-in-review: not merged or abandoned (review)',
        'kept 002-stuck: not merged or abandoned (needs-human)',
        'kept 003-just-merged: not settled',
        'kept 004-unarchived: not archived',
        'kept 005-added: differs from its archived tree',
        'kept 006-changed: differs from its archived tree',
        'prune: removed 0, kept 6, failed 0',
      ],
      err: [],
    });
    expect(await snapshot(join(root, 'jobs'))).toEqual(before);
    expect(tip()).toBe(head);
  });

  test('AC2: with no archive branch at all, every terminal settled job is kept as not archived', async () => {
    await seedJob('001-done', 'merged');
    const r = await cli('prune');
    expect(r).toEqual({ code: 0, out: ['kept 001-done: not archived', 'prune: removed 0, kept 1, failed 0'], err: [] });
    expect(tip()).toBeNull();
  });

  test('AC3: job.json and job.json.tmp are left out of the match; a top-level .events.lock keeps the job', async () => {
    const a = await seedJob('001-snapshot-only', 'merged');
    await archive('001-snapshot-only');
    await writeFile(join(a, 'job.json'), '{"rewritten": true}\n');
    await writeFile(join(a, 'job.json.tmp'), '{"half');
    // Other lock dirs and empty dirs have no archived tree either.
    await mkdir(join(a, 'other.lock'));
    await writeFile(join(a, 'other.lock', 'held'), 'x');
    await mkdir(join(a, 'empty'));
    const b = await seedJob('002-in-flight', 'abandoned');
    await archive('002-in-flight');
    await mkdir(join(b, '.events.lock'));
    const before = await snapshot(b);

    const r = await cli('prune');
    expect(r).toEqual({ code: 0, out: ['pruned 001-snapshot-only', 'kept 002-in-flight: an event is in flight (.events.lock)', 'prune: removed 1, kept 1, failed 0'], err: [] });
    expect(await present(a)).toBe(false);
    expect(await snapshot(b)).toEqual(before);
  });

  test('a legacy job is settled by its job.json: merged with an old endedAt, or abandoned', async () => {
    const legacy = async (id: string, snap: Record<string, unknown>): Promise<string> => {
      const dir = join(root, 'jobs', id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'job.json'), JSON.stringify({ schema: 'factory/v1', id, ...snap }));
      await writeFile(join(dir, 'spec.md'), 'legacy spec\n');
      await archive(id);
      return dir;
    };
    await legacy('001-old-merged', { stage: 'merged', endedAt: OLD });
    await legacy('002-new-merged', { stage: 'merged', endedAt: RECENT });
    await legacy('003-no-ended', { stage: 'merged' });
    await legacy('004-bad-ended', { stage: 'merged', endedAt: 'yesterday' });
    await legacy('005-abandoned', { stage: 'abandoned' });
    const unreadable = join(root, 'jobs', '006-unreadable');
    await mkdir(unreadable);
    await writeFile(join(unreadable, 'spec.md'), 'x\n');

    const r = await cli('prune');
    expect(r).toEqual({
      code: 0,
      out: [
        'pruned 001-old-merged',
        'kept 002-new-merged: not settled',
        'kept 003-no-ended: not settled',
        'kept 004-bad-ended: not settled',
        'pruned 005-abandoned',
        'kept 006-unreadable: no events.jsonl and no readable job.json; not archived',
        'prune: removed 2, kept 4, failed 0',
      ],
      err: [],
    });
  });

  test('a symlinked job dir is never listed; a symlink inside a pruned dir is removed, not followed', async () => {
    const outside = join(tmp, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'keep.md'), 'keep\n');
    const dir = await seedJob('001-linked-inside', 'merged');
    await symlink(outside, join(dir, 'link'));
    await symlink(join(outside, 'keep.md'), join(dir, 'round-1', 'file-link.md'));
    await archive('001-linked-inside');
    const real = await seedJob('002-real', 'merged');
    await archive('002-real');
    await rm(real, { recursive: true });
    await symlink(outside, join(root, 'jobs', '002-real'));

    const r = await cli('prune');
    expect(r).toEqual({ code: 0, out: ['pruned 001-linked-inside', 'prune: removed 1, kept 0, failed 0'], err: [] });
    expect(await readFile(join(outside, 'keep.md'), 'utf8')).toBe('keep\n');
    expect((await lstat(join(root, 'jobs', '002-real'))).isSymbolicLink()).toBe(true);
  });

  test('a job that cannot be checked is one stderr line and a failure; the rest still run', async () => {
    const dir = await seedJob('001-unreadable', 'merged');
    await archive('001-unreadable');
    await seedJob('002-fine', 'abandoned');
    await archive('002-fine');
    await chmod(join(dir, 'round-1'), 0o000);
    try {
      const r = await cli('prune');
      expect(r.code).toBe(1);
      expect(r.err).toHaveLength(1);
      expect(r.err[0]).toStartWith('001-unreadable: ');
      expect(r.out).toEqual(['pruned 002-fine', 'prune: removed 1, kept 0, failed 1']);
    } finally {
      await chmod(join(dir, 'round-1'), 0o755);
    }
    expect(await present(join(dir, 'round-1', 'review-code.md'))).toBe(true);
    expect(await present(join(dir, '.events.lock'))).toBe(false);
  });

  test('AC4: with no archive key or enabled: false, prune says archiving is disabled and removes nothing', async () => {
    await seedJob('001-qualifies', 'abandoned');
    await archive('001-qualifies');
    const before = await snapshot(join(root, 'jobs'));
    for (const config of [BASE, { ...BASE, archive: { enabled: false } }]) {
      await writeConfig(config);
      expect(await cli('prune')).toEqual({ code: 1, out: [], err: ['archiving is disabled: config.json has no "archive": { "enabled": true }; nothing removed'] });
      expect(await snapshot(join(root, 'jobs'))).toEqual(before);
    }
  });

  test('AC4: any argument is usage: prune, checked before the archiving refusal, and removes nothing', async () => {
    await seedJob('001-qualifies', 'abandoned');
    await archive('001-qualifies');
    const before = await snapshot(join(root, 'jobs'));
    for (const argv of [['prune', '001-qualifies'], ['prune', '--all'], ['prune', '--dry-run'], ['prune', '']]) {
      expect(await cli(...argv)).toEqual({ code: 1, out: [], err: ['usage: prune'] });
    }
    await writeConfig(BASE);
    expect(await cli('prune', 'x')).toEqual({ code: 1, out: [], err: ['usage: prune'] });
    expect(await snapshot(join(root, 'jobs'))).toEqual(before);
  });

  test('AC5: a pruned id is never reused: the next claim is above every archived id', async () => {
    await seedJob('002-local', 'review');
    await seedJob('007-old', 'abandoned');
    await archive('007-old');
    expect((await cli('prune')).out).toContain('pruned 007-old');
    expect(await present(join(root, 'jobs', '007-old'))).toBe(false);
    expect(await cli('claim', 'next')).toEqual({ code: 0, out: ['008-next'], err: [] });
  });
});

describe('prune through the bundled installed CLI (AC6)', () => {
  // Built the same way in two repos: one run through the source CLI, one through factory/cli.ts.
  // The installed CLI uses the system clock, so the fixture's times are relative to it.
  async function fixture(at: string): Promise<string> {
    const factory = await makeRepo(at);
    const old = new Date(Date.now() - 48 * HOUR).toISOString();
    const recent = new Date(Date.now() - HOUR).toISOString();
    await seedJob('001-abandoned', 'abandoned', recent, factory);
    await seedJob('002-merged-old', 'merged', old, factory);
    await seedJob('003-merged-new', 'merged', recent, factory);
    await seedJob('004-live', 'review', recent, factory);
    await seedJob('005-unarchived', 'abandoned', old, factory);
    const changed = await seedJob('006-changed', 'merged', old, factory);
    for (const id of ['001-abandoned', '002-merged-old', '003-merged-new', '006-changed']) expect((await cliAt(factory, null, 'archive', id)).code).toBe(0);
    await writeFile(join(changed, 'late.md'), 'late\n');
    return factory;
  }

  test('the same output, exit codes, and removals as the source; the bundle is byte-reproducible', async () => {
    const [first, second] = await Promise.all([bundleCli(), bundleCli()]);
    expect(first).toBe(second);

    const src = await fixture(join(tmp, 'source'));
    const inst = await fixture(join(tmp, 'installed'));
    await writeFile(join(inst, 'cli.ts'), await installedCli());
    const spawn = async (...args: string[]): Promise<Result> => {
      const p = Bun.spawn([process.execPath, join(inst, 'cli.ts'), ...args], { cwd: tmp, stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      const lines = (t: string): string[] => t.split('\n').filter((l) => l !== '');
      return { code, out: lines(out), err: lines(err) };
    };

    const want = {
      code: 0,
      out: [
        'pruned 001-abandoned',
        'pruned 002-merged-old',
        'kept 003-merged-new: not settled',
        'kept 004-live: not merged or abandoned (review)',
        'kept 005-unarchived: not archived',
        'kept 006-changed: differs from its archived tree',
        'prune: removed 2, kept 4, failed 0',
      ],
      err: [],
    };
    expect(await cliAt(src, null, 'prune')).toEqual(want);
    expect(await spawn('prune')).toEqual(want);
    expect(await readdir(join(inst, 'jobs'))).toEqual(await readdir(join(src, 'jobs')));
    expect(tip(join(tmp, 'installed'))).not.toBeNull();

    expect(await spawn('prune', 'x')).toEqual(await cliAt(src, null, 'prune', 'x'));
    await writeFile(join(src, 'config.json'), JSON.stringify(BASE));
    await writeFile(join(inst, 'config.json'), JSON.stringify(BASE));
    const off = await spawn('prune');
    expect(off).toEqual(await cliAt(src, null, 'prune'));
    expect(off.code).toBe(1);
  });
});
