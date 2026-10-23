import { describe, expect, test } from 'bun:test';
import { fetchDocs } from './api';
import type { Fetcher } from './api';
import { buildBoard } from './board';
import { HOUR, NOW, before } from './fixtures';
import { ALL, SELECTION_KEY, boardJobs, docsPath, loadSelection, needsHuman, projectErrors, resolveSelection, reviewersFor, saveSelection } from './projects';
import { applyEvent, emptyState } from './state';
import type { UiState } from './state';

const P1 = { id: 'aaaaaaaaaaaa', name: 'one', root: '/r/one' };
const P2 = { id: 'bbbbbbbbbbbb', name: 'two', root: '/r/two' };

function state(): UiState {
  let s = applyEvent(emptyState(), 'projects', { projects: [P1, P2] });
  s = applyEvent(s, 'board', {
    project: P1.id,
    config: { reviewers: ['code', 'security'], dashboard: { settleAfterHours: 2 } },
    jobs: [
      { id: '001-same-id', stage: 'needs-human', updated: before(HOUR) },
      { id: '002-merged', stage: 'merged', endedAt: before(3 * HOUR), updated: before(3 * HOUR) },
      { id: '003-human', stage: 'needs-human', updated: before(HOUR) },
    ],
  });
  s = applyEvent(s, 'board', {
    project: P2.id,
    config: { reviewers: ['security', 'ui'] }, // no settleAfterHours: 24
    jobs: [
      { id: '001-same-id', stage: 'needs-human', updated: before(2 * HOUR) },
      { id: '002-merged', stage: 'merged', endedAt: before(3 * HOUR), updated: before(3 * HOUR) },
    ],
  });
  return s;
}

describe('All projects (AC4)', () => {
  test('the merged board holds every job, tagged with its project, with no key collisions', () => {
    const jobs = boardJobs(state(), ALL);
    expect(jobs.map((b) => [b.key, b.project.name])).toEqual([
      [`${P1.id}/001-same-id`, 'one'],
      [`${P1.id}/002-merged`, 'one'],
      [`${P1.id}/003-human`, 'one'],
      [`${P2.id}/001-same-id`, 'two'],
      [`${P2.id}/002-merged`, 'two'],
    ]);
    expect(new Set(jobs.map((b) => b.key)).size).toBe(jobs.length);
  });

  test('each project keeps its own settleAfterHours (a missing one is 24)', () => {
    const board = buildBoard(boardJobs(state(), ALL), NOW);
    expect(board.settled.map((b) => b.key)).toEqual([`${P1.id}/002-merged`]);
    expect(board.columns.find((c) => c.key === 'merged')?.jobs.map((b) => b.key)).toEqual([`${P2.id}/002-merged`]);
  });

  test('needs-human counts per project and in total equal the needs-human jobs', () => {
    const s = state();
    expect(needsHuman(s)).toEqual({ byProject: { [P1.id]: 2, [P2.id]: 1 }, total: 3 });
    expect(buildBoard(boardJobs(s, ALL), NOW).andon).toHaveLength(3);
  });

  test('one project shows only its jobs; the Review column lists the selection\'s reviewers', () => {
    const s = state();
    expect(boardJobs(s, P2.id).map((b) => b.key)).toEqual([`${P2.id}/001-same-id`, `${P2.id}/002-merged`]);
    expect(reviewersFor(s, P2.id)).toEqual(['security', 'ui']);
    expect(reviewersFor(s, ALL)).toEqual(['code', 'security', 'ui']);
  });

  test('opening a card requests its own project\'s docs', async () => {
    const [, , , other] = boardJobs(state(), ALL);
    if (other === undefined) throw new Error('missing job');
    expect(docsPath(other)).toBe(`/projects/${P2.id}/jobs/001-same-id/docs`);
    const asked: string[] = [];
    const fetcher: Fetcher = async (path) => {
      asked.push(path);
      return { ok: true, status: 200, text: async () => JSON.stringify({ files: [{ path: 'jobs/001-same-id/spec.md', text: '# Spec' }, { path: 1 }] }) };
    };
    expect(await fetchDocs(fetcher, other)).toEqual([{ path: 'jobs/001-same-id/spec.md', text: '# Spec' }]);
    expect(asked).toEqual([`/projects/${P2.id}/jobs/001-same-id/docs`]);
  });

  test('a bad config shows per project in the selection', () => {
    const s = applyEvent(state(), 'error', { project: P2.id, reason: 'config.json: bad' });
    expect(projectErrors(s, ALL)).toEqual([{ id: P2.id, name: 'two', reason: 'config.json: bad' }]);
    expect(projectErrors(s, P1.id)).toEqual([]);
  });
});

describe('the selection persists', () => {
  const store = (): { data: Map<string, string>; getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };

  test('saved and loaded through localStorage, defaulting to All projects', () => {
    const s = store();
    expect(loadSelection(s)).toBe(ALL);
    saveSelection(s, P2.id);
    expect(s.data.get(SELECTION_KEY)).toBe(P2.id);
    expect(loadSelection(s)).toBe(P2.id);
    expect(loadSelection(null)).toBe(ALL);
    const blocked = { getItem: (): string | null => { throw new Error('blocked'); }, setItem: (): void => { throw new Error('blocked'); } };
    expect(loadSelection(blocked)).toBe(ALL);
    expect(() => saveSelection(blocked, P1.id)).not.toThrow();
  });

  test('a stored project that is no longer registered shows All projects', () => {
    expect(resolveSelection(state(), P1.id)).toBe(P1.id);
    expect(resolveSelection(state(), 'gone')).toBe(ALL);
  });
});
