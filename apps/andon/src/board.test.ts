import { describe, expect, test } from 'bun:test';
import { buildBoard, chipRounds, movement, roundKeys } from './board';
import { HOUR, NOW, before, job, tag } from './fixtures';
import { toConfig } from './job';

describe('buildBoard (AC1)', () => {
  const jobs = [
    job({ id: '001-claimed', stage: 'claimed', updated: before(9 * HOUR) }),
    job({ id: '002-spec', stage: 'spec', updated: before(2 * HOUR) }),
    job({ id: '003-spec-newer', stage: 'spec', updated: before(1 * HOUR) }),
    job({ id: '004-build', stage: 'build', updated: before(3 * HOUR) }),
    job({ id: '005-review', stage: 'review', updated: before(4 * HOUR) }),
    job({ id: '006-approve', stage: 'approve', updated: before(5 * HOUR) }),
    job({ id: '007-human', stage: 'needs-human', updated: before(6 * HOUR) }),
    job({ id: '008-merged-fresh', stage: 'merged', endedAt: before(23 * HOUR), updated: before(23 * HOUR) }),
    job({ id: '009-merged-old', stage: 'merged', endedAt: before(30 * HOUR), updated: before(1 * HOUR) }),
    job({ id: '010-merged-older', stage: 'merged', endedAt: before(50 * HOUR), updated: before(50 * HOUR) }),
    job({ id: '011-legacy-old', stage: 'merged', updated: before(40 * HOUR) }), // no endedAt: merge time is `updated`
    job({ id: '012-legacy-fresh', stage: 'merged', updated: before(2 * HOUR) }),
  ].map((j) => tag(j));
  const board = buildBoard(jobs, NOW);
  const ids = (list: Array<{ job: { id: string } }>): string[] => list.map((b) => b.job.id);
  const column = (key: string): string[] => ids(board.columns.find((c) => c.key === key)?.jobs ?? []);

  test('merged jobs older than settleAfterHours are settled, newest merge first, and leave the Merged column', () => {
    expect(ids(board.settled)).toEqual(['009-merged-old', '011-legacy-old', '010-merged-older']);
    expect(column('merged')).toEqual(['012-legacy-fresh', '008-merged-fresh']);
  });

  test('needs-human jobs are in the andon row', () => {
    expect(ids(board.andon)).toEqual(['007-human']);
    expect(board.columns.flatMap((c) => ids(c.jobs))).not.toContain('007-human');
  });

  test('every other job is in its stage column (claimed under Spec), updated descending', () => {
    expect(board.columns.map((c) => c.key)).toEqual(['spec', 'build', 'review', 'approve', 'merged']);
    expect(column('spec')).toEqual(['003-spec-newer', '002-spec', '001-claimed']);
    expect(column('build')).toEqual(['004-build']);
    expect(column('review')).toEqual(['005-review']);
    expect(column('approve')).toEqual(['006-approve']);
    expect(board.running).toBe(6);
    expect(board.waiting).toBe(1);
  });

  test('a missing settleAfterHours defaults to 24', () => {
    expect(toConfig({ reviewers: [] }).settleAfterHours).toBe(24);
    expect(toConfig({ dashboard: {} }).settleAfterHours).toBe(24);
    expect(toConfig({ dashboard: { settleAfterHours: 2 } }).settleAfterHours).toBe(2);
  });

  test('a job settles at the threshold as `now` moves, with no new data', () => {
    const one = [tag(job({ id: '001-a', stage: 'merged', endedAt: before(24 * HOUR - 1000) }))];
    expect(buildBoard(one, NOW).settled).toHaveLength(0);
    expect(buildBoard(one, NOW + 2000).settled).toHaveLength(1);
  });

  test('the Review column names the reviewers', () => {
    expect(buildBoard([], NOW, ['security', 'code']).columns[2]?.who).toBe('security · code');
  });
});

describe('cards', () => {
  test('chip rounds: past rounds then the current one, reviewers in config order with unknown keys last', () => {
    const j = job({ id: '001-a', round: 2, reviews: { zeta: 'pending', code: 'PASS', security: 'CHANGES' }, history: [{ round: 1, reviews: { code: 'CHANGES' } }] });
    expect(chipRounds(j).map((r) => [r.round, r.past])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(roundKeys(j.reviews, ['security', 'code'])).toEqual(['security', 'code', 'zeta']);
  });

  test('movement finds new cards and cards that changed stage', () => {
    const a = tag(job({ id: '001-a', stage: 'build' }));
    const b = tag(job({ id: '002-b', stage: 'review' }));
    const m = movement(new Map([['p1/001-a', 'spec'], ['p1/002-b', 'review']]), [a, b, tag(job({ id: '003-c' }))]);
    expect([...m.fresh]).toEqual(['p1/003-c']);
    expect([...m.moved]).toEqual(['p1/001-a']);
  });
});
