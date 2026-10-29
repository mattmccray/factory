import { describe, expect, test } from 'bun:test';
import { buildBoard, chipRounds, isSettled, mergedAt, movement, roundKeys, settledCount, settledJobs } from './board';
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

describe('abandoned jobs (AC5)', () => {
  const jobs = [
    job({ id: '001-build', stage: 'build', updated: before(1 * HOUR) }),
    job({ id: '002-human', stage: 'needs-human', updated: before(2 * HOUR) }),
    job({ id: '003-abandoned-fresh', stage: 'abandoned', endedAt: before(1 * HOUR), updated: before(1 * HOUR), stoppedBy: 'escalated', stoppedFrom: 'review' }),
    job({ id: '004-merged-old', stage: 'merged', endedAt: before(30 * HOUR), updated: before(30 * HOUR) }),
    job({ id: '005-abandoned-old', stage: 'abandoned', endedAt: before(40 * HOUR), updated: before(40 * HOUR) }),
    job({ id: '006-merged-older', stage: 'merged', endedAt: before(50 * HOUR), updated: before(50 * HOUR) }),
    job({ id: '007-abandoned-now', stage: 'abandoned', endedAt: before(0), updated: before(0) }),
  ].map((j) => tag(j));
  const board = buildBoard(jobs, NOW);
  const ids = (list: Array<{ job: { id: string } }>): string[] => list.map((b) => b.job.id);

  test('an abandoned job is settled regardless of settleAfterHours, newest endedAt first, mixed with merged', () => {
    expect(ids(board.settled)).toEqual(['007-abandoned-now', '003-abandoned-fresh', '004-merged-old', '005-abandoned-old', '006-merged-older']);
    expect(isSettled(tag(job({ id: '008-a', stage: 'abandoned', endedAt: before(0) }), undefined, 1000), NOW)).toBe(true);
  });

  test('an abandoned job is in no column, not the andon row, and not counted', () => {
    const onBoard = [...ids(board.andon), ...board.columns.flatMap((c) => ids(c.jobs))];
    expect(onBoard.filter((id) => id.includes('abandoned'))).toEqual([]);
    expect(ids(board.andon)).toEqual(['002-human']);
    expect(board.running).toBe(1);
    expect(board.waiting).toBe(1);
    expect(board.shown).toBe(2);
  });

  test('a legacy-shaped abandoned job with no endedAt settles by updated', () => {
    const legacy = tag(job({ id: '009-a', stage: 'abandoned', updated: before(3 * HOUR) }));
    expect(buildBoard([legacy], NOW).settled.map((b) => b.job.id)).toEqual(['009-a']);
    expect(mergedAt(legacy.job)).toBe(NOW - 3 * HOUR);
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

describe('settled counts and lists over a narrow board (050 AC2)', () => {
  const held = [
    tag(job({ id: '001-build', stage: 'build' })),
    tag(job({ id: '002-crossing', stage: 'merged', endedAt: before(24 * HOUR - 1000) })),
    tag(job({ id: '003-fresh', stage: 'merged', endedAt: before(HOUR) })),
  ];
  const fetched = [tag(job({ id: '010-old', stage: 'merged', endedAt: before(30 * HOUR) })), tag(job({ id: '011-gone', stage: 'abandoned', endedAt: before(2 * HOUR) }))];

  test('the count is the summary\'s plus the held jobs that settled on screen', () => {
    expect(settledCount(2, held, NOW)).toBe(2);
    expect(settledCount(2, held, NOW + 2000)).toBe(3);
    expect(settledCount(0, [], NOW)).toBe(0);
  });

  test('the list: held jobs that settled, then each fetched one not held, newest end first, each once', () => {
    expect(settledJobs(held, fetched, NOW).map((b) => b.job.id)).toEqual(['011-gone', '010-old']);
    expect(settledJobs(held, fetched, NOW + 2000).map((b) => b.job.id)).toEqual(['011-gone', '002-crossing', '010-old']);
    // fetched just after the service settled it, before the push that drops it from the board: listed once, from the board
    const raced = [...fetched, tag(job({ id: '002-crossing', stage: 'merged', endedAt: before(24 * HOUR - 1000), title: 'stale copy' }))];
    const once = settledJobs(held, raced, NOW + 2000).filter((b) => b.job.id === '002-crossing');
    expect(once.map((b) => b.job.title)).toEqual(['A job']);
    // a held job the UI doesn't yet see as settled stays on the board only
    expect(settledJobs(held, raced, NOW).map((b) => b.job.id)).toEqual(['011-gone', '010-old']);
  });
});
