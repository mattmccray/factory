import { describe, expect, test } from 'bun:test';
import type { BoardJob } from './board';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { epicMatches, find, matches, needsFilter, needsMe } from './find';
import { HOUR, NOW, before, epic, inEpic, job, stopped, tag, tagEpic } from './fixtures';
import { popoverOf } from './lanes';

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

describe('epics in search and Needs Me (056 AC5, AC7)', () => {
  const auth = epic({ slug: 'auth', title: 'Login rewrite' });
  const hot = epic({ slug: 'billing', state: 'waiting', waitingOn: 'you', note: 'checkout is on dev' });
  const calm = epic({ slug: 'docs' });
  const jobs = [
    at({ id: '001-solo', title: 'Solo work', stage: 'build' }),
    inEpic({ id: '010-session', title: 'Session store', stage: 'needs-human', ...stopped('escalated', 'review') }, auth),
    inEpic({ id: '011-tokens', title: 'Token refresh', stage: 'build' }, auth),
    inEpic({ id: '020-guide', title: 'Guide', stage: 'build' }, calm, P2),
  ];
  const epics = [tagEpic(auth), tagEpic(hot), tagEpic(calm, P2)];

  test("search matches an epic's name and slug, and a member job matches its epic's", () => {
    const f = find([P1, P2, P3], jobs, 'login', NOW, epics);
    expect([...f.epics]).toEqual(['p1/auth']);
    expect([...f.keys].sort()).toEqual(['p1/010-session', 'p1/011-tokens']); // members match their epic's name
    expect([...f.dimLanes].sort()).toEqual(['p2', 'p3']);
    expect([...f.dimSubs].sort()).toEqual(['p1/billing', 'p2/docs']);
    const slug = find([P1, P2, P3], jobs, 'BILL', NOW, epics);
    expect([[...slug.epics], [...slug.keys], [...slug.dimLanes].sort(), [...slug.dimSubs].sort()]).toEqual([['p1/billing'], [], ['p2', 'p3'], ['p1/auth', 'p2/docs']]);
    // a job hit lights its sub-lane even when the epic's name misses
    const job = find([P1, P2, P3], jobs, 'guide', NOW, epics);
    expect([[...job.epics], [...job.keys], [...job.dimSubs].sort()]).toEqual([[], ['p2/020-guide'], ['p1/auth', 'p1/billing']]);
    expect(epicMatches(auth, 'rewrite')).toBe(true);
    expect(epicMatches(auth, 'AUTH')).toBe(true);
    expect(matches(jobs[1] ?? at({ id: 'x' }), 'auth')).toBe(true);
  });

  test("a hit's sub-lane name opens the epic page; a member token shows its epic in the popover", () => {
    const lane = readFileSync(join(import.meta.dir, 'Lane.svelte'), 'utf8');
    expect(lane).toContain('class:hit={found.epics.has(sub.key)}');
    expect(lane).toContain('onclick={() => onopenepic(sub.key)}');
    expect(popoverOf(jobs[2] ?? at({ id: 'x' }), NOW).epic).toBe('Login rewrite');
    expect(popoverOf(inEpic({ id: '012-sync', stage: 'build', kind: 'sync' }, auth), NOW).epic).toBe('Login rewrite · sync job');
    expect(popoverOf(jobs[0] ?? at({ id: 'x' }), NOW).epic).toBeUndefined();
  });

  test('Needs Me keeps the sub-lanes whose epic waits on you or has a job that needs me, and their projects', () => {
    const r = needsFilter([P1, P2, P3], jobs, epics);
    expect(r.jobs.map((b) => b.key)).toEqual(['p1/010-session']);
    expect(r.epics.map((e) => e.key)).toEqual(['p1/auth', 'p1/billing']);
    expect(r.projects.map((p) => p.id)).toEqual(['p1']);
    // a project whose only need is a waiting epic is kept
    const only = needsFilter([P1, P2, P3], [], [tagEpic(hot, P3)]);
    expect([only.projects.map((p) => p.id), only.epics.map((e) => e.key)]).toEqual([['p3'], ['p3/billing']]);
  });
});
