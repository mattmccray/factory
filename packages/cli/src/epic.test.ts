import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG, Fixture, plan } from './epicfixture';
import { USAGE } from './index';

const f = new Fixture();
beforeEach(() => f.setUp());
afterEach(() => f.tearDown());

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
const epicDir = (slug: string): string => join(f.root, 'jobs', 'epics', slug);
const worktree = (slug: string): string => join(f.root, '.worktrees', `epic-${slug}`);

describe('epic start (AC1)', () => {
  test('a ready plan with ready members: branch from the target, worktree, epic.started, epic.json running', async () => {
    await f.briefs('ready', 'a', 'b');
    await f.writePlan('auth', plan('ready', ['- `a`', '- `b` after: `a`']));
    const before = Date.now();
    expect(await f.cli('epic', 'start', 'auth', 'session=t3code:env-1/thread-1')).toEqual({ code: 0, out: ['running'], err: [] });
    expect(f.git('rev-parse', 'factory/epic/auth')).toBe(f.git('rev-parse', 'main'));
    expect(f.git('worktree', 'list', '--porcelain')).toContain(`worktree ${worktree('auth')}`);
    expect(f.git('-C', worktree('auth'), 'symbolic-ref', '--short', 'HEAD')).toBe('factory/epic/auth');
    const log = await f.lines('jobs', 'epics', 'auth', 'events.jsonl');
    expect(log).toEqual([{ ts: expect.any(String), type: 'epic.started', schema: 'factory/v1', slug: 'auth', target: 'main', session: { app: 't3code', environment: 'env-1', thread: 'thread-1' } }]);
    const ts = Date.parse(String(log[0]?.ts));
    expect(ts).toBeGreaterThanOrEqual(before - 1);
    expect(ts).toBeLessThanOrEqual(Date.now());
    expect(await f.json('jobs', 'epics', 'auth', 'epic.json')).toMatchObject({ slug: 'auth', state: 'running', branch: 'factory/epic/auth', target: 'main', waitingOn: null });
  });

  test('the target follows claim\'s rule: merge.target names a branch', async () => {
    f.git('branch', 'trunk');
    await f.config({ ...CONFIG, merge: { target: 'trunk' } });
    await f.start('auth', ['a']);
    expect((await f.lines('jobs', 'epics', 'auth', 'events.jsonl'))[0]).toMatchObject({ target: 'trunk' });
  });

  const refuses = async (slug: string, want: RegExp): Promise<void> => {
    const before = await f.state();
    const r = await f.cli('epic', 'start', slug);
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
    expect(r.err).toHaveLength(1);
    expect(r.err[0]).toMatch(want);
    expect(await f.state()).toEqual(before);
    if (/^[a-z0-9-]+$/.test(slug)) {
      expect(await exists(epicDir(slug))).toBe(false);
      expect(f.hasBranch(`factory/epic/${slug}`)).toBe(false);
      expect(await exists(worktree(slug))).toBe(false);
    }
  };

  test('a missing, non-ready, or malformed plan', async () => {
    await f.briefs('ready', 'a', 'b');
    await refuses('auth', /^epic start auth: plan factory\/epics\/auth\.md is missing$/);
    await f.writePlan('auth', plan('draft', ['- `a`']));
    await refuses('auth', /plan factory\/epics\/auth\.md is draft, not ready$/);
    await f.writePlan('auth', plan('done', ['- `a`']));
    await refuses('auth', /is done, not ready$/);
    await f.writePlan('auth', plan('ready', ['- a, no backticks']));
    await refuses('auth', /## Members line \d+ is malformed/);
    await f.writePlan('auth', plan('ready', ['- `a`', '- `a`']));
    await refuses('auth', /member a is listed twice/);
  });

  test('a missing or non-ready member brief', async () => {
    await f.briefs('ready', 'a');
    await f.briefs('draft', 'b');
    await f.writePlan('auth', plan('ready', ['- `a`', '- `c`']));
    await refuses('auth', /member brief factory\/briefs\/c\.md is missing$/);
    await f.writePlan('auth', plan('ready', ['- `a`', '- `b`']));
    await refuses('auth', /member brief factory\/briefs\/b\.md is "draft", not ready$/);
  });

  test('an after: naming a non-member, or a cycle', async () => {
    await f.briefs('ready', 'a', 'b');
    await f.writePlan('auth', plan('ready', ['- `a` after: `zz`']));
    await refuses('auth', /member a is after zz, which is not a member$/);
    await f.writePlan('auth', plan('ready', ['- `a` after: `b`', '- `b` after: `a`']));
    await refuses('auth', /the after: edges form a cycle: a -> b -> a$/);
  });

  test('a bad slug (checked before any path) or a target that can not be resolved', async () => {
    await refuses('052-auth', /must not look like a job id/);
    await refuses('../x', /must match/);
    await refuses('Auth', /must match/);
    await f.start('ok', ['a']); // a valid plan
    await f.writePlan('auth', plan('ready', ['- `a`']));
    await f.config({ ...CONFIG, merge: { target: 'nope' } });
    await refuses('auth', /^merge\.target 'nope': no branch refs\/heads\/nope/);
    await f.config(CONFIG);
    f.git('checkout', '--quiet', '--detach');
    await refuses('auth', /detached HEAD/);
  });

  test('a bad session field', async () => {
    await f.briefs('ready', 'a');
    await f.writePlan('auth', plan('ready', ['- `a`']));
    const r = await f.cli('epic', 'start', 'auth', 'session=nope');
    expect(r.code).toBe(1);
    expect(await exists(epicDir('auth'))).toBe(false);
    expect((await f.cli('epic', 'start', 'auth', 'target=main')).err[0]).toMatch(/extra field/);
  });

  test('an existing branch or worktree path refuses and leaves it alone', async () => {
    await f.briefs('ready', 'a');
    await f.writePlan('auth', plan('ready', ['- `a`']));
    f.git('branch', 'factory/epic/auth');
    const sha = f.git('rev-parse', 'factory/epic/auth');
    const r = await f.cli('epic', 'start', 'auth');
    expect(r).toEqual({ code: 1, out: [], err: ['epic start auth: branch factory/epic/auth already exists'] });
    expect(f.git('rev-parse', 'factory/epic/auth')).toBe(sha);
    expect(await exists(epicDir('auth'))).toBe(false);
    expect(await exists(join(f.root, 'jobs', 'epics'))).toBe(false);
    f.git('branch', '-D', 'factory/epic/auth');

    await mkdir(worktree('auth'), { recursive: true });
    await writeFile(join(worktree('auth'), 'keep.txt'), 'mine');
    const r2 = await f.cli('epic', 'start', 'auth');
    expect(r2.err).toEqual(['epic start auth: factory/.worktrees/epic-auth already exists']);
    expect(await readFile(join(worktree('auth'), 'keep.txt'), 'utf8')).toBe('mine');
    expect(f.hasBranch('factory/epic/auth')).toBe(false);
    expect(await exists(epicDir('auth'))).toBe(false);
  });

  test('a second start is refused and changes nothing', async () => {
    await f.start('auth', ['a']);
    const before = await f.state();
    const r = await f.cli('epic', 'start', 'auth');
    expect(r).toEqual({ code: 1, out: [], err: ['epic auth has already started: one run per plan'] });
    expect(await f.state()).toEqual(before);
  });

  test('two concurrent starts: exactly one wins, and the loser removes nothing of the winner', async () => {
    await f.briefs('ready', 'a');
    await f.writePlan('auth', plan('ready', ['- `a`']));
    const rs = await Promise.all([f.cli('epic', 'start', 'auth'), f.cli('epic', 'start', 'auth')]);
    expect(rs.map((r) => r.code).sort()).toEqual([0, 1]);
    expect(f.hasBranch('factory/epic/auth')).toBe(true);
    expect(await exists(worktree('auth'))).toBe(true);
    expect(await f.lines('jobs', 'epics', 'auth', 'events.jsonl')).toHaveLength(1);
  });

  test('usage', async () => {
    expect(await f.cli('epic')).toEqual({ code: 1, out: [], err: [USAGE.epic] });
    expect(await f.cli('epic', 'frobnicate', 'x')).toEqual({ code: 1, out: [], err: [USAGE.epic] });
    expect(await f.cli('epic', 'start')).toEqual({ code: 1, out: [], err: [USAGE.epicStart] });
    expect(await f.cli('epic', 'event', 'x')).toEqual({ code: 1, out: [], err: [USAGE.epicEvent] });
    expect(await f.cli('epic', 'next')).toEqual({ code: 1, out: [], err: [USAGE.epicNext] });
    expect(await f.cli('epic', 'show')).toEqual({ code: 1, out: [], err: [USAGE.epicShow] });
    expect(await f.cli('epic', 'abandon', 'x')).toEqual({ code: 1, out: [], err: [USAGE.epicAbandon] });
    expect(await f.cli('epic', 'abandon', 'x', 'why', '--nope')).toEqual({ code: 1, out: [], err: [USAGE.epicAbandon] });
  });
});

describe('epic event (AC2)', () => {
  const logText = (): Promise<string> => readFile(join(epicDir('auth'), 'events.jsonl'), 'utf8');
  const rejects = async (argv: string[], want: RegExp | string): Promise<void> => {
    const before = await f.state();
    const r = await f.cli('epic', 'event', ...argv);
    expect(r.code).toBe(1);
    expect(r.err).toHaveLength(1);
    if (typeof want === 'string') expect(r.err[0]).toBe(want);
    else expect(r.err[0]).toMatch(want);
    expect(await f.state()).toEqual(before);
  };

  test('waiting, resumed, landing (when every member merged and no sync or fix job is live), landed', async () => {
    await f.start('auth', ['a']);
    expect(await f.ok('epic', 'event', 'auth', 'epic.waiting', 'reason=checkout is on dev')).toEqual(['waiting']);
    expect(await f.json('jobs', 'epics', 'auth', 'epic.json')).toMatchObject({ state: 'waiting', waitingOn: 'you', note: 'checkout is on dev' });
    expect(await f.ok('epic', 'event', 'auth', 'epic.resumed', 'session=t3code:env-2/thread-2')).toEqual(['running']);
    expect(await f.ok('epic', 'event', 'auth', 'epic.resumed')).toEqual(['running']);
    await rejects(['auth', 'epic.landing'], /^epic\.landing refused: not every member has merged \(a: queued\)$/);
    const a = await f.claimMember('auth', 'a');
    await f.merge(a);
    const sync = (await f.ok('claim', 'sync-main', 'epic=auth', 'kind=sync'))[0] ?? '';
    await rejects(['auth', 'epic.landing'], `epic.landing refused: sync job ${sync} is live`);
    await f.ok('abandon', sync, 'not needed', '--force');
    expect(await f.ok('epic', 'event', 'auth', 'epic.landing')).toEqual(['landing']);
    await rejects(['auth', 'epic.resumed'], /not allowed from epic state 'landing'/);
    expect(await f.ok('epic', 'event', 'auth', 'epic.waiting', 'reason=checkout is on dev')).toEqual(['waiting']);
    expect(await f.ok('epic', 'event', 'auth', 'epic.resumed')).toEqual(['landing']);
    expect(await f.ok('epic', 'event', 'auth', 'epic.landed', 'sha=0123456')).toEqual(['landed']);
    const last = (await f.lines('jobs', 'epics', 'auth', 'events.jsonl')).at(-1);
    expect(last).toMatchObject({ type: 'epic.landed', sha: '0123456' });
    expect(await f.json('jobs', 'epics', 'auth', 'epic.json')).toMatchObject({ state: 'landed', sha: '0123456', endedAt: last?.ts });
    for (const t of [['epic.waiting', 'reason=x'], ['epic.resumed'], ['epic.landing'], ['epic.landed', 'sha=1']]) await rejects(['auth', ...t], /epic is landed \(terminal\)/);
  });

  test('landed only from landing', async () => {
    await f.start('auth', ['a']);
    await rejects(['auth', 'epic.landed', 'sha=0123456'], /not allowed from epic state 'running'/);
  });

  test('session only on started/resumed; unknown fields; started/abandoned name their commands', async () => {
    await f.start('auth', ['a']);
    await rejects(['auth', 'epic.waiting', 'reason=r', 'session=t3code:a/b'], /extra field: unknown key 'session'/);
    await rejects(['auth', 'epic.landing', 'foo=1'], /extra field: unknown key 'foo'/);
    await rejects(['auth', 'epic.resumed', 'session=bad'], /session/);
    await rejects(['auth', 'epic.started'], /^epic\.started is written only by epic start: run epic start <slug>/);
    await rejects(['auth', 'epic.abandoned', 'reason=x'], /^epic\.abandoned is written only by epic abandon: run epic abandon <slug>/);
    await rejects(['auth', 'job.merged', 'sha=1'], /unknown epic event type/);
    await rejects(['nope', 'epic.waiting', 'reason=x'], 'epic nope has not started (no jobs/epics/nope/)');
  });

  test('a torn log and a bad slug write nothing', async () => {
    await f.start('auth', ['a']);
    await rejects(['../auth', 'epic.waiting', 'reason=x'], /must match/);
    await rejects(['001-auth', 'epic.waiting', 'reason=x'], /must not look like a job id/);
    await appendFile(join(epicDir('auth'), 'events.jsonl'), '{"ts":"x"');
    const torn = await logText();
    await rejects(['auth', 'epic.waiting', 'reason=x'], /corrupt tail/);
    expect(await logText()).toBe(torn);
  });
});

describe('claim … epic= (AC3)', () => {
  test('a member claim targets the epic branch and records epic and kind; the plan maxRound applies', async () => {
    await f.start('auth', ['a', 'b'], ['- `a` maxRound: 4', '- `b`']);
    const a = await f.claimMember('auth', 'a');
    expect(a).toBe('001-a');
    const claimed = (await f.lines('jobs', a, 'events.jsonl'))[0];
    expect(claimed).toMatchObject({ type: 'job.claimed', epic: 'auth', kind: 'member', brief: 'factory/briefs/a.md', target: 'factory/epic/auth', maxRound: 4 });
    expect(await f.json('jobs', a, 'job.json')).toMatchObject({ epic: 'auth', kind: 'member', target: 'factory/epic/auth', maxRound: 4 });
    const b = await f.claimMember('auth', 'b', 'kind=member', 'maxRound=1');
    expect(await f.json('jobs', b, 'job.json')).toMatchObject({ kind: 'member', maxRound: 1 });
    const fix = (await f.ok('claim', 'fix-gate', 'epic=auth', 'kind=fix'))[0] ?? '';
    expect(await f.json('jobs', fix, 'job.json')).toMatchObject({ epic: 'auth', kind: 'fix', brief: null, maxRound: 2, target: 'factory/epic/auth' });
  });

  test('a standalone claim is unchanged: epic and kind are null, no new keys on job.claimed', async () => {
    const [id] = await f.ok('claim', 'plain');
    expect(await f.json('jobs', id ?? '', 'job.json')).toMatchObject({ epic: null, kind: null, target: 'main' });
    expect(Object.keys((await f.lines('jobs', id ?? '', 'events.jsonl'))[0] ?? {}).sort()).toEqual(['brief', 'id', 'issue', 'maxRound', 'schema', 'target', 'ts', 'type']);
  });

  const refuses = async (argv: string[], want: RegExp | string): Promise<void> => {
    const before = await f.state();
    const r = await f.cli('claim', ...argv);
    expect(r.code).toBe(1);
    expect(r.err).toHaveLength(1);
    if (typeof want === 'string') expect(r.err[0]).toBe(want);
    else expect(r.err[0]).toMatch(want);
    expect(await f.state()).toEqual(before);
  };

  test('refusals write nothing and use up no job number', async () => {
    await refuses(['a', 'epic=auth', 'brief=factory/briefs/a.md'], 'epic auth has not started (no epic.started)');
    await f.start('auth', ['a', 'b', 'c'], ['- `a`', '- `b`', '- `c` after: `a`']);
    await refuses(['a', 'epic=auth'], /a member claim needs brief=/);
    await refuses(['zz', 'epic=auth', 'brief=factory/briefs/zz.md'], /^epic auth: factory\/briefs\/zz\.md is not listed in the plan's ## Members$/);
    await refuses(['c', 'epic=auth', 'brief=factory/briefs/c.md'], 'epic auth: member c waits on a, not yet merged');
    await refuses(['x', 'kind=sync'], 'job.claimed: kind=sync needs epic=<slug>');
    await refuses(['x', 'epic=auth', 'kind=sync', 'brief=factory/briefs/a.md'], 'job.claimed: a sync job takes no brief=');
    await refuses(['x', 'epic=auth', 'kind=sync', 'target=main'], /extra field: unknown key 'target'/);
    await refuses(['x', 'epic=auth', 'kind=other'], /must be one of member\|sync\|fix/);
    const a = await f.claimMember('auth', 'a');
    expect(a).toBe('001-a');
    await refuses(['a', 'epic=auth', 'brief=factory/briefs/a.md'], 'slug a is live as 001-a');
    await refuses(['a-again', 'epic=auth', 'brief=factory/briefs/a.md'], 'epic auth: member a already has job 001-a (claimed)');
    await refuses(['c', 'epic=auth', 'brief=factory/briefs/c.md'], 'epic auth: member c waits on a (001-a), not yet merged');
    expect(await f.claimMember('auth', 'b')).toBe('002-b');
  });

  test('the cap counts working members only; sync and fix bypass it; a live sync job stops member claims', async () => {
    await f.config({ ...CONFIG, epic: { maxParallel: 1 } });
    await f.start('auth', ['a', 'b', 'c']);
    const a = await f.claimMember('auth', 'a');
    await refuses(['b', 'epic=auth', 'brief=factory/briefs/b.md'], 'epic auth: 1 members are working, at epic.maxParallel 1');
    const fix = (await f.ok('claim', 'fix', 'epic=auth', 'kind=fix'))[0] ?? '';
    expect(fix).toBe('002-fix');
    await f.ok('event', a, 'job.escalated', 'reason=stuck'); // needs-human holds no slot
    const sync = (await f.ok('claim', 'sync', 'epic=auth', 'kind=sync'))[0] ?? '';
    await refuses(['b', 'epic=auth', 'brief=factory/briefs/b.md'], `epic auth: sync job ${sync} is live: no member is claimed until it is merged or abandoned`);
    await f.ok('abandon', sync, 'done', '--force');
    expect(await f.claimMember('auth', 'b')).toBe('004-b');
  });

  test('concurrent member claims never pass the cap together', async () => {
    await f.config({ ...CONFIG, epic: { maxParallel: 1 } });
    await f.start('auth', ['a', 'b', 'c']);
    const rs = await Promise.all(['a', 'b', 'c'].map((m) => f.cli('claim', m, 'epic=auth', `brief=factory/briefs/${m}.md`)));
    expect(rs.filter((r) => r.code === 0)).toHaveLength(1);
    expect((await f.json('jobs', 'epics', 'auth', 'epic.json')).counts).toMatchObject({ running: 1, queued: 2 });
  });

  test('no claim into a landed or abandoned epic', async () => {
    await f.start('auth', ['a']);
    await f.ok('epic', 'abandon', 'auth', 'dropped');
    await refuses(['x', 'epic=auth', 'kind=fix'], 'epic auth is abandoned: no job is claimed into it');
  });

  test('the epic branch must exist', async () => {
    await f.start('auth', ['a']);
    f.git('worktree', 'remove', '--force', worktree('auth'));
    f.git('branch', '-D', 'factory/epic/auth');
    await refuses(['x', 'epic=auth', 'kind=fix'], 'epic auth: no branch refs/heads/factory/epic/auth');
  });
});

describe('epic.json, epic next, epic show (AC4)', () => {
  test('rebuilt after every member event, by rebuild, and by epic show; members added mid-run appear', async () => {
    await f.start('auth', ['a', 'b'], ['- `a`', '- `b` after: `a`']);
    const epicJson = () => f.json('jobs', 'epics', 'auth', 'epic.json');
    expect(await f.ok('epic', 'next', 'auth')).toEqual(['claim a']);
    const a = await f.claimMember('auth', 'a');
    expect((await epicJson()).members).toEqual([
      { slug: 'a', after: [], state: 'running', job: a, stage: 'claimed', blockedOn: [] },
      { slug: 'b', after: ['a'], state: 'blocked', job: null, stage: null, blockedOn: [{ member: 'a', job: a }] },
    ]);
    expect(await f.ok('epic', 'next', 'auth')).toEqual([]);
    await f.ok('event', a, 'stage.entered', 'stage=spec');
    expect((await epicJson()).members).toMatchObject([{ state: 'running', stage: 'spec' }, { state: 'blocked' }]);
    await f.ok('event', a, 'job.escalated', 'reason=stuck');
    expect(await epicJson()).toMatchObject({ state: 'waiting', waitingOn: 'members', members: [{ state: 'needs-human' }, { state: 'blocked' }] });
    expect(await f.ok('epic', 'show', 'auth')).toEqual([
      'epic auth  waiting  factory/epic/auth -> main',
      `waiting on members: nothing else can run; needs-human: a (${a})`,
      `member a  needs-human  ${a}`,
      `member b  blocked  blocked on a (${a})`,
    ]);
    await f.ok('event', a, 'job.reworked', 'k=1', 'maxRound=3');
    expect((await epicJson()).state).toBe('running');

    // a hand edit to the plan shows at the next rebuild
    await f.briefs('ready', 'c');
    await f.writePlan('auth', plan('ready', ['- `a`', '- `b` after: `a`', '- `c`']));
    expect((await epicJson()).members).toHaveLength(2);
    await rm(join(epicDir('auth'), 'epic.json'));
    expect(await f.ok('rebuild', a)).toEqual([`rebuilt 1: ${a}`, 'rebuilt epics 1: auth']);
    expect(((await epicJson()).members as unknown[]).length).toBe(3);
    expect(await f.ok('epic', 'next', 'auth')).toEqual(['claim c']);
    expect(await f.ok('rebuild', '--all')).toEqual([`rebuilt 1: ${a}`, 'rebuilt epics 1: auth']);
  });

  test('epic next: land when every member merged and no sync or fix job is live; nothing unless running', async () => {
    await f.start('auth', ['a']);
    await f.merge(await f.claimMember('auth', 'a'));
    expect(await f.ok('epic', 'next', 'auth')).toEqual(['land']);
    const fix = (await f.ok('claim', 'fix', 'epic=auth', 'kind=fix'))[0] ?? '';
    expect(await f.ok('epic', 'next', 'auth')).toEqual([]);
    await f.ok('abandon', fix, 'no', '--force');
    expect(await f.ok('epic', 'next', 'auth')).toEqual(['land']);
    await f.ok('epic', 'event', 'auth', 'epic.waiting', 'reason=checkout is on dev');
    expect(await f.ok('epic', 'next', 'auth')).toEqual([]);
    expect(await f.ok('epic', 'show', 'auth')).toEqual(['epic auth  waiting  factory/epic/auth -> main', 'waiting on you: checkout is on dev', 'member a  merged  001-a', `fix ${fix}  abandoned`]);
    expect((await f.cli('epic', 'next', 'nope')).err).toEqual(['epic nope has not started']);
  });

  test('an abandoned member is never offered again and blocks its dependents', async () => {
    await f.start('auth', ['a', 'b', 'c'], ['- `a`', '- `b` after: `a`', '- `c`']);
    const a = await f.claimMember('auth', 'a');
    await f.ok('abandon', a, 'wrong idea', '--force');
    expect(await f.ok('epic', 'next', 'auth')).toEqual(['claim c']);
    expect((await f.json('jobs', 'epics', 'auth', 'epic.json')).members).toMatchObject([{ slug: 'a', state: 'abandoned', job: a }, { slug: 'b', state: 'blocked', blockedOn: [{ member: 'a', job: a }] }, { slug: 'c', state: 'queued' }]);
  });
});

describe('epic abandon (AC5)', () => {
  test('refuses while a job is working, writing nothing; --force abandons them; the worktree goes, the branch stays', async () => {
    await f.start('auth', ['a', 'b']);
    const a = await f.claimMember('auth', 'a');
    const b = await f.claimMember('auth', 'b');
    await f.ok('event', b, 'job.escalated', 'reason=stuck');
    const before = await f.state();
    const r = await f.cli('epic', 'abandon', 'auth', 'dropped');
    expect(r).toEqual({ code: 1, out: [], err: [`epic auth: ${a} (claimed) is in a working stage; stop its session and pass --force`] });
    expect(await f.state()).toEqual(before);

    expect(await f.ok('epic', 'abandon', 'auth', 'dropped', '--force')).toEqual(['abandoned']);
    expect(await f.json('jobs', a, 'job.json')).toMatchObject({ stage: 'abandoned', note: 'epic auth abandoned: dropped' });
    expect(await f.json('jobs', b, 'job.json')).toMatchObject({ stage: 'abandoned' });
    const epic = await f.json('jobs', 'epics', 'auth', 'epic.json');
    expect(epic).toMatchObject({ state: 'abandoned', note: 'dropped', endedAt: expect.any(String) });
    expect(await exists(worktree('auth'))).toBe(false);
    expect(f.hasBranch('factory/epic/auth')).toBe(true);
    expect((await f.cli('epic', 'abandon', 'auth', 'again')).err).toEqual(['epic is abandoned (terminal): epic.abandoned not allowed']);
  });

  test('needs-human jobs are abandoned with the epic without --force; --delete-branch removes the branch', async () => {
    await f.start('auth', ['a']);
    const a = await f.claimMember('auth', 'a');
    await f.ok('event', a, 'job.escalated', 'reason=stuck');
    expect(await f.ok('epic', 'abandon', 'auth', 'dropped', '--delete-branch')).toEqual(['abandoned']);
    expect(await f.json('jobs', a, 'job.json')).toMatchObject({ stage: 'abandoned' });
    expect(f.hasBranch('factory/epic/auth')).toBe(false);
    expect(await exists(worktree('auth'))).toBe(false);
  });

  test('a landed epic is terminal; a bad slug is refused before any path', async () => {
    await f.start('auth', ['a']);
    await f.merge(await f.claimMember('auth', 'a'));
    await f.ok('epic', 'event', 'auth', 'epic.landing');
    await f.ok('epic', 'event', 'auth', 'epic.landed', 'sha=0123456');
    expect((await f.cli('epic', 'abandon', 'auth', 'x')).err).toEqual(['epic is landed (terminal): epic.abandoned not allowed']);
    expect((await f.cli('epic', 'abandon', '../x', 'x')).err[0]).toMatch(/must match/);
  });
});
