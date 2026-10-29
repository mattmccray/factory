import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatShow, project, readLog } from '@factory/contract';
import { gitIn, initRepo } from './gitrepo';
import { run, USAGE } from './index';

const CONFIG = { schema: 'factory/v1', reviewers: ['security', 'code'], maxRound: 2, dashboard: { settleAfterHours: 24 } };
const ID = '001-example';
const SLUG = 'example';

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
    expect(await cli('claim', SLUG)).toEqual({ code: 0, out: [ID], err: [] });
    expect(await cli('event', ID, 'stage.entered', 'stage=spec')).toEqual({ code: 0, out: ['spec'], err: [] });
    expect(await cli('event', ID, 'job.titled', 'title=404')).toEqual({ code: 0, out: ['spec'], err: [] });

    const lines = (await readFile(join(root, 'jobs', ID, 'events.jsonl'), 'utf8')).trim().split('\n');
    const titled: unknown = JSON.parse(lines[2] ?? '');
    expect(titled).toMatchObject({ type: 'job.titled', title: '404' });
    expect(lines[2]).toContain('"title":"404"');

    expect(await cli('rebuild', ID)).toEqual({ code: 0, out: [`rebuilt 1: ${ID}`], err: [] });
    expect(await cli('claim', 'other')).toEqual({ code: 0, out: ['002-other'], err: [] });
    expect(await cli('rebuild', '--all')).toEqual({ code: 0, out: [`rebuilt 2: ${ID} 002-other`], err: [] });
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
    await cli('claim', SLUG);
    await cli('event', ID, 'stage.entered', 'stage=spec');
  });

  test('an illegal transition', () => rejects(['event', ID, 'stage.entered', 'stage=approve']));
  test('a non-integer round', () => rejects(['event', ID, 'round.started', 'round=abc']));
  test('a non-array reviewers', () => rejects(['event', ID, 'round.started', 'round=1', 'reviewers={"a":1}']));
  test('a bad job id creates no dir', async () => {
    await rejects(['event', '../x', 'job.noted', 'note=x']);
    expect((await readdir(root)).sort()).toEqual(['config.json', 'jobs']);
    expect(await readdir(join(root, 'jobs'))).toEqual([ID]);
  });
  test('a bad job id on a fresh root creates nothing', async () => {
    await rm(join(root, 'jobs'), { recursive: true });
    const r = await cli('event', 'BAD', 'job.noted', 'note=x');
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

  test('claim with no slug', () => usage(['claim'], USAGE.claim));

  test('usage lines: every command, and both top-level lines list claim (AC7)', () => {
    expect(USAGE).toEqual({
      claim: 'usage: claim <slug> [brief=…] [issue=…] [maxRound=…] [session=t3code:<environmentId>/<threadId>]',
      event: 'usage: event <id> <type> [field=value …]',
      rebuild: 'usage: rebuild <id> | --all',
      show: 'usage: show <id>',
      abandon: 'usage: abandon <id> "<reason>" [--force] [--delete-branch]',
      archive: 'usage: archive <id> | --all [--force]',
      prune: 'usage: prune',
      all: 'usage: claim <slug> [k=v …] | event <id> <type> [k=v …] | rebuild <id>|--all | show <id>',
      init: 'usage: init [--force]',
      upgrade: 'usage: upgrade [--force]',
      source: 'usage: claim <slug> [k=v …] | event <id> <type> [k=v …] | rebuild <id>|--all | show <id> | doctor | init [--force] | upgrade [--force]',
    });
  });

  test('show prints formatShow lines', async () => {
    await cli('claim', SLUG);
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
    const r = await cli('claim', SLUG);
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["config: unknown key 'extra'"]);
    expect(await readdir(root)).toEqual(['config.json']);
  });
});

describe('target branch (claim, AC5)', () => {
  const jobJson = async (id = ID): Promise<unknown> => JSON.parse(await readFile(join(root, 'jobs', id, 'job.json'), 'utf8'));
  const claimedEvent = async (id = ID): Promise<unknown> => JSON.parse((await readFile(join(root, 'jobs', id, 'events.jsonl'), 'utf8')).split('\n')[0] ?? '');
  const withMerge = (merge: unknown) => writeFile(join(root, 'config.json'), JSON.stringify({ ...CONFIG, merge }));

  test('with no merge key, a claim records the checkout branch (master)', async () => {
    expect(await cli('claim', SLUG)).toEqual({ code: 0, out: [ID], err: [] });
    expect(await claimedEvent()).toMatchObject({ type: 'job.claimed', target: 'master' });
    expect(await jobJson()).toMatchObject({ target: 'master' });
  });

  test('a named target is recorded whatever branch the checkout is on', async () => {
    gitIn(repo, 'branch', 'develop');
    gitIn(repo, 'checkout', '--quiet', '-b', 'feature/elsewhere');
    await withMerge({ target: 'develop' });
    expect(await cli('claim', SLUG)).toEqual({ code: 0, out: [ID], err: [] });
    expect(await claimedEvent()).toMatchObject({ target: 'develop' });
    expect(await jobJson()).toMatchObject({ target: 'develop' });
  });

  // A refusal leaves no jobs/, job dir, events.jsonl, job.json, or .claim.lock, and uses up no
  // number: the next good claim gets the number this one would have used.
  const refuses = async (want: RegExp): Promise<void> => {
    const r = await cli('claim', SLUG);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err.length).toBe(1);
    expect(r.err[0]).toMatch(want);
    expect(r.err[0]).not.toContain('\n');
    expect(await readdir(root)).toEqual(['config.json']);
    await writeFile(join(root, 'config.json'), JSON.stringify(CONFIG));
    gitIn(repo, 'checkout', '--quiet', 'master');
    expect(await cli('claim', SLUG)).toEqual({ code: 0, out: [ID], err: [] });
  };

  test('a missing named branch refuses the claim and writes nothing', async () => {
    await withMerge({ target: 'develop' });
    await refuses(/^merge\.target 'develop': no branch refs\/heads\/develop/);
  });

  test('current on a detached HEAD refuses the claim and writes nothing', async () => {
    gitIn(repo, 'checkout', '--quiet', '--detach');
    await refuses(/^merge\.target 'current': .*detached HEAD/);
  });

  test('a checkout on a branch with shell metacharacters refuses the claim and writes nothing', async () => {
    gitIn(repo, 'checkout', '--quiet', '-b', "x';$(id)");
    await refuses(/^merge\.target 'current': branch ".*" is not an allowed target name/);
  });

  test('a caller-supplied target is rejected as an extra field and nothing is written', async () => {
    const r = await cli('claim', SLUG, 'target=develop');
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["job.claimed: extra field: unknown key 'target'"]);
    expect(await readdir(root)).toEqual(['config.json']);
  });
});

describe('claim (AC1–AC5)', () => {
  const seed = async (...ids: string[]): Promise<void> => {
    for (const id of ids) await mkdir(join(root, 'jobs', id), { recursive: true });
  };
  const writeJob = (id: string, stage: string) => writeFile(join(root, 'jobs', id, 'job.json'), JSON.stringify({ id, stage }));
  const lines = async (id: string): Promise<unknown[]> =>
    (await readFile(join(root, 'jobs', id, 'events.jsonl'), 'utf8')).trim().split('\n').map((l): unknown => JSON.parse(l));

  test('AC1: after 004 it creates 005-<slug> with job.claimed first, prints only the id, exit 0', async () => {
    await seed('001-a', '004-b');
    expect(await cli('claim', 'week-view-pager', 'brief=factory/briefs/x.md', 'issue=M7', 'maxRound=3')).toEqual({ code: 0, out: ['005-week-view-pager'], err: [] });
    expect((await readdir(join(root, 'jobs', '005-week-view-pager'))).sort()).toEqual(['events.jsonl', 'job.json']);
    const log = await lines('005-week-view-pager');
    expect(log.length).toBe(1);
    expect(log[0]).toMatchObject({ type: 'job.claimed', schema: 'factory/v1', id: '005-week-view-pager', target: 'master', brief: 'factory/briefs/x.md', issue: 'M7', maxRound: 3 });
    const snap: unknown = JSON.parse(await readFile(join(root, 'jobs', '005-week-view-pager', 'job.json'), 'utf8'));
    expect(snap).toMatchObject({ id: '005-week-view-pager', stage: 'claimed', target: 'master', maxRound: 3 });
  });

  test('AC1: no jobs/ gives 001, and defaults come from config', async () => {
    expect(await cli('claim', 'first')).toEqual({ code: 0, out: ['001-first'], err: [] });
    expect((await lines('001-first'))[0]).toMatchObject({ maxRound: 2, brief: null, issue: null });
  });

  test('AC1: an empty jobs/ gives 001; stray entries are ignored', async () => {
    await mkdir(join(root, 'jobs', 'notes'), { recursive: true });
    await writeFile(join(root, 'jobs', '900-file'), 'not a dir');
    expect(await cli('claim', 'first')).toEqual({ code: 0, out: ['001-first'], err: [] });
  });

  const refused = async (argv: string[], want?: string): Promise<void> => {
    const before = await snapshotJobs();
    const r = await cli(...argv);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err.length).toBe(1);
    expect(r.err[0]).not.toBe('');
    if (want !== undefined) expect(r.err[0]).toBe(want);
    expect(await snapshotJobs()).toEqual(before);
  };

  for (const bad of ['Abc', '--x', 'x-', 'a_b', 'a'.repeat(41), '', '-', 'a--b', '../x']) {
    test(`AC3: slug ${JSON.stringify(bad)} is refused and creates nothing`, async () => {
      await seed('001-a');
      await refused(['claim', bad]);
    });
  }

  test('AC3: a bad slug on a fresh root creates no jobs/', async () => {
    const r = await cli('claim', 'Abc');
    expect(r.code).toBe(1);
    expect(r.err.length).toBe(1);
    expect(await readdir(root)).toEqual(['config.json']);
  });

  test('AC3: a missing slug is the claim usage line', async () => {
    expect(await cli('claim')).toEqual({ code: 1, out: [], err: [USAGE.claim] });
  });

  test('AC3: a 40-character slug is accepted', async () => {
    const slug = `${'a'.repeat(19)}-${'b'.repeat(20)}`;
    expect(slug.length).toBe(40);
    expect(await cli('claim', slug)).toEqual({ code: 0, out: [`001-${slug}`], err: [] });
  });

  test('AC3: with 999 taken, the claim is refused', async () => {
    await seed('999-last');
    await refused(['claim', 'more']);
  });

  test('AC3: a bad field is refused before anything is written', async () => {
    await refused(['claim', 'x', 'id=002-x']);
    await refused(['claim', 'x', 'maxRound=abc']);
  });

  test('AC4: a live slug is refused naming the job; a settled or unreadable one is claimed anew', async () => {
    await seed('003-export-csv');
    await writeJob('003-export-csv', 'build');
    await refused(['claim', 'export-csv'], 'slug export-csv is live as 003-export-csv');
    for (const stage of ['needs-human', 'claimed']) {
      await writeJob('003-export-csv', stage);
      await refused(['claim', 'export-csv'], 'slug export-csv is live as 003-export-csv');
    }
    await writeJob('003-export-csv', 'merged');
    expect(await cli('claim', 'export-csv')).toEqual({ code: 0, out: ['004-export-csv'], err: [] });
    expect(await cli('event', '004-export-csv', 'stage.entered', 'stage=spec')).toEqual({ code: 0, out: ['spec'], err: [] });
    expect(await cli('abandon', '004-export-csv', 'redo', '--force')).toEqual({ code: 0, out: ['abandoned'], err: [] });
    expect(await cli('claim', 'export-csv')).toEqual({ code: 0, out: ['005-export-csv'], err: [] });
  });

  test('AC4: a dir with no readable job.json is not live', async () => {
    await seed('003-export-csv', '004-other');
    await writeFile(join(root, 'jobs', '004-other', 'job.json'), '{not json');
    expect(await cli('claim', 'export-csv')).toEqual({ code: 0, out: ['005-export-csv'], err: [] });
    expect(await cli('claim', 'other')).toEqual({ code: 0, out: ['006-other'], err: [] });
  });

  test('AC5: event <id> job.claimed is refused naming claim, and writes nothing', async () => {
    await refused(['event', ID, 'job.claimed']);
    const r = await cli('event', ID, 'job.claimed');
    expect(r.err[0]).toContain('claim <slug>');
    expect(await readdir(root)).toEqual(['config.json']);
  });

  test('AC5: other event types still print the new stage', async () => {
    await cli('claim', SLUG);
    expect(await cli('event', ID, 'stage.entered', 'stage=spec')).toEqual({ code: 0, out: ['spec'], err: [] });
    expect(await cli('event', ID, 'job.noted', 'note=hi')).toEqual({ code: 0, out: ['spec'], err: [] });
  });

  test('AC2: concurrent claims in-process get distinct, consecutive numbers', async () => {
    await seed('002-seed');
    const slugs = Array.from({ length: 12 }, (_, i) => `job-${i}`);
    const results = await Promise.all(slugs.map((s) => cli('claim', s)));
    const ids = results.map((r) => {
      expect(r.code).toBe(0);
      expect(r.err).toEqual([]);
      return r.out[0] ?? '';
    });
    expect(ids.map((id) => id.slice(0, 3)).sort()).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 3).padStart(3, '0')));
    for (const [i, id] of ids.entries()) expect(id.slice(4)).toBe(slugs[i] ?? '');
    expect((await readdir(join(root, 'jobs'))).sort()).toEqual(['002-seed', ...ids].sort());
  });

  test('AC2: concurrent claims as separate bun processes get distinct, consecutive numbers', async () => {
    const main = join(import.meta.dir, 'main.ts');
    const n = 6;
    const runs = await Promise.all(
      Array.from({ length: n }, async (_, i) => {
        const p = Bun.spawn([process.execPath, main, 'claim', `proc-${i}`], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
        const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        return { out, err, code, slug: `proc-${i}` };
      }),
    );
    for (const r of runs) {
      expect(r).toMatchObject({ code: 0, err: '' });
      expect(r.out).toMatch(new RegExp(`^\\d{3}-${r.slug}\\n$`));
    }
    const ids = runs.map((r) => r.out.trim());
    expect(ids.map((id) => id.slice(0, 3)).sort()).toEqual(Array.from({ length: n }, (_, i) => String(i + 1).padStart(3, '0')));
    expect((await readdir(join(root, 'jobs'))).sort()).toEqual([...ids].sort());
    for (const id of ids) expect((await lines(id))[0]).toMatchObject({ type: 'job.claimed', id });
  }, 30_000);
});

describe('session (claim, job.reworked, job.human-approved)', () => {
  const A = { app: 't3code', environment: 'env-1', thread: 'thread-A' };
  const B = { app: 't3code', environment: 'env-2', thread: 'thread-B' };
  const SESSION_A = 'session=t3code:env-1/thread-A';
  const SESSION_B = 'session=t3code:env-2/thread-B';
  const MALFORMED = [
    'session=codex:env-1/thread-A',
    'session=env-1/thread-A',
    'session=t3code:env-1',
    'session=t3code:/thread-A',
    'session=t3code:env-1/',
    `session=t3code:${'a'.repeat(65)}/thread-A`,
    'session=t3code:env-1/thread/A',
    'session=t3code:env.1/thread-A',
    'session=t3code:env-1/thread_A',
    'session=t3code:env 1/thread-A',
    'session=t3code:env-1/thread-A!',
    'session=null',
    'session=',
  ];
  const events = async (): Promise<unknown[]> =>
    (await readFile(join(root, 'jobs', ID, 'events.jsonl'), 'utf8')).trim().split('\n').map((l): unknown => JSON.parse(l));
  const snap = async (): Promise<unknown> => JSON.parse(await readFile(join(root, 'jobs', ID, 'job.json'), 'utf8'));
  const sessionOf = async (): Promise<unknown> => {
    const s = await snap();
    return typeof s === 'object' && s !== null && 'session' in s ? s.session : undefined;
  };
  const refused = async (argv: string[]): Promise<void> => {
    const before = await snapshotJobs();
    const r = await cli(...argv);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err.length).toBe(1);
    expect(r.err[0]).not.toContain('\n');
    expect(await snapshotJobs()).toEqual(before);
  };
  const toNeedsHuman = async (): Promise<void> => {
    expect((await cli('event', ID, 'job.escalated', 'reason=stuck')).code).toBe(0);
  };

  test('AC1: a claim with session= logs it and job.json has it', async () => {
    expect(await cli('claim', SLUG, SESSION_A)).toEqual({ code: 0, out: [ID], err: [] });
    expect((await events())[0]).toMatchObject({ type: 'job.claimed', session: A });
    expect(await sessionOf()).toEqual(A);
  });

  test('AC1: a claim without session= logs no session key; job.json has session null', async () => {
    expect((await cli('claim', SLUG)).code).toBe(0);
    const first = (await events())[0];
    expect(typeof first === 'object' && first !== null && 'session' in first).toBe(false);
    expect(await sessionOf()).toBeNull();
  });

  test('AC2: a malformed session= on claim is refused and creates no job dir', async () => {
    for (const s of MALFORMED) await refused(['claim', SLUG, s]);
    expect(await readdir(join(root, 'jobs')).catch(() => [])).toEqual([]);
  });

  test('AC2: a malformed session= on job.reworked or job.human-approved is refused, nothing written', async () => {
    await cli('claim', SLUG, SESSION_A);
    await toNeedsHuman();
    for (const s of MALFORMED) {
      await refused(['event', ID, 'job.reworked', 'k=1', 'maxRound=3', s]);
      await refused(['event', ID, 'job.human-approved', s]);
    }
  });

  test('AC3: job.reworked with session B wins; without one it stays; job.abandoned leaves it', async () => {
    await cli('claim', SLUG, SESSION_A);
    await toNeedsHuman();
    expect(await cli('event', ID, 'job.reworked', 'k=1', 'maxRound=3', SESSION_B)).toEqual({ code: 0, out: ['build'], err: [] });
    expect(await sessionOf()).toEqual(B);
    await toNeedsHuman();
    expect((await cli('event', ID, 'job.reworked', 'k=2', 'maxRound=4')).code).toBe(0);
    expect(await sessionOf()).toEqual(B);
    await toNeedsHuman();
    expect((await cli('abandon', ID, 'done')).code).toBe(0);
    expect(await sessionOf()).toEqual(B);
  });

  test('AC3: job.human-approved with session B wins (and stays idempotent); without one it stays', async () => {
    await cli('claim', SLUG, SESSION_A);
    await toNeedsHuman();
    expect((await cli('event', ID, 'job.human-approved')).code).toBe(0);
    expect(await sessionOf()).toEqual(A);
    expect(await cli('event', ID, 'job.human-approved', SESSION_B)).toEqual({ code: 0, out: ['needs-human'], err: [] });
    expect(await sessionOf()).toEqual(B);
    expect((await cli('event', ID, 'job.human-approved', SESSION_B)).code).toBe(0);
    expect((await cli('event', ID, 'job.human-approved')).code).toBe(0);
    expect(await sessionOf()).toEqual(B);
    expect((await cli('rebuild', ID)).code).toBe(0);
    expect(await sessionOf()).toEqual(B);
  });

  test('AC4: session= on any other event is refused as an extra field, nothing written', async () => {
    await cli('claim', SLUG, SESSION_A);
    await refused(['event', ID, 'job.noted', 'note=x', SESSION_B]);
    await refused(['event', ID, 'stage.entered', 'stage=spec', SESSION_B]);
    await refused(['event', ID, 'job.escalated', 'reason=r', SESSION_B]);
    await toNeedsHuman();
    await refused(['event', ID, 'job.abandoned', 'reason=r', SESSION_B]);
    const r = await cli('event', ID, 'job.noted', 'note=x', SESSION_B);
    expect(r.err[0]).toContain("extra field: unknown key 'session'");
  });

  test('AC4: a log without any session rebuilds to the same job.json plus session null', async () => {
    await cli('claim', SLUG);
    await cli('event', ID, 'stage.entered', 'stage=spec');
    await toNeedsHuman();
    await cli('event', ID, 'job.human-approved');
    const before = await snap();
    expect((await cli('rebuild', ID)).code).toBe(0);
    expect(await snap()).toEqual(before);
    expect(await sessionOf()).toBeNull();
  });
});
