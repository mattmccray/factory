import { describe, expect, test } from 'bun:test';
import type { BoardJob } from './board';
import { find, matches, needsFilter, needsMe } from './find';
import { HOUR, NOW, before, job, stopped, tag } from './fixtures';

const P1 = { id: 'p1', name: 'Minerva' };
const P2 = { id: 'p2', name: 'ledgerline' };
const P3 = { id: 'p3', name: 'quiet' };
const at = (fields: Record<string, unknown>, project = P1): BoardJob => tag(job(fields), project);

describe('search (AC3)', () => {
  const jobs = [
    at({ id: '041-notes-search', title: 'Full-text search across notes', stage: 'review', round: 1, reviews: { code: 'pending' } }),
    at({ id: '040-tag-migration', title: 'Migrate tags to a join table', stage: 'build' }),
    at({ id: '008-csv-import', title: 'Import transactions from CSV', stage: 'spec' }, P2),
    at({ id: '006-currency', title: 'Currency format', stage: 'merged', endedAt: before(48 * HOUR) }, P2), // settled
    at({ id: '005-gone', title: 'Gone CSV', stage: 'abandoned', endedAt: before(HOUR) }, P2),
  ];
  const projects = [P1, P2, P3];
  const keysOf = (q: string): string[] => [...find(projects, jobs, q, NOW).keys].sort();
  const dimOf = (q: string): string[] => [...find(projects, jobs, q, NOW).dimLanes].sort();

  test('matches the id, the title, or the project name, case-insensitively', () => {
    expect(matches(jobs[0] ?? at({ id: 'x' }), 'NOTES')).toBe(true);
    expect(keysOf('041')).toEqual(['p1/041-notes-search']);
    expect(keysOf('join TABLE')).toEqual(['p1/040-tag-migration']);
    expect(keysOf('minerva')).toEqual(['p1/040-tag-migration', 'p1/041-notes-search']);
    expect(keysOf('  csv  ')).toEqual(['p2/008-csv-import']);
    expect(keysOf('zzz')).toEqual([]);
  });

  test('a lane is dimmed exactly when it has no matching job', () => {
    expect(dimOf('041')).toEqual(['p2', 'p3']);
    expect(dimOf('ledger')).toEqual(['p1', 'p3']);
    expect(dimOf('zzz')).toEqual(['p1', 'p2', 'p3']);
    expect(dimOf('quiet')).toEqual(['p1', 'p2', 'p3']); // an idle lane has no job to match
  });

  test('abandoned and settled jobs never light a lane, focused or not: search matches only the jobs on the lane (050 AC6)', () => {
    expect(dimOf('gone')).toEqual(['p1', 'p2', 'p3']);
    expect(keysOf('currency')).toEqual([]);
    expect(dimOf('currency')).toEqual(['p1', 'p2', 'p3']);
    // a focused project's search runs over its own lane's jobs only: the settled one never matches
    const focus = find([P2], jobs.filter((b) => b.project.id === 'p2'), 'currency', NOW);
    expect([...focus.keys]).toEqual([]);
    expect([...focus.dimLanes]).toEqual(['p2']);
    expect([...find([P2], jobs.filter((b) => b.project.id === 'p2'), 'csv', NOW).keys]).toEqual(['p2/008-csv-import']);
  });

  test('an empty or whitespace query dims nothing', () => {
    for (const q of ['', '   ', '\t']) {
      const f = find(projects, jobs, q, NOW);
      expect(f.active).toBe(false);
      expect(f.dimLanes.size).toBe(0);
    }
    expect(matches(jobs[0] ?? at({ id: 'x' }), ' ')).toBe(true);
  });
});

describe('Needs Me (AC4)', () => {
  const escalated = at({ id: '001-escalated', stage: 'needs-human', decision: 'ESCALATE', ...stopped('escalated', 'review') });
  const notMerged = at({ id: '002-not-merged', stage: 'needs-human', decision: 'APPROVE (human)', ...stopped(null, null) });
  const mergeFailed = at({ id: '003-merge-failed', stage: 'needs-human', decision: 'APPROVE', ...stopped('merge-failed', 'approve') }, P2);
  const reviewFailed = at({ id: '004-review-failed', stage: 'review', round: 1, reviews: { code: 'CHANGES', ui: 'PASS' } }, P2);
  const kept = [escalated, notMerged, mergeFailed, reviewFailed];

  const longApprove = at({ id: '010-approve', stage: 'approve', stageEnteredAt: before(30 * HOUR) }, P3);
  const dropped = [
    longApprove,
    at({ id: '011-reviewing', stage: 'review', round: 1, reviews: { code: 'pending', ui: 'CHANGES' } }),
    at({ id: '012-build', stage: 'build', round: 1, reviews: { code: 'CHANGES' } }),
    at({ id: '013-spec', stage: 'spec' }),
    at({ id: '014-claimed', stage: 'claimed' }),
    at({ id: '015-merged', stage: 'merged', endedAt: before(HOUR) }),
    at({ id: '016-settled', stage: 'merged', endedAt: before(48 * HOUR) }),
    at({ id: '017-abandoned', stage: 'abandoned', endedAt: before(HOUR) }),
  ];

  test('keeps needs-human (Escalated, Approved · not merged, merge-failed) and review-failed jobs', () => {
    for (const b of kept) expect({ id: b.job.id, needs: needsMe(b) }).toEqual({ id: b.job.id, needs: true });
  });

  test('drops approver waits, however long, and working, merged, settled, and abandoned jobs', () => {
    for (const b of dropped) expect({ id: b.job.id, needs: needsMe(b) }).toEqual({ id: b.job.id, needs: false });
  });

  test('hides the lanes left with none', () => {
    const r = needsFilter([P1, P2, P3], [...dropped, ...kept]);
    expect(r.projects.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(r.jobs.map((b) => b.job.id).sort()).toEqual(kept.map((b) => b.job.id).sort());
  });
});
