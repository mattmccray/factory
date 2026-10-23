import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatShow, project, readLog } from '@factory/contract';
import { gitIn, initRepo } from './gitrepo';
import { run, USAGE } from './index';

const CONFIG = { schema: 'factory/v1', reviewers: ['security', 'code'], maxRound: 2, dashboard: { settleAfterHours: 24 } };
const ID = '019-example';

// `repo` is a git repo (the main checkout, on `master`); `root` is its factory/ directory.
let repo: string;
let root: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'factory-cli-'));
  initRepo(repo, 'master');
  root = join(repo, 'factory');
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

// Every file under jobs/, with its bytes, so a rejection can be checked as byte-for-byte no-op.
async function snapshotJobs(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
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

describe('event / rebuild (AC1)', () => {
  test('claims, enters spec, titles, and rebuilds with exit 0', async () => {
    expect(await cli('event', ID, 'job.claimed')).toEqual({ code: 0, out: ['claimed'], err: [] });
    expect(await cli('event', ID, 'stage.entered', 'stage=spec')).toEqual({ code: 0, out: ['spec'], err: [] });
    expect(await cli('event', ID, 'job.titled', 'title=404')).toEqual({ code: 0, out: ['spec'], err: [] });

    const lines = (await readFile(join(root, 'jobs', ID, 'events.jsonl'), 'utf8')).trim().split('\n');
    const titled: unknown = JSON.parse(lines[2] ?? '');
    expect(titled).toMatchObject({ type: 'job.titled', title: '404' });
    expect(lines[2]).toContain('"title":"404"');

    expect(await cli('rebuild', ID)).toEqual({ code: 0, out: [`rebuilt 1: ${ID}`], err: [] });
    await cli('event', '020-other', 'job.claimed');
    expect(await cli('rebuild', '--all')).toEqual({ code: 0, out: [`rebuilt 2: ${ID} 020-other`], err: [] });
  });
});

describe('rejections (AC2)', () => {
  const rejects = async (argv: string[]): Promise<void> => {
    const before = await snapshotJobs();
    const r = await cli(...argv);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err.length).toBe(1);
    expect(r.err[0]).not.toContain('\n');
    expect(r.err[0]).not.toBe('');
    expect(await snapshotJobs()).toEqual(before);
  };

  beforeEach(async () => {
    await cli('event', ID, 'job.claimed');
    await cli('event', ID, 'stage.entered', 'stage=spec');
  });

  test('an illegal transition', () => rejects(['event', ID, 'stage.entered', 'stage=approve']));
  test('a non-integer round', () => rejects(['event', ID, 'round.started', 'round=abc']));
  test('a non-array reviewers', () => rejects(['event', ID, 'round.started', 'round=1', 'reviewers={"a":1}']));
  test('a bad job id creates no dir', async () => {
    await rejects(['event', '../x', 'job.claimed']);
    expect((await readdir(root)).sort()).toEqual(['config.json', 'jobs']);
    expect(await readdir(join(root, 'jobs'))).toEqual([ID]);
  });
  test('a bad job id on a fresh root creates nothing', async () => {
    await rm(join(root, 'jobs'), { recursive: true });
    const r = await cli('event', 'BAD', 'job.claimed');
    expect(r.code).toBe(1);
    expect(r.err.length).toBe(1);
    expect(await readdir(root)).toEqual(['config.json']);
  });
  test('an unknown event type', () => rejects(['event', ID, 'job.exploded']));
  test('a field without =', () => rejects(['event', ID, 'job.noted', 'note']));
});

describe('usage and show (AC3)', () => {
  const usage = async (argv: string[], line: string): Promise<void> => {
    expect(await cli(...argv)).toEqual({ code: 1, out: [], err: [line] });
  };
  test('no command', () => usage([], USAGE.source));
  test('unknown command', () => usage(['frobnicate'], USAGE.source));
  test('event with no args', () => usage(['event'], USAGE.event));
  test('event with only an id', () => usage(['event', ID], USAGE.event));
  test('rebuild with no target', () => usage(['rebuild'], USAGE.rebuild));
  test('show with no id', () => usage(['show'], USAGE.show));

  test('usage lines match the vendored CLI', () => {
    expect(USAGE).toEqual({
      event: 'usage: event <id> <type> [field=value …]',
      rebuild: 'usage: rebuild <id> | --all',
      show: 'usage: show <id>',
      all: 'usage: event <id> <type> [k=v …] | rebuild <id>|--all | show <id>',
      init: 'usage: init [--force]',
      upgrade: 'usage: upgrade [--force]',
      source: 'usage: event <id> <type> [k=v …] | rebuild <id>|--all | show <id> | doctor | init [--force] | upgrade [--force]',
    });
  });

  test('show prints formatShow lines', async () => {
    await cli('event', ID, 'job.claimed');
    await cli('event', ID, 'stage.entered', 'stage=spec');
    const now = new Date();
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(['show', ID], { root, stdout: (l) => out.push(l), stderr: (l) => err.push(l), now: () => now });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toEqual(formatShow(project(await readLog(root, ID)), now));
    expect(out[0]).toStartWith(`${ID}  spec`);
  });

  test('show on an unknown job exits 1 with one line', async () => {
    const r = await cli('show', '099-missing');
    expect(r.code).toBe(1);
    expect(r.err).toEqual(['099-missing: no events.jsonl (legacy or unknown job)']);
  });

  test('a bad config.json is a one-line rejection for non-doctor commands', async () => {
    await writeFile(join(root, 'config.json'), JSON.stringify({ ...CONFIG, extra: 1 }));
    const r = await cli('event', ID, 'job.claimed');
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["config: unknown key 'extra'"]);
    expect(await readdir(root)).toEqual(['config.json']);
  });
});

describe('target branch (job.claimed)', () => {
  const jobJson = async (id = ID): Promise<unknown> => JSON.parse(await readFile(join(root, 'jobs', id, 'job.json'), 'utf8'));
  const claimedEvent = async (id = ID): Promise<unknown> => JSON.parse((await readFile(join(root, 'jobs', id, 'events.jsonl'), 'utf8')).split('\n')[0] ?? '');
  const withMerge = (merge: unknown) => writeFile(join(root, 'config.json'), JSON.stringify({ ...CONFIG, merge }));

  test('with no merge key, a claim records the checkout branch (master)', async () => {
    expect(await cli('event', ID, 'job.claimed')).toEqual({ code: 0, out: ['claimed'], err: [] });
    expect(await claimedEvent()).toMatchObject({ type: 'job.claimed', target: 'master' });
    expect(await jobJson()).toMatchObject({ target: 'master' });
  });

  test('a named target is recorded whatever branch the checkout is on', async () => {
    gitIn(repo, 'branch', 'develop');
    gitIn(repo, 'checkout', '--quiet', '-b', 'feature/elsewhere');
    await withMerge({ target: 'develop' });
    expect(await cli('event', ID, 'job.claimed')).toEqual({ code: 0, out: ['claimed'], err: [] });
    expect(await claimedEvent()).toMatchObject({ target: 'develop' });
    expect(await jobJson()).toMatchObject({ target: 'develop' });
  });

  const refuses = async (want: RegExp): Promise<void> => {
    const r = await cli('event', ID, 'job.claimed');
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err.length).toBe(1);
    expect(r.err[0]).toMatch(want);
    expect(r.err[0]).not.toContain('\n');
    expect(await readdir(root)).toEqual(['config.json']); // no jobs/, job dir, events.jsonl, or job.json
  };

  test('a missing named branch refuses the claim and writes nothing', async () => {
    await withMerge({ target: 'develop' });
    await refuses(/^merge\.target 'develop': no branch refs\/heads\/develop/);
  });

  test('current on a detached HEAD refuses the claim and writes nothing', async () => {
    gitIn(repo, 'checkout', '--quiet', '--detach');
    await refuses(/^merge\.target 'current': .*detached HEAD/);
  });

  test('a caller-supplied target is rejected as an extra field and nothing is written', async () => {
    const r = await cli('event', ID, 'job.claimed', 'target=develop');
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["job.claimed: extra field: unknown key 'target'"]);
    expect(await readdir(root)).toEqual(['config.json']);
  });
});
