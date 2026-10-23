import { describe, expect, test } from 'bun:test';
import { applyEvent, applyFetched, emptyState, revOf } from './state';
import type { UiState } from './state';

const P1 = { id: 'aaaaaaaaaaaa', name: 'one', root: '/r/one' };
const P2 = { id: 'bbbbbbbbbbbb', name: 'two', root: '/r/two' };
const config = (reviewers: string[], settleAfterHours = 24) => ({ schema: 'factory/v1', reviewers, maxRound: 2, dashboard: { settleAfterHours } });

function twoProjects(): UiState {
  let s = applyEvent(emptyState(), 'projects', { projects: [P1, P2] });
  s = applyEvent(s, 'board', { project: P1.id, jobs: [{ id: '001-a', stage: 'spec' }], config: config(['code']) });
  s = applyEvent(s, 'board', { project: P2.id, jobs: [{ id: '001-a', stage: 'build' }], config: config(['security'], 6) });
  return s;
}

describe('applying agent events (AC3)', () => {
  test('a projects event replaces the project list, keeping boards of projects still listed', () => {
    const P3 = { id: 'cccccccccccc', name: 'three', root: '/r/three' };
    const s = applyEvent(twoProjects(), 'projects', { projects: [P2, P3] });
    expect(s.projects).toEqual([P2, P3]);
    expect(Object.keys(s.boards).sort()).toEqual([P2.id, P3.id]);
    expect(s.boards[P2.id]?.jobs.map((j) => j.stage)).toEqual(['build']);
    expect(s.boards[P3.id]?.loaded).toBe(false);
  });

  test('a board event changes only the named project, and an error event keeps the last board', () => {
    const before = twoProjects();
    let s = applyEvent(before, 'board', { project: P1.id, jobs: [{ id: '001-a', stage: 'review' }, { id: '002-b', stage: 'spec' }], config: config(['code', 'ui'], 12) });
    s = applyEvent(s, 'error', { project: P2.id, reason: 'config.json: maxRound must be a positive integer' });
    expect(s.projects).toEqual(before.projects);
    expect(s.boards[P1.id]?.jobs.map((j) => `${j.id}:${j.stage}`)).toEqual(['001-a:review', '002-b:spec']);
    expect(s.boards[P1.id]?.config).toEqual({ reviewers: ['code', 'ui'], settleAfterHours: 12 });
    expect(s.boards[P1.id]?.error).toBeNull();
    expect(s.boards[P2.id]?.error).toBe('config.json: maxRound must be a positive integer');
    expect(s.boards[P2.id]?.jobs).toEqual(before.boards[P2.id]?.jobs ?? []);
    expect(s.boards[P2.id]?.config).toEqual(before.boards[P2.id]?.config ?? { reviewers: [], settleAfterHours: 0 });
  });

  test('a later board clears the error', () => {
    let s = applyEvent(twoProjects(), 'error', { project: P2.id, reason: 'config.json: bad' });
    s = applyEvent(s, 'board', { project: P2.id, jobs: [], config: config([]) });
    expect(s.boards[P2.id]?.error).toBeNull();
  });

  test('a board for an unknown project id is ignored', () => {
    const before = twoProjects();
    expect(applyEvent(before, 'board', { project: 'ffffffffffff', jobs: [{ id: '001-x' }], config: config([]) })).toBe(before);
    expect(applyEvent(before, 'error', { project: 'ffffffffffff', reason: 'x' })).toBe(before);
  });

  test('unknown job.json fields, unknown events, and malformed data are tolerated', () => {
    const before = twoProjects();
    const s = applyEvent(before, 'board', {
      project: P1.id,
      jobs: [{ id: '001-a', stage: 'spec', futureField: { nested: true }, timing: { stages: [], agents: [], future: 1 } }, { title: 'no id' }, 7],
      config: config(['code']),
      extra: 'ignored',
    });
    expect(s.boards[P1.id]?.jobs.map((j) => j.id)).toEqual(['001-a']);
    expect(s.boards[P1.id]?.jobs[0]?.timing).toEqual({ stages: [], agents: [] });
    expect(applyEvent(before, 'heartbeat', { project: P1.id })).toBe(before);
    expect(applyEvent(before, 'board', null)).toBe(before);
    expect(applyEvent(before, 'projects', { nope: 1 })).toBe(before);
  });
});

describe('fetched boards', () => {
  test('a fetched board applies unless an event for that project arrived after the request', () => {
    const s = twoProjects();
    const rev = revOf(s, P1.id);
    const fetched: { ok: true; data: unknown } = { ok: true, data: { jobs: [{ id: '009-old' }], config: config([]) } };
    const newer = applyEvent(s, 'board', { project: P1.id, jobs: [{ id: '010-new' }], config: config([]) });
    expect(applyFetched(newer, P1.id, rev, fetched)).toBe(newer);
    expect(applyFetched(s, P1.id, rev, fetched).boards[P1.id]?.jobs.map((j) => j.id)).toEqual(['009-old']);
    expect(applyFetched(s, P1.id, rev, { ok: false, reason: 'config.json: bad' }).boards[P1.id]?.error).toBe('config.json: bad');
  });
});
