import { expect, test } from 'bun:test';
import { diffBoard, diffEpics, epicNoticeText, noBaselines, noEpicBaselines, noticeText, projectLabel, retainProjects } from './notify';
import type { Baselines, Notice } from './notify';
import type { AppEpic, AppJob } from './state';

const P = 'aaaaaaaaaaaa';
const Q = 'bbbbbbbbbbbb';
const job = (id: string, stage: string, note = ''): AppJob => ({ id, title: `Title ${id}`, stage, note });

function run(base: Baselines, pid: string, jobs: AppJob[]): { base: Baselines; notices: Notice[] } {
  return diffBoard(base, pid, jobs);
}

test('AC2: the baseline board notifies nothing, even for jobs already in needs-human or merged', () => {
  const r = run(noBaselines(), P, [job('001-a', 'needs-human', 'stuck'), job('002-b', 'merged'), job('003-c', 'build')]);
  expect(r.notices).toEqual([]);
  expect(r.base[P]).toEqual({ '001-a': 'needs-human', '002-b': 'merged', '003-c': 'build' });
});

test('AC2: a move into needs-human sends one notice with the title and note; a move into merged sends one', () => {
  let base = run(noBaselines(), P, [job('001-a', 'review'), job('002-b', 'approved'), job('003-c', 'spec')]).base;
  const r = run(base, P, [job('001-a', 'needs-human', 'review round limit reached'), job('002-b', 'merged', 'merged 3e45678'), job('003-c', 'build')]);
  expect(r.notices).toEqual([
    { kind: 'needs-human', project: P, job: '001-a', title: 'Title 001-a', note: 'review round limit reached' },
    { kind: 'merged', project: P, job: '002-b', title: 'Title 002-b', note: 'merged 3e45678' },
  ]);
  base = r.base;

  // merge.failed: approved -> needs-human, from any working stage
  const failed = run(run(base, P, [job('004-d', 'approved')]).base, P, [job('004-d', 'needs-human', 'merge conflict')]);
  expect(failed.notices).toEqual([{ kind: 'needs-human', project: P, job: '004-d', title: 'Title 004-d', note: 'merge conflict' }]);
});

test('AC2: a repeated board with the same stages notifies nothing', () => {
  const jobs = [job('001-a', 'needs-human', 'x'), job('002-b', 'merged')];
  const first = run(run(noBaselines(), P, [job('001-a', 'build'), job('002-b', 'approved')]).base, P, jobs);
  expect(first.notices).toHaveLength(2);
  expect(run(first.base, P, jobs).notices).toEqual([]);
  expect(run(run(first.base, P, jobs).base, P, jobs).notices).toEqual([]);
});

test('AC2: a job first seen after the baseline notifies only if it arrives in needs-human or merged', () => {
  const base = run(noBaselines(), P, []).base;
  const r = run(base, P, [job('005-e', 'spec'), job('006-f', 'needs-human', 'why'), job('007-g', 'merged', 'merged abc')]);
  expect(r.notices.map((n) => [n.kind, n.job])).toEqual([
    ['needs-human', '006-f'],
    ['merged', '007-g'],
  ]);
});

test('AC2: a reconnect re-baselines without notifying', () => {
  const before = run(noBaselines(), P, [job('001-a', 'review')]).base;
  // The Mac app resets its baselines when a stream opens; the next board is a baseline again.
  const after = run(noBaselines(), P, [job('001-a', 'needs-human', 'x')]);
  expect(after.notices).toEqual([]);
  expect(run(before, P, [job('001-a', 'needs-human', 'x')]).notices).toHaveLength(1);
});

test('AC2: a project dropped from projects loses its baseline; baselines are per project', () => {
  let base = run(noBaselines(), P, [job('001-a', 'review')]).base;
  base = run(base, Q, [job('001-a', 'review')]).base;
  base = retainProjects(base, [Q]);
  expect(base[P]).toBeUndefined();
  expect(base[Q]).toEqual({ '001-a': 'review' });
  // P comes back: its first board is a baseline again
  expect(run(base, P, [job('001-a', 'needs-human')]).notices).toEqual([]);
  // the same job id in Q is keyed separately
  expect(run(base, Q, [job('001-a', 'needs-human')]).notices).toHaveLength(1);
});

test('notice text carries the job title (or id) and its note', () => {
  expect(noticeText({ kind: 'needs-human', project: P, job: '001-a', title: 'Fix it', note: 'stuck' }, 'factory')).toEqual({
    title: 'Fix it needs a human',
    subtitle: 'factory · 001-a',
    body: 'stuck',
  });
  expect(noticeText({ kind: 'merged', project: P, job: '001-a', title: '', note: 'merged abc' }, '')).toEqual({ title: '001-a merged', subtitle: '001-a', body: 'merged abc' });
});

// ---- epics (056 AC8) ----

const epic = (slug: string, state: string, waitingOn: string | null = null, note = '', members = 3): AppEpic => ({ slug, name: slug === 'auth' ? 'Auth rewrite' : slug, state, waitingOn, note, members });

test('056 AC8: a job with an epic reaching merged does not notify; its escalation to needs-human still does', () => {
  const inEpic = (id: string, stage: string, note = ''): AppJob => ({ ...job(id, stage, note), epic: 'auth' });
  const base = run(noBaselines(), P, [inEpic('001-a', 'approve'), inEpic('002-b', 'review'), job('003-c', 'approve')]).base;
  const r = run(base, P, [inEpic('001-a', 'merged', 'merged abc'), inEpic('002-b', 'needs-human', 'round limit'), job('003-c', 'merged', 'merged def')]);
  expect(r.notices.map((n) => [n.kind, n.job])).toEqual([
    ['needs-human', '002-b'],
    ['merged', '003-c'],
  ]);
  // first seen after the baseline, already merged: still nothing
  expect(run(base, P, [inEpic('004-d', 'merged')]).notices).toEqual([]);
});

test('056 AC8: an epic entering landed notifies "Epic landed" with its name and member count', () => {
  const base = diffEpics(noEpicBaselines(), P, [epic('auth', 'landing')]).base;
  const r = diffEpics(base, P, [epic('auth', 'landed', null, 'landed abc1234', 4)]);
  expect(r.notices).toEqual([{ kind: 'epic-landed', project: P, epic: 'auth', name: 'Auth rewrite', members: 4, note: 'landed abc1234' }]);
  expect(epicNoticeText(r.notices[0] ?? { kind: 'epic-landed', project: P, epic: '', name: '', members: 0, note: '' }, 'factory')).toEqual({ title: 'Epic landed', subtitle: 'factory · Auth rewrite', body: 'Auth rewrite: 4 members' });
  expect(diffEpics(r.base, P, [epic('auth', 'landed')]).notices).toEqual([]); // once
});

test('056 AC8: an epic newly waiting on you notifies "Epic waiting on you" with its note as the reason', () => {
  let base = diffEpics(noEpicBaselines(), P, [epic('auth', 'running'), epic('billing', 'waiting', 'members')]).base;
  const r = diffEpics(base, P, [epic('auth', 'waiting', 'you', 'checkout is on dev'), epic('billing', 'waiting', 'members')]);
  expect(r.notices.map((n) => [n.kind, n.epic, n.note])).toEqual([['epic-waiting', 'auth', 'checkout is on dev']]);
  expect(epicNoticeText(r.notices[0] ?? { kind: 'epic-waiting', project: P, epic: '', name: '', members: 0, note: '' }, '')).toEqual({ title: 'Epic waiting on you', subtitle: 'Auth rewrite', body: 'checkout is on dev' });
  base = r.base;
  expect(diffEpics(base, P, [epic('auth', 'waiting', 'you', 'checkout is on dev')]).notices).toEqual([]); // still waiting: once
  // resumed, then waiting again: notifies again
  const resumed = diffEpics(base, P, [epic('auth', 'running')]).base;
  expect(diffEpics(resumed, P, [epic('auth', 'waiting', 'you', 'gate red')]).notices).toHaveLength(1);
  // first seen after the baseline, already waiting on you
  expect(diffEpics(base, P, [epic('new', 'waiting', 'you', 'why')]).notices.map((n) => n.epic)).toEqual(['new']);
});

test("056 AC8: a project's first board notifies nothing, epics included; baselines are per project", () => {
  expect(diffEpics(noEpicBaselines(), P, [epic('auth', 'landed'), epic('billing', 'waiting', 'you', 'x')]).notices).toEqual([]);
  let base = diffEpics(noEpicBaselines(), P, [epic('auth', 'running')]).base;
  base = retainProjects(base, [Q]);
  expect(diffEpics(base, P, [epic('auth', 'landed')]).notices).toEqual([]); // dropped and back: a baseline again
});

// ---- machines (081) ----

const S = '1a2b3c4d5e6f@studio';

test('081 AC3: a remote project is labeled `<name> · <machine>`; a local one by its name, as today', () => {
  expect(projectLabel({ name: 'factory', machine: 'studio' })).toBe('factory · studio');
  expect(projectLabel({ name: '', machine: 'studio' })).toBe('studio');
  expect(projectLabel({ name: 'factory', machine: null })).toBe('factory');
  expect(projectLabel({ name: '', machine: null })).toBe('');
});

test('081 AC3: a remote job or epic notice names the machine in its subtitle; titles and bodies are unchanged', () => {
  const label = projectLabel({ name: 'factory', machine: 'studio' });
  const base = diffBoard(noBaselines(), S, [job('081-x', 'review'), job('082-y', 'approved')]).base;
  const r = diffBoard(base, S, [job('081-x', 'needs-human', 'round limit'), job('082-y', 'merged', 'merged abc1234')]);
  expect(r.notices.map((n) => noticeText(n, label))).toEqual([
    { title: 'Title 081-x needs a human', subtitle: 'factory · studio · 081-x', body: 'round limit' },
    { title: 'Title 082-y merged', subtitle: 'factory · studio · 082-y', body: 'merged abc1234' },
  ]);
  const eBase = diffEpics(noEpicBaselines(), S, [epic('auth', 'landing'), epic('billing', 'running')]).base;
  const e = diffEpics(eBase, S, [epic('auth', 'landed', null, '', 2), epic('billing', 'waiting', 'you', 'gate red')]);
  expect(e.notices.map((n) => epicNoticeText(n, label))).toEqual([
    { title: 'Epic landed', subtitle: 'factory · studio · Auth rewrite', body: 'Auth rewrite: 2 members' },
    { title: 'Epic waiting on you', subtitle: 'factory · studio · billing', body: 'gate red' },
  ]);
  // the same notices on a local project read as today
  const local = projectLabel({ name: 'factory', machine: null });
  expect(r.notices.map((n) => noticeText(n, local).subtitle)).toEqual(['factory · 081-x', 'factory · 082-y']);
  expect(e.notices.map((n) => epicNoticeText(n, local).subtitle)).toEqual(['factory · Auth rewrite', 'factory · billing']);
});
