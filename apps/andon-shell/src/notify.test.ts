import { expect, test } from 'bun:test';
import { diffBoard, noBaselines, noticeText, retainProjects } from './notify';
import type { Baselines, Notice } from './notify';
import type { ShellJob } from './state';

const P = 'aaaaaaaaaaaa';
const Q = 'bbbbbbbbbbbb';
const job = (id: string, stage: string, note = ''): ShellJob => ({ id, title: `Title ${id}`, stage, note });

function run(base: Baselines, pid: string, jobs: ShellJob[]): { base: Baselines; notices: Notice[] } {
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
  // The shell resets its baselines when a stream opens; the next board is a baseline again.
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
