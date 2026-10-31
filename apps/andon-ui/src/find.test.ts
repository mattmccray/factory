import { describe, expect, test } from 'bun:test';
import type { BoardJob } from './board';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKLOG_HITS_MAX, toBacklog } from './backlog';
import type { BacklogList } from './backlog';
import { backlogHits, epicMatches, find, matches, needsFilter, needsMe } from './find';
import { HOUR, NOW, backlogBody, before, epic, inEpic, job, stopped, tag, tagEpic } from './fixtures';
import { popoverOf } from './lanes';
import { HUB, LOCAL_FACTORY, STUDIO_FACTORY, machineEntry, machinesBody } from './fixtures';
import { placed } from './machines';
import { applyEvent, emptyState } from './state';

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

describe('a landed epic in search and Needs Me (082 AC3, AC4)', () => {
  const landed = epic({ slug: 'auth', title: 'Login rewrite', state: 'landed', sha: 'abc1234', endedAt: before(2 * HOUR) });
  const hot = epic({ slug: 'billing', state: 'waiting', waitingOn: 'you' });
  const jobs = [
    inEpic({ id: '010-session', title: 'Session store', stage: 'merged', endedAt: before(3 * HOUR) }, landed),
    inEpic({ id: '011-fix', title: 'Fix gate', stage: 'needs-human', kind: 'fix', ...stopped('escalated', 'build') }, landed),
    at({ id: '020-other', title: 'Other work', stage: 'build' }, P2),
  ];
  const epics = [tagEpic(landed), tagEpic({ ...hot, waitingOn: 'you', state: 'landed' }, P3)];

  test('Needs Me never keeps a landed epic or its jobs; its project is kept only for a job or a non-landed epic that needs Matt', () => {
    const r = needsFilter([P1, P2, P3], jobs, epics);
    expect([r.projects, r.jobs, r.epics]).toEqual([[], [], []]);
    const own = at({ id: '030-mine', stage: 'needs-human', ...stopped('escalated', 'review') });
    const kept = needsFilter([P1, P2, P3], [...jobs, own], [...epics, tagEpic(hot)]);
    expect([kept.projects.map((p) => p.id), kept.jobs.map((b) => b.key), kept.epics.map((e) => e.key)]).toEqual([['p1'], ['p1/030-mine'], ['p1/billing']]);
  });

  test("a hit on a landed epic's member job lights its row and its lane; its title or slug lights it as today; a miss dims it", () => {
    for (const q of ['010', 'session']) {
      const f = find([P1, P2, P3], jobs, q, NOW, epics);
      expect([f.dimSubs.has('p1/auth'), f.dimLanes.has('p1'), [...f.epics]]).toEqual([false, false, []]);
    }
    const title = find([P1, P2, P3], jobs, 'login', NOW, epics);
    expect([[...title.epics], title.dimSubs.has('p1/auth'), title.dimLanes.has('p1')]).toEqual([['p1/auth'], false, false]);
    expect([...find([P1, P2, P3], jobs, 'AUTH', NOW, epics).epics]).toEqual(['p1/auth']);
    const miss = find([P1, P2, P3], jobs, 'other', NOW, epics);
    expect([miss.dimSubs.has('p1/auth'), miss.dimLanes.has('p1')]).toEqual([true, true]);
  });
});

describe('067 AC6: search over the backlog', () => {
  const lists = (data: unknown): Record<string, BacklogList> => ({ p1: { status: 'loaded', ...toBacklog(data), reason: null, rev: 1 } });
  const cached = lists(backlogBody());

  test('a trimmed, case-insensitive title match on a queued or exploring item with a page is a Backlog result that opens it', () => {
    expect(backlogHits([P1], cached, '  FULL-text ')).toEqual([
      { key: 'brief:p1/notes-search', title: 'Full-text search', project: 'Minerva', kindLabel: 'Brief', group: 'Queued', page: { kind: 'brief', project: 'p1', slug: 'notes-search' } },
    ]);
    expect(backlogHits([P1], cached, 'sign').map((h) => [h.kindLabel, h.page])).toEqual([['Epic', { kind: 'plan', project: 'p1', slug: 'auth' }]]);
    expect(backlogHits([P1], cached, 'cloud').map((h) => h.group)).toEqual(['In exploration']);
    expect(backlogHits([P1], cached, 'readme')).toEqual([]); // a text line has no page
    expect(backlogHits([P1], cached, 'notes by body')).toEqual([]); // titles only
    for (const q of ['', '   ']) expect(backlogHits([P1], cached, q)).toEqual([]);
    expect(backlogHits([P2], cached, 'full')).toEqual([]); // only the projects given
    const many = { queued: Array.from({ length: 12 }, (_, i) => ({ kind: 'brief', slug: `b-${i}`, title: `Same ${i}`, done: null, status: 'ready', members: null, abandoned: [] })), exploring: [] };
    expect(backlogHits([P1], lists(many), 'same')).toHaveLength(BACKLOG_HITS_MAX);
  });

  test('find()\'s dimming is unchanged for the same inputs: backlog items never dim or light lanes', () => {
    const jobs = [at({ id: '041-notes-search', title: 'Full-text search across notes', stage: 'review' })];
    for (const q of ['full-text', 'sign-in', 'cloud', '']) {
      const a = find([P1, P2, P3], jobs, q, NOW);
      expect({ q, dim: [...a.dimLanes], keys: [...a.keys] }).toEqual({ q, dim: q === '' ? [] : q === 'full-text' ? ['p2', 'p3'] : ['p1', 'p2', 'p3'], keys: q === 'full-text' ? ['p1/041-notes-search'] : [] });
    }
    const app = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8');
    expect(app).toContain('const found = $derived(find(shownProjects, jobs, query, now, epics));');
    expect(app).toContain('const hits = $derived(backlogHits(inView, ui.backlogs, query));');
    const bar = readFileSync(join(import.meta.dir, 'Toolbar.svelte'), 'utf8');
    expect(bar).toContain('onclick={() => onopenpage(h.page)}');
  });
});

describe('machines in search results (brief andon-machines-ui)', () => {
  const lists = (): Record<string, BacklogList> => {
    const list: BacklogList = { status: 'loaded', ...toBacklog(backlogBody()), reason: null, rev: 1 };
    return { [LOCAL_FACTORY.id]: list, [STUDIO_FACTORY.id]: list };
  };
  test('AC4: a remote project\'s results name its machine, so two projects named factory are told apart', () => {
    const s = applyEvent(applyEvent(emptyState(), 'projects', { projects: [LOCAL_FACTORY, STUDIO_FACTORY] }), 'machines', machinesBody(machineEntry(HUB), machineEntry('studio')));
    const hits = backlogHits(placed(s, s.projects), lists(), 'sign');
    expect(hits.length).toBeGreaterThan(1);
    expect([...new Set(hits.map((h) => h.project))]).toEqual(['factory', 'factory · studio']);
  });
  test('AC1: with no machines data, or only the hub listed, results carry no machine', () => {
    const none = applyEvent(emptyState(), 'projects', { projects: [LOCAL_FACTORY, STUDIO_FACTORY] });
    const alone = applyEvent(none, 'machines', machinesBody(machineEntry(HUB)));
    for (const s of [none, alone]) expect([...new Set(backlogHits(placed(s, s.projects), lists(), 'sign').map((h) => h.project))]).toEqual(['factory']);
  });
});
