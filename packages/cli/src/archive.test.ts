import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archivedIds } from './archive';
import { gitIn, initRepo } from './gitrepo';
import { run } from './index';

const BASE = { schema: 'factory/v1', reviewers: ['code'], maxRound: 2, dashboard: { settleAfterHours: 24 } };
const ON = { ...BASE, archive: { enabled: true } };
const REF = 'refs/heads/factory/archive';
const OLD_REF = 'refs/heads/factory/jobs';
const SHA = '3e45678';

// `repo` is the main checkout (a git repo); `root` its factory/.
let repo: string;
let root: string;
beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'factory-archive-test-')));
  initRepo(repo, 'main');
  gitIn(repo, 'config', 'user.name', 'factory-test');
  gitIn(repo, 'config', 'user.email', 'test@example.invalid');
  gitIn(repo, 'config', 'commit.gpgsign', 'false');
  root = join(repo, 'factory');
  await mkdir(join(root, 'jobs'), { recursive: true });
  await writeConfig(ON);
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const writeConfig = (v: unknown): Promise<void> => writeFile(join(root, 'config.json'), JSON.stringify(v));

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

type Kind = 'merged' | 'abandoned' | 'review' | 'needs-human' | 'claimed';

// A job whose log ends in `kind`, with the usual files: spec, build, a review and its screenshot,
// a lock dir, and a job.json rebuilt from the log.
async function seedJob(id: string, kind: Kind, ts = '2026-10-01T00:00:00.000Z'): Promise<string> {
  const dir = join(root, 'jobs', id);
  await mkdir(join(dir, 'round-1', 'code'), { recursive: true });
  const events: Record<string, unknown>[] = [
    { ts, type: 'job.claimed', schema: 'factory/v1', id, maxRound: 2, brief: null, issue: null, target: 'main' },
  ];
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
  const r = await cli('rebuild', id);
  expect(r.err).toEqual([]);
  // A lock dir left behind (as a crashed writer would) is never archived.
  await mkdir(join(dir, '.events.lock'));
  await writeFile(join(dir, '.events.lock', 'held'), 'x');
  return dir;
}

const tip = (): string | null => {
  try {
    return gitIn(repo, 'rev-parse', '--verify', '--quiet', REF);
  } catch {
    return null;
  }
};
const files = (rev: string): string[] => gitIn(repo, 'ls-tree', '-r', '--name-only', rev).split('\n').filter((l) => l !== '').sort();
const commits = (): string[] => gitIn(repo, 'rev-list', REF).split('\n').filter((l) => l !== '');
const checkoutState = (): { status: string; index: string; head: string } => ({
  status: gitIn(repo, 'status', '--porcelain', '--untracked-files=all'),
  index: gitIn(repo, 'write-tree'),
  head: gitIn(repo, 'rev-parse', 'HEAD'),
});
const JOB_FILES = ['build.md', 'events.jsonl', 'feature.md', 'round-1/code/shot.png', 'round-1/review-code.md', 'spec.md'];

async function isDirOnDisk(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

describe('factory archive (job 045)', () => {
  test('AC1: a merged job makes the orphan branch with one parentless commit and leaves the checkout alone', async () => {
    // Give the checkout a tracked, a staged, and an untracked change, so a touch would show.
    await writeFile(join(repo, 'tracked.txt'), 'a\n');
    gitIn(repo, 'add', 'tracked.txt');
    gitIn(repo, 'commit', '--quiet', '-m', 'tracked');
    await writeFile(join(repo, 'tracked.txt'), 'b\n');
    await writeFile(join(repo, 'staged.txt'), 's\n');
    gitIn(repo, 'add', 'staged.txt');
    await writeFile(join(repo, 'untracked.txt'), 'u\n');
    const id = '001-merged';
    const dir = await seedJob(id, 'merged');
    const before = checkoutState();
    expect(tip()).toBeNull();

    const r = await cli('archive', id);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    const head = tip();
    if (head === null) throw new Error('no archive branch');
    expect(r.out).toEqual([`archived ${id} ${head.slice(0, 7)}`]);
    expect(commits()).toEqual([head]);
    expect(gitIn(repo, 'rev-list', '--parents', '-n', '1', REF)).toBe(head); // no parent
    expect(gitIn(repo, 'ls-tree', '--name-only', REF)).toBe(id);
    expect(files(REF)).toEqual(JOB_FILES.map((f) => `${id}/${f}`));
    expect(gitIn(repo, 'log', '-1', '--format=%B', REF)).toBe(`chore(factory): archive job ${id}\n\nFactory-Job: ${id}\nMerged-As: ${SHA}`);
    expect(gitIn(repo, 'cat-file', 'blob', `${REF}:${id}/events.jsonl`)).toBe((await readFile(join(dir, 'events.jsonl'), 'utf8')).trim());
    const png = Bun.spawnSync(['git', '-C', repo, 'cat-file', 'blob', `${REF}:${id}/round-1/code/shot.png`]).stdout;
    expect([...png]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    expect(checkoutState()).toEqual(before);
  });

  test('job 046 AC1/AC3: the archive is refs/heads/factory/archive, never factory/jobs, and bare git log names it', async () => {
    const id = '001-renamed';
    await seedJob(id, 'merged');
    expect((await cli('archive', id)).code).toBe(0);
    const head = tip();
    if (head === null) throw new Error('no archive branch');
    expect(gitIn(repo, 'ls-tree', '--name-only', REF)).toBe(id);
    expect(gitIn(repo, 'log', '-1', '--format=%B', REF)).toBe(`chore(factory): archive job ${id}\n\nFactory-Job: ${id}\nMerged-As: ${SHA}`);
    expect(gitIn(repo, 'for-each-ref', '--format=%(refname)', OLD_REF)).toBe('');
    // factory/jobs/ is on disk, and bare `git log factory/archive` is still unambiguous.
    expect(await isDirOnDisk(join(repo, 'factory', 'jobs', id))).toBe(true);
    const log = Bun.spawnSync(['git', '-C', repo, 'log', '--format=%H %s', 'factory/archive'], { stdout: 'pipe', stderr: 'pipe' });
    expect(log.stderr.toString()).not.toContain('ambiguous argument');
    expect(log.exitCode).toBe(0);
    expect(log.stdout.toString().trim()).toBe(`${head} chore(factory): archive job ${id}`);
  });

  test('AC1: an abandoned job has no Merged-As; a legacy job keeps its job.json', async () => {
    await seedJob('001-gave-up', 'abandoned');
    expect((await cli('archive', '001-gave-up')).code).toBe(0);
    expect(gitIn(repo, 'log', '-1', '--format=%B', REF)).toBe('chore(factory): archive job 001-gave-up\n\nFactory-Job: 001-gave-up');

    const legacy = join(root, 'jobs', '002-legacy');
    await mkdir(legacy);
    await writeFile(join(legacy, 'job.json'), JSON.stringify({ id: '002-legacy', stage: 'merged' }));
    await writeFile(join(legacy, 'spec.md'), 'old\n');
    const r = await cli('archive', '002-legacy');
    expect(r.code).toBe(0);
    expect(files(REF)).toEqual([...JOB_FILES.map((f) => `001-gave-up/${f}`), '002-legacy/job.json', '002-legacy/spec.md']);
    expect(gitIn(repo, 'log', '-1', '--format=%B', REF)).toBe('chore(factory): archive job 002-legacy\n\nFactory-Job: 002-legacy');
    expect(commits().length).toBe(2);
  });

  test('AC2: a job in any other stage is refused in one line and the ref is unchanged', async () => {
    for (const [i, kind] of (['review', 'needs-human', 'claimed'] as const).entries()) {
      const id = `00${i + 1}-live`;
      await seedJob(id, kind);
      const r = await cli('archive', id);
      expect(r.code).toBe(1);
      expect(r.err).toEqual([`${id} is ${kind}: only merged or abandoned jobs are archived`]);
      expect(tip()).toBeNull();
    }
    await seedJob('009-done', 'merged');
    expect((await cli('archive', '009-done')).code).toBe(0);
    const head = tip();
    await seedJob('010-live', 'review');
    expect((await cli('archive', '010-live')).code).toBe(1);
    expect(tip()).toBe(head);
  });

  test('AC2: a bad or unknown id is refused before any path or ref is built', async () => {
    for (const id of ['../x', '01-Short', 'a_b']) {
      const r = await cli('archive', id);
      expect(r.code).toBe(1);
      expect(r.err[0]).toMatch(/^job id '.*' must match/);
    }
    // An epic slug (never a job id) names an epic (job 052): an unknown one is refused in one line.
    for (const slug of ['01-short', 'abc']) expect((await cli('archive', slug)).err).toEqual([`epic ${slug}: no such epic`]);
    expect((await cli('archive', '004-nope')).err).toEqual(['004-nope: no such job']);
    expect(tip()).toBeNull();
  });

  test('AC3: unchanged is a no-op; a changed file needs --force, which adds a commit on the first', async () => {
    const id = '001-again';
    const dir = await seedJob(id, 'merged');
    expect((await cli('archive', id)).code).toBe(0);
    const first = tip();
    // job.json and lock dirs are not part of the archive, so touching them changes nothing.
    await writeFile(join(dir, 'job.json'), '{}');
    await writeFile(join(dir, '.events.lock', 'other'), 'y');
    const again = await cli('archive', id);
    expect(again).toEqual({ code: 0, out: [`${id}: already archived (unchanged)`], err: [] });
    expect(tip()).toBe(first);

    await writeFile(join(dir, 'decision.md'), 'APPROVE\n');
    const refused = await cli('archive', id);
    expect(refused.code).toBe(1);
    expect(refused.err).toEqual([`${id}: changed since it was archived on factory/archive; run archive ${id} --force to add a new commit`]);
    expect(tip()).toBe(first);

    const forced = await cli('archive', id, '--force');
    expect(forced.code).toBe(0);
    const second = tip();
    expect(second).not.toBe(first);
    expect(gitIn(repo, 'rev-parse', `${REF}^`)).toBe(first ?? '');
    expect(commits().length).toBe(2);
    expect(files(REF)).toContain(`${id}/decision.md`);
  });

  test('AC4: a different job at the same id is refused, with or without --force, naming both', async () => {
    const id = '001-same';
    const dir = await seedJob(id, 'merged', '2026-10-01T00:00:00.000Z');
    expect((await cli('archive', id)).code).toBe(0);
    const first = tip();
    await rm(dir, { recursive: true });
    await seedJob(id, 'abandoned', '2026-10-05T00:00:00.000Z');
    for (const flags of [[], ['--force']]) {
      const r = await cli('archive', id, ...flags);
      expect(r.code).toBe(1);
      expect(r.err).toEqual([
        `${id}: factory/archive already holds a different job at ${id}/ (archived: job.claimed id=${id} ts=2026-10-01T00:00:00.000Z; local: job.claimed id=${id} ts=2026-10-05T00:00:00.000Z); nothing written`,
      ]);
      expect(tip()).toBe(first);
    }
  });

  test('AC4: a legacy job whose tree differs from the archived one is refused, even with --force', async () => {
    const legacy = join(root, 'jobs', '002-old');
    await mkdir(legacy);
    await writeFile(join(legacy, 'job.json'), JSON.stringify({ stage: 'abandoned' }));
    expect((await cli('archive', '002-old')).code).toBe(0);
    const first = tip();
    expect((await cli('archive', '002-old')).out).toEqual(['002-old: already archived (unchanged)']);
    await writeFile(join(legacy, 'spec.md'), 'other\n');
    for (const flags of [[], ['--force']]) {
      const r = await cli('archive', '002-old', ...flags);
      expect(r.code).toBe(1);
      expect(r.err[0]).toMatch(/^002-old: factory\/archive already holds a different job at 002-old\/ \(archived: tree [0-9a-f]{7}; local legacy job: tree [0-9a-f]{7}\); nothing written$/);
      expect(tip()).toBe(first);
    }
  });

  test('AC4: a refusal writes no git objects', async () => {
    const id = '001-objs';
    const dir = await seedJob(id, 'merged');
    expect((await cli('archive', id)).code).toBe(0);
    const count = (): string => gitIn(repo, 'count-objects');
    const before = count();
    await writeFile(join(dir, 'new.md'), 'a brand new blob\n');
    expect((await cli('archive', id)).code).toBe(1);
    expect(count()).toBe(before);
  });

  test('AC5: two archives run in parallel both land', async () => {
    for (let i = 0; i < 5; i++) {
      gitIn(repo, 'update-ref', '-d', REF);
      await rm(join(root, 'jobs'), { recursive: true, force: true });
      await mkdir(join(root, 'jobs'));
      await seedJob('001-left', 'merged');
      await seedJob('002-right', 'abandoned');
      const [a, b] = await Promise.all([cli('archive', '001-left'), cli('archive', '002-right')]);
      expect({ a: a.code, b: b.code, err: [...a.err, ...b.err] }).toEqual({ a: 0, b: 0, err: [] });
      expect(gitIn(repo, 'ls-tree', '--name-only', REF).split('\n')).toEqual(['001-left', '002-right']);
      expect(commits().length).toBe(2);
    }
  });

  test('AC5: --all archives exactly the terminal, unarchived jobs, one commit each, in id order', async () => {
    await seedJob('001-done', 'merged');
    expect((await cli('archive', '001-done')).code).toBe(0);
    await seedJob('002-live', 'review');
    await seedJob('003-gone', 'abandoned');
    await seedJob('004-stuck', 'needs-human');
    await seedJob('005-landed', 'merged');
    const r = await cli('archive', '--all');
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    const log = gitIn(repo, 'log', '--format=%s', REF).split('\n');
    expect(log).toEqual(['chore(factory): archive job 005-landed', 'chore(factory): archive job 003-gone', 'chore(factory): archive job 001-done']);
    expect(r.out.at(-1)).toBe('archive --all: archived 2, unchanged 1, skipped 2 (not merged or abandoned), failed 0');
    expect(gitIn(repo, 'ls-tree', '--name-only', REF).split('\n')).toEqual(['001-done', '003-gone', '005-landed']);
    // Again: nothing left to do.
    const again = await cli('archive', '--all');
    expect(again.code).toBe(0);
    expect(again.out).toEqual(['archive --all: archived 0, unchanged 3, skipped 2 (not merged or abandoned), failed 0']);
  });

  test('AC5: --all reports a per-job failure in one line and still archives the rest', async () => {
    const dir = await seedJob('001-changed', 'merged');
    expect((await cli('archive', '001-changed')).code).toBe(0);
    await writeFile(join(dir, 'late.md'), 'late\n');
    await seedJob('002-next', 'abandoned');
    const r = await cli('archive', '--all');
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['001-changed: changed since it was archived on factory/archive; run archive 001-changed --force to add a new commit']);
    expect(gitIn(repo, 'ls-tree', '--name-only', REF).split('\n')).toEqual(['001-changed', '002-next']);
    expect(r.out.at(-1)).toBe('archive --all: archived 1, unchanged 0, skipped 0 (not merged or abandoned), failed 1');
  });

  test('AC6: with no archive key or enabled: false, archive says it is disabled and writes nothing', async () => {
    await seedJob('001-done', 'merged');
    for (const config of [BASE, { ...BASE, archive: { enabled: false } }]) {
      await writeConfig(config);
      for (const argv of [['archive', '001-done'], ['archive', '--all']]) {
        const r = await cli(...argv);
        expect(r.code).toBe(1);
        expect(r.err).toEqual(['archiving is disabled: config.json has no "archive": { "enabled": true }; nothing written']);
        expect(tip()).toBeNull();
      }
    }
  });

  test('the other refusals are one line each and move no ref', async () => {
    // A merged job whose job.merged sha is not a hex commit id.
    const bad = await seedJob('001-badsha', 'merged');
    const log = (await readFile(join(bad, 'events.jsonl'), 'utf8')).replace(`"sha":"${SHA}"`, '"sha":"main\\nEvil: x"');
    await writeFile(join(bad, 'events.jsonl'), log);
    expect((await cli('archive', '001-badsha')).err).toEqual(['001-badsha: job.merged sha is not a hex commit id (^[0-9a-f]{4,64}$); not archived']);
    // A log that does not start with job.claimed.
    const noClaim = await seedJob('002-noclaim', 'abandoned');
    const lines = (await readFile(join(noClaim, 'events.jsonl'), 'utf8')).split('\n');
    await writeFile(join(noClaim, 'events.jsonl'), `${lines.slice(1).join('\n')}`);
    expect((await cli('archive', '002-noclaim')).err).toEqual(['002-noclaim: events.jsonl does not start with job.claimed; not archived']);
    // A legacy dir with no readable job.json, and an empty events.jsonl (not legacy: refused).
    await mkdir(join(root, 'jobs', '003-empty'));
    expect((await cli('archive', '003-empty')).err).toEqual(['003-empty: no events.jsonl and no readable job.json; not archived']);
    await mkdir(join(root, 'jobs', '004-blank'));
    await writeFile(join(root, 'jobs', '004-blank', 'events.jsonl'), '');
    await writeFile(join(root, 'jobs', '004-blank', 'job.json'), JSON.stringify({ stage: 'merged' }));
    expect((await cli('archive', '004-blank')).err).toEqual(['004-blank: events.jsonl is empty; not archived']);
    // A symlinked job dir is never followed.
    const outside = await mkdtemp(join(tmpdir(), 'factory-archive-outside-'));
    try {
      await writeFile(join(outside, 'job.json'), JSON.stringify({ stage: 'merged' }));
      await symlink(outside, join(root, 'jobs', '005-link'));
      expect((await cli('archive', '005-link')).err).toEqual(['005-link: not a directory (a symlinked job dir is never followed); not archived']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    expect(tip()).toBeNull();
    // <id> on the branch as a file, not a directory.
    const blob = gitIn(repo, 'hash-object', '-w', '--stdin');
    const tree = Bun.spawnSync(['git', '-C', repo, 'mktree'], { stdin: new TextEncoder().encode(`100644 blob ${blob}\t006-file\n`) }).stdout.toString().trim();
    const commit = gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit-tree', tree, '-m', 'x');
    gitIn(repo, 'update-ref', REF, commit);
    await seedJob('006-file', 'merged');
    expect((await cli('archive', '006-file')).err).toEqual(['006-file: factory/archive has 006-file as a blob, not a directory; nothing written']);
    expect(tip()).toBe(commit);
  });

  test('job 046 AC4: a ref that never stops moving gives up naming factory/archive', async () => {
    await seedJob('001-stuck', 'merged');
    // A held ref lock makes every compare-and-swap update-ref fail, as a lost race does; no lock
    // wait, so the 50 tries stay fast.
    gitIn(repo, 'config', 'core.filesRefLockTimeout', '0');
    const lock = join(gitIn(repo, 'rev-parse', '--path-format=absolute', '--git-dir'), 'refs', 'heads', 'factory', 'archive.lock');
    await mkdir(join(lock, '..'), { recursive: true });
    await writeFile(lock, '');
    const r = await cli('archive', '001-stuck');
    expect(r.code).toBe(1);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toStartWith('001-stuck: factory/archive kept moving; gave up after 50 tries (');
    await rm(lock);
    expect(tip()).toBeNull();
  });

  test('a symlink inside a job dir is not followed or copied', async () => {
    const id = '001-links';
    const dir = await seedJob(id, 'merged');
    await symlink('/etc/hosts', join(dir, 'hosts.md'));
    await symlink(join(dir, 'round-1'), join(dir, 'round-2'));
    expect((await cli('archive', id)).code).toBe(0);
    expect(files(REF)).toEqual(JOB_FILES.map((f) => `${id}/${f}`));
  });

  test('a repo path containing a colon (the alternates separator) archives and compares', async () => {
    const odd = join(repo, 'a:b');
    await mkdir(odd);
    initRepo(odd, 'main');
    for (const [k, v] of [['user.name', 'factory-test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) gitIn(odd, 'config', k ?? '', v ?? '');
    root = join(odd, 'factory');
    await mkdir(join(root, 'jobs'), { recursive: true });
    await writeConfig(ON);
    await seedJob('001-odd', 'merged');
    expect((await cli('archive', '001-odd')).code).toBe(0);
    expect(await cli('archive', '001-odd')).toEqual({ code: 0, out: ['001-odd: already archived (unchanged)'], err: [] });
  });

  test('usage errors', async () => {
    for (const argv of [[], ['--force'], ['001-a', '--force', '--force'], ['001-a', '002-b'], ['--every'], ['001-a', '--delete-branch']]) {
      const r = await cli('archive', ...argv);
      expect(r.code).toBe(1);
      expect(r.err).toEqual(['usage: archive <id> | --all [--force]']);
    }
  });
});

describe('claim counts the archive branch (job 045, AC7)', () => {
  test('the new id is above the branch highest, with archiving on and off', async () => {
    await seedJob('007-old', 'merged');
    expect((await cli('archive', '007-old')).code).toBe(0);
    await rm(join(root, 'jobs', '007-old'), { recursive: true });
    await mkdir(join(root, 'jobs', '002-local'));
    expect(await archivedIds(repo)).toEqual(['007-old']);
    const on = await cli('claim', 'next-on');
    expect(on).toEqual({ code: 0, out: ['008-next-on'], err: [] });
    // Off: only the branch holds a number above the local dirs, so the claim depends on reading it.
    await rm(join(root, 'jobs', '008-next-on'), { recursive: true });
    await writeConfig(BASE);
    const off = await cli('claim', 'next-off');
    expect(off).toEqual({ code: 0, out: ['008-next-off'], err: [] });
    await writeConfig({ ...BASE, archive: { enabled: false } });
    await rm(join(root, 'jobs', '008-next-off'), { recursive: true });
    expect((await cli('claim', 'next-false')).out).toEqual(['008-next-false']);
  });

  test('job 046 AC2: ids only on the old refs/heads/factory/jobs ref are ignored', async () => {
    await seedJob('007-old', 'merged');
    expect((await cli('archive', '007-old')).code).toBe(0);
    const archived = tip();
    if (archived === null) throw new Error('no archive branch');
    // Move the archive to the old name only.
    gitIn(repo, 'update-ref', OLD_REF, archived);
    gitIn(repo, 'update-ref', '-d', REF);
    await rm(join(root, 'jobs', '007-old'), { recursive: true });
    await mkdir(join(root, 'jobs', '002-local'));
    expect(await archivedIds(repo)).toEqual([]);
    expect((await cli('claim', 'after-old')).out).toEqual(['003-after-old']);
    expect(gitIn(repo, 'rev-parse', OLD_REF)).toBe(archived);
    expect(tip()).toBeNull();
  });

  test('with no branch, claim picks the same id as before', async () => {
    await mkdir(join(root, 'jobs', '003-local'));
    expect(await archivedIds(repo)).toEqual([]);
    expect((await cli('claim', 'plain')).out).toEqual(['004-plain']);
  });
});
