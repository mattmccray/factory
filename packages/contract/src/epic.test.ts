import { describe, expect, test } from 'bun:test';
import {
  PLAN_STATUSES,
  checkEpicTransition,
  epicNext,
  isEpicSettled,
  isSettled,
  memberClaimRefusal,
  parseEpicEventInput,
  parsePlan,
  planGraphError,
  planStartProblem,
  projectEpic,
  viewEpic,
} from './epic';
import type { EpicEvent, EpicEventInput, EpicJob, PlanMember } from './epic';

const plan = (status: string, members: string): string => `# Epic\n\n- Status: ${status}\n- Date: 2026-10-29\n\n## Intent\nWhy.\n\n## Members\n${members}\n`;

describe('the plan parser (AC6)', () => {
  test('accepts draft, ready, done, and abandoned; anything else is a status error', () => {
    for (const s of PLAN_STATUSES) expect(parsePlan(plan(s, '- `a`')).status).toBe(s);
    expect(PLAN_STATUSES).toEqual(['draft', 'ready', 'done', 'abandoned']);
    expect(parsePlan(plan('landed', '- `a`'))).toMatchObject({ status: null, statusError: 'has an unknown status (want draft|ready|done|abandoned)' });
    expect(parsePlan('# Epic\n\n## Members\n- `a`\n')).toMatchObject({ status: null, statusError: 'has no "- Status:" line' });
  });

  test('reads members in order with after: and maxRound:, free text and continuation lines allowed', () => {
    const p = parsePlan(plan('ready', ['- `a` — the first piece', '- `b` after: `a` maxRound: 4. Some prose', '- `c` — wraps', '  onto a second line, after: `a`, `b`', '', 'A prose line under the list.'].join('\n')));
    expect(p.errors).toEqual([]);
    expect(p.members).toEqual([
      { slug: 'a', after: [], maxRound: null },
      { slug: 'b', after: ['a'], maxRound: 4 },
      { slug: 'c', after: ['a', 'b'], maxRound: null },
    ]);
  });

  test('the section ends at the next heading', () => {
    const p = parsePlan(`${plan('ready', '- `a`')}\n## Notes\n- not a member\n`);
    expect(p.errors).toEqual([]);
    expect(p.members.map((m) => m.slug)).toEqual(['a']);
  });

  test('any other list item, a bad after: or maxRound:, and a duplicate member are malformed', () => {
    const cases: [string, RegExp][] = [
      ['- a without backticks', /line \d+ is malformed/],
      ['* `a`', /line \d+ is malformed/],
      ['1. `a`', /line \d+ is malformed/],
      ['- `Bad_Slug`', /member slug must match/],
      ['- `a` after: b', /malformed after:/],
      ['- `a` after: `Nope!`', /not a slug/],
      ['- `a` after: `b`, `b`', /twice/],
      ['- `a` after: `b` after: `c`', /more than one after:/],
      ['- `a` maxRound: 0', /malformed maxRound:/],
      ['- `a` maxRound: two', /malformed maxRound:/],
      ['- `a` maxRound: 2.5', /malformed maxRound:/],
      ['- `a`\n- `a`', /listed twice/],
    ];
    for (const [members, want] of cases) {
      const p = parsePlan(plan('ready', members));
      expect({ members, error: p.errors[0] ?? '' }).toEqual({ members, error: expect.stringMatching(want) });
    }
    expect(parsePlan(plan('ready', '')).errors).toEqual(['"## Members" lists no members']);
    expect(parsePlan('- Status: ready\n').errors).toEqual(['has no "## Members" section']);
  });

  test('graph: an after: naming a non-member, and cycles', () => {
    const m = (slug: string, ...after: string[]): PlanMember => ({ slug, after, maxRound: null });
    expect(planGraphError([m('a'), m('b', 'a')])).toBeNull();
    expect(planGraphError([m('a', 'x')])).toBe('member a is after x, which is not a member');
    expect(planGraphError([m('a', 'b'), m('b', 'a')])).toBe('the after: edges form a cycle: a -> b -> a');
    expect(planGraphError([m('a', 'a')])).toBe('the after: edges form a cycle: a -> a');
    expect(planGraphError([m('a'), m('b', 'c'), m('c', 'd'), m('d', 'b')])).toBe('the after: edges form a cycle: b -> c -> d -> b');
  });

  test('planStartProblem: one line per ground, in order', async () => {
    const briefs: Record<string, string> = { a: '# A\n\n- Status: ready\n', b: '# B\n\n- Status: draft\n' };
    const read = async (m: string): Promise<string | null> => briefs[m] ?? null;
    expect(await planStartProblem('e', null, read)).toBe('plan factory/epics/e.md is missing');
    expect(await planStartProblem('e', plan('draft', '- `a`'), read)).toBe('plan factory/epics/e.md is draft, not ready');
    expect(await planStartProblem('e', plan('ready', '- nope'), read)).toMatch(/^plan factory\/epics\/e\.md ## Members line \d+ is malformed/);
    expect(await planStartProblem('e', plan('ready', '- `a` after: `z`'), read)).toBe('plan factory/epics/e.md: member a is after z, which is not a member');
    expect(await planStartProblem('e', plan('ready', '- `a`\n- `b`'), read)).toBe('plan factory/epics/e.md: member brief factory/briefs/b.md is "draft", not ready');
    expect(await planStartProblem('e', plan('ready', '- `a`\n- `c`'), read)).toBe('plan factory/epics/e.md: member brief factory/briefs/c.md is missing');
    expect(await planStartProblem('e', plan('ready', '- `a`'), read)).toBeNull();
  });
});

const T0 = '2026-10-29T10:00:00.000Z';
const at = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();
const started: EpicEvent = { ts: T0, type: 'epic.started', schema: 'factory/v1', slug: 'e', target: 'main' };
const log = (...events: EpicEventInput[]): EpicEvent[] => [started, ...events.map((e, i) => ({ ...e, ts: at(i + 1) }))];

describe('epic events and transitions (AC2)', () => {
  test('session only on epic.started and epic.resumed; unknown fields rejected; sha stays a string', () => {
    expect(parseEpicEventInput('epic.resumed', { session: 't3code:env-1/thread-1' })).toEqual({ type: 'epic.resumed', session: { app: 't3code', environment: 'env-1', thread: 'thread-1' } });
    expect(parseEpicEventInput('epic.started', { session: 't3code:env-1/thread-1' }, { slug: 'e', target: 'main' })).toMatchObject({ slug: 'e', target: 'main', schema: 'factory/v1' });
    for (const type of ['epic.waiting', 'epic.landing', 'epic.landed', 'epic.abandoned']) {
      expect(() => parseEpicEventInput(type, { reason: 'r', sha: '1234567', session: 't3code:a/b' })).toThrow(/extra field/);
    }
    expect(() => parseEpicEventInput('epic.landing', { foo: '1' })).toThrow("epic.landing: extra field: unknown key 'foo'");
    expect(() => parseEpicEventInput('epic.waiting', {})).toThrow("missing or non-string field 'reason'");
    expect(parseEpicEventInput('epic.landed', { sha: '0123456' })).toEqual({ type: 'epic.landed', sha: '0123456' });
    expect(() => parseEpicEventInput('epic.exploded', {})).toThrow(/unknown epic event type/);
    expect(() => parseEpicEventInput('epic.started', {})).toThrow(/needs the slug and target/);
  });

  test('the allowed moves', () => {
    const ok = (prior: EpicEvent[], next: EpicEventInput, land: string | null = null) => expect(() => checkEpicTransition(prior, next, land)).not.toThrow();
    const no = (prior: EpicEvent[], next: EpicEventInput, want: RegExp, land: string | null = null) => expect(() => checkEpicTransition(prior, next, land)).toThrow(want);
    const waiting: EpicEventInput = { type: 'epic.waiting', reason: 'checkout is on dev' };
    ok([], { type: 'epic.started', schema: 'factory/v1', slug: 'e', target: 'main' });
    no([], waiting, /no epic log yet/);
    no(log(), { type: 'epic.started', schema: 'factory/v1', slug: 'e', target: 'main' }, /already started/);
    ok(log(), waiting);
    ok(log({ type: 'epic.landing' }), waiting);
    no(log(waiting), waiting, /not allowed from epic state 'waiting'/);
    ok(log(), { type: 'epic.resumed' });
    ok(log(waiting), { type: 'epic.resumed' });
    no(log({ type: 'epic.landing' }), { type: 'epic.resumed' }, /not allowed from epic state 'landing'/);
    ok(log(), { type: 'epic.landing' });
    no(log(), { type: 'epic.landing' }, /epic.landing refused: not every member has merged/, 'not every member has merged (a: running)');
    no(log(waiting), { type: 'epic.landing' }, /not allowed from epic state 'waiting'/);
    no(log(), { type: 'epic.landed', sha: 'abc1234' }, /not allowed from epic state 'running'/);
    ok(log({ type: 'epic.landing' }), { type: 'epic.landed', sha: 'abc1234' });
    const landed = log({ type: 'epic.landing' }, { type: 'epic.landed', sha: 'abc1234' });
    const abandoned = log({ type: 'epic.abandoned', reason: 'no' });
    for (const next of [waiting, { type: 'epic.resumed' }, { type: 'epic.abandoned', reason: 'x' }] satisfies EpicEventInput[]) {
      no(landed, next, /epic is landed \(terminal\)/);
      no(abandoned, next, /epic is abandoned \(terminal\)/);
    }
    ok(log(waiting), { type: 'epic.abandoned', reason: 'x' });
  });

  test('epic.resumed from a logged waiting returns to the state before it', () => {
    const fromLanding = log({ type: 'epic.landing' }, { type: 'epic.waiting', reason: 'checkout is on dev' }, { type: 'epic.resumed' });
    expect(projectEpic(fromLanding, [], []).state).toBe('landing');
    expect(() => checkEpicTransition(fromLanding, { type: 'epic.landed', sha: 'abc1234' })).not.toThrow();
    const fromRunning = log({ type: 'epic.waiting', reason: 'r' }, { type: 'epic.resumed' });
    expect(projectEpic(fromRunning, [], []).state).toBe('running');
  });
});

const job = (id: string, stage: string, member: string | null, kind: EpicJob['kind'] = 'member', updated: string | null = null): EpicJob => ({
  id, stage, kind, brief: member === null ? null : `factory/briefs/${member}.md`, updated,
});
const members = (...ms: [string, ...string[]][]): PlanMember[] => ms.map(([slug, ...after]) => ({ slug, after, maxRound: null }));

describe('epic.json, epic next (AC4)', () => {
  const PLAN = members(['a'], ['b'], ['c', 'a'], ['d', 'a', 'b']);

  test('members in plan order: queued, blocked naming unmerged after: members and their jobs, running at a stage, merged', () => {
    const snap = projectEpic(log(), PLAN, [job('053-a', 'merged', 'a', 'member', at(30)), job('054-b', 'review', 'b')]);
    expect(snap.members).toEqual([
      { slug: 'a', after: [], state: 'merged', job: '053-a', stage: 'merged', blockedOn: [] },
      { slug: 'b', after: [], state: 'running', job: '054-b', stage: 'review', blockedOn: [] },
      { slug: 'c', after: ['a'], state: 'queued', job: null, stage: null, blockedOn: [] },
      { slug: 'd', after: ['a', 'b'], state: 'blocked', job: null, stage: null, blockedOn: [{ member: 'b', job: '054-b' }] },
    ]);
    expect(snap.counts).toEqual({ queued: 1, blocked: 1, running: 1, merged: 1, 'needs-human': 0, abandoned: 0 });
    expect(snap).toMatchObject({ schema: 'factory/v1', slug: 'e', branch: 'factory/epic/e', target: 'main', plan: 'factory/epics/e.md', state: 'running', waitingOn: null, startedAt: T0, endedAt: null, updated: at(30) });
  });

  test('a member added to the plan mid-run appears; the newest job wins', () => {
    const jobs = [job('053-a', 'abandoned', 'a'), job('060-a', 'build', 'a')];
    const snap = projectEpic(log(), [...PLAN, { slug: 'e2', after: [], maxRound: null }], jobs);
    expect(snap.members.map((m) => [m.slug, m.state, m.job])).toEqual([['a', 'running', '060-a'], ['b', 'queued', null], ['c', 'blocked', null], ['d', 'blocked', null], ['e2', 'queued', null]]);
  });

  test('epic next: claims within the cap, in plan order; none while a sync job is live; land at the end', () => {
    expect(epicNext(viewEpic(log(), PLAN, []), 3)).toEqual(['claim a', 'claim b']);
    expect(epicNext(viewEpic(log(), PLAN, []), 1)).toEqual(['claim a']);
    expect(epicNext(viewEpic(log(), PLAN, [job('053-a', 'build', 'a')]), 1)).toEqual([]);
    // a needs-human member holds no slot
    expect(epicNext(viewEpic(log(), PLAN, [job('053-a', 'needs-human', 'a')]), 1)).toEqual(['claim b']);
    // sync and fix jobs don't count against the cap, but a live sync job stops every claim
    expect(epicNext(viewEpic(log(), PLAN, [job('053-s', 'build', null, 'fix')]), 1)).toEqual(['claim a']);
    expect(epicNext(viewEpic(log(), PLAN, [job('053-s', 'needs-human', null, 'sync')]), 3)).toEqual([]);
    const all = [job('053-a', 'merged', 'a'), job('054-b', 'merged', 'b'), job('055-c', 'merged', 'c'), job('056-d', 'merged', 'd')];
    expect(epicNext(viewEpic(log(), PLAN, all), 3)).toEqual(['land']);
    expect(epicNext(viewEpic(log(), PLAN, [...all, job('057-f', 'review', null, 'fix')]), 3)).toEqual([]);
    expect(epicNext(viewEpic(log(), PLAN, [...all, job('057-f', 'merged', null, 'fix')]), 3)).toEqual(['land']);
    // only while the logged state is running
    expect(epicNext(viewEpic(log({ type: 'epic.waiting', reason: 'r' }), PLAN, []), 3)).toEqual([]);
    expect(epicNext(viewEpic(log({ type: 'epic.landing' }), PLAN, all), 3)).toEqual([]);
  });

  test('an abandoned member is never offered again and blocks its dependents', () => {
    const view = viewEpic(log(), PLAN, [job('053-a', 'abandoned', 'a')]);
    expect(view.members.find((m) => m.slug === 'a')?.state).toBe('abandoned');
    expect(view.members.find((m) => m.slug === 'c')).toMatchObject({ state: 'blocked', blockedOn: [{ member: 'a', job: '053-a' }] });
    expect(epicNext(view, 3)).toEqual(['claim b']);
  });

  test('derived waiting: nothing can run, nothing working, something in needs-human', () => {
    const ab = members(['a'], ['b', 'a']);
    const snap = projectEpic(log(), ab, [job('053-a', 'needs-human', 'a')]);
    expect(snap).toMatchObject({ state: 'waiting', waitingOn: 'members', note: '' });
    // still something runnable: not waiting
    expect(projectEpic(log(), members(['a'], ['b']), [job('053-a', 'needs-human', 'a')]).state).toBe('running');
    // something working: not waiting
    expect(projectEpic(log(), ab, [job('053-a', 'needs-human', 'a'), job('054-f', 'build', null, 'fix')]).state).toBe('running');
    // a fix job escalating while landing makes the epic wait on Matt
    const merged = [job('053-a', 'merged', 'a'), job('054-b', 'merged', 'b'), job('055-f', 'needs-human', null, 'fix')];
    expect(projectEpic(log({ type: 'epic.landing' }), ab, merged)).toMatchObject({ state: 'waiting', waitingOn: 'members' });
  });

  test('logged waiting: waitingOn you with the reason; resumed clears it and records the session', () => {
    const w = projectEpic(log({ type: 'epic.waiting', reason: 'checkout is on dev' }), PLAN, []);
    expect(w).toMatchObject({ state: 'waiting', waitingOn: 'you', note: 'checkout is on dev' });
    const session = { app: 't3code' as const, environment: 'env', thread: 'th' };
    const r = projectEpic(log({ type: 'epic.waiting', reason: 'r' }, { type: 'epic.resumed', session }), PLAN, []);
    expect(r).toMatchObject({ state: 'running', waitingOn: null, note: '', session });
  });

  test('landed and abandoned are terminal with endedAt; generated jobs are listed', () => {
    const landed = projectEpic(log({ type: 'epic.landing' }, { type: 'epic.landed', sha: 'abc1234' }), members(['a']), [job('053-a', 'merged', 'a'), job('054-s', 'merged', null, 'sync')]);
    expect(landed).toMatchObject({ state: 'landed', waitingOn: null, sha: 'abc1234', note: 'landed abc1234', endedAt: at(2), generated: [{ id: '054-s', kind: 'sync', stage: 'merged' }] });
    const abandoned = projectEpic(log({ type: 'epic.abandoned', reason: 'gave up' }), members(['a']), [job('053-a', 'needs-human', 'a')]);
    expect(abandoned).toMatchObject({ state: 'abandoned', waitingOn: null, note: 'gave up', endedAt: at(1) });
  });

  test('memberClaimRefusal names each refusal', () => {
    const view = viewEpic(log(), PLAN, [job('053-a', 'build', 'a')]);
    expect(memberClaimRefusal(view, 'zz', 3)).toBe('factory/briefs/zz.md is not listed in the plan\'s ## Members');
    expect(memberClaimRefusal(view, 'a', 3)).toBe('member a already has job 053-a (build)');
    expect(memberClaimRefusal(view, 'c', 3)).toBe('member c waits on a (053-a), not yet merged');
    expect(memberClaimRefusal(view, 'b', 1)).toBe('1 members are working, at epic.maxParallel 1');
    expect(memberClaimRefusal(view, 'b', 3)).toBeNull();
    const sync = viewEpic(log(), PLAN, [job('053-s', 'build', null, 'sync')]);
    expect(memberClaimRefusal(sync, 'a', 3)).toBe('sync job 053-s is live: no member is claimed until it is merged or abandoned');
  });
});

describe('the epic-aware settle rule (AC7)', () => {
  const H = 24;
  const now = Date.parse('2026-10-31T00:00:00.000Z');
  const old = '2026-10-29T00:00:00.000Z';
  const fresh = '2026-10-30T12:00:00.000Z';
  test('an epic settles like a job', () => {
    expect(isEpicSettled({ state: 'abandoned', endedAt: fresh }, H, now)).toBe(true);
    expect(isEpicSettled({ state: 'landed', endedAt: old }, H, now)).toBe(true);
    expect(isEpicSettled({ state: 'landed', endedAt: fresh }, H, now)).toBe(false);
    expect(isEpicSettled({ state: 'running', endedAt: null }, H, now)).toBe(false);
  });
  test('a standalone job: the contract rule, unchanged', () => {
    expect(isSettled({ stage: 'abandoned', endedAt: fresh }, H, now)).toBe(true);
    expect(isSettled({ stage: 'merged', endedAt: old, epic: null }, H, now)).toBe(true);
    expect(isSettled({ stage: 'merged', endedAt: fresh }, H, now)).toBe(false);
    expect(isSettled({ stage: 'merged', endedAt: 'garbage' }, H, now)).toBe(false);
    expect(isSettled({ stage: 'needs-human', endedAt: null }, H, now)).toBe(false);
  });
  test('a member of a running epic is never settled; once it lands, members settle by the epic endedAt', () => {
    const member = { stage: 'merged', endedAt: old, epic: 'e' };
    expect(isSettled(member, H, now, { state: 'running', endedAt: null })).toBe(false);
    expect(isSettled(member, H, now, { state: 'waiting', endedAt: null })).toBe(false);
    expect(isSettled(member, H, now, null)).toBe(false);
    expect(isSettled({ ...member, stage: 'abandoned' }, H, now, { state: 'running', endedAt: null })).toBe(false);
    expect(isSettled(member, H, now, { state: 'landed', endedAt: fresh })).toBe(false);
    expect(isSettled({ ...member, endedAt: fresh }, H, now, { state: 'landed', endedAt: old })).toBe(true);
    expect(isSettled(member, H, now, { state: 'abandoned', endedAt: fresh })).toBe(true);
    expect(isSettled({ ...member, stage: 'abandoned' }, H, now, { state: 'landed', endedAt: fresh })).toBe(true);
  });
});
