import { describe, expect, test } from 'bun:test';
import { find } from './find';
import { buildLanes } from './lanes';
import { ALL, boardJobs } from './projects';
import { sidebarModel, subtitle, title } from './sidebar';
import { applyBacklog, applyEvent, applyFetched, applyFetchedRelease, applySettled, emptyState, releaseRev, revOf, settledCurrent, startBacklog, startSettled, toSummary, wantsSettled } from './state';
import { projectRelease, releaseBody } from './fixtures';
import type { UiState } from './state';
import { applyFetchedMachines, machinesRev } from './state';
import { HUB, STUDIO_FACTORY, LOCAL_FACTORY, machineEntry, machinesBody } from './fixtures';

const P1 = { id: 'aaaaaaaaaaaa', name: 'one', root: '/r/one' };
const P2 = { id: 'bbbbbbbbbbbb', name: 'two', root: '/r/two' };
const config = (reviewers: string[], settleAfterHours = 24) => ({ schema: 'factory/v1', reviewers, maxRound: 2, dashboard: { settleAfterHours } });

function twoProjects(): UiState {
  let s = applyEvent(emptyState(), 'projects', { projects: [P1, P2] });
  s = applyEvent(s, 'board', { project: P1.id, jobs: [{ id: '001-a', stage: 'spec' }], config: config(['code']) });
  s = applyEvent(s, 'board', { project: P2.id, jobs: [{ id: '001-a', stage: 'build' }], config: config(['security'], 6) });
  return s;
}

describe('applying service events (AC3)', () => {
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

describe('a renamed project (AC5)', () => {
  test('a projects event with a new name and the same id renames it everywhere and keeps its board', () => {
    const before = twoProjects();
    const renamed = { ...P1, name: 'Minerva Admin' };
    const s = applyEvent(before, 'projects', { projects: [renamed, P2] });
    expect(s.projects).toEqual([renamed, P2]);
    expect(s.boards[P1.id]).toBe(before.boards[P1.id]);

    expect(sidebarModel(s, P1.id).projects.find((p) => p.id === P1.id)?.name).toBe('Minerva Admin');
    expect(title(s, P1.id)).toBe('Minerva Admin');
    expect(subtitle(s, P1.id, 0, 0).scope).toBe('Minerva Admin');

    const jobs = boardJobs(s, ALL);
    expect(jobs.filter((b) => b.project.id === P1.id).map((b) => b.project.name)).toEqual(['Minerva Admin']);
    const lanes = buildLanes(s.projects, jobs, Date.now(), false);
    expect(lanes.map((l) => l.project)).toEqual([{ id: P1.id, name: 'Minerva Admin' }, { id: P2.id, name: 'two' }]);
    expect(lanes[0]?.cells.flatMap((c) => c.tokens).length).toBe(1);

    expect([...find(s.projects, jobs, 'minerva admin', Date.now()).keys]).toEqual([`${P1.id}/001-a`]);
    expect([...find(s.projects, jobs, 'one', Date.now()).keys]).toEqual([]);
  });
});

describe('the settled summary and the settled cache (050 AC1)', () => {
  const narrowBoard = (settled: unknown) => ({ project: P1.id, jobs: [{ id: '001-a', stage: 'spec' }], config: config(['code']), settled });

  test('a board stores its jobs, config, and settled summary; a malformed or missing summary stores none', () => {
    const s = applyEvent(twoProjects(), 'board', narrowBoard({ count: 3, lastMergedAt: '2026-10-20T00:00:00.000Z' }));
    expect(s.boards[P1.id]?.settled).toEqual({ count: 3, lastMergedAt: '2026-10-20T00:00:00.000Z' });
    expect(s.boards[P1.id]?.jobs.map((j) => j.id)).toEqual(['001-a']);
    expect(s.boards[P1.id]?.config).toEqual({ reviewers: ['code'], settleAfterHours: 24 });
    expect(applyEvent(s, 'board', narrowBoard({ count: 2, lastMergedAt: null })).boards[P1.id]?.settled).toEqual({ count: 2, lastMergedAt: null });
    for (const bad of [undefined, null, 7, [], {}, { count: -1, lastMergedAt: null }, { count: 1.5, lastMergedAt: null }, { count: '3', lastMergedAt: null }, { count: 3, lastMergedAt: 5 }, { count: 3 }]) {
      expect(applyEvent(s, 'board', narrowBoard(bad)).boards[P1.id]?.settled).toEqual({ count: 0, lastMergedAt: null });
      expect(toSummary(bad)).toEqual({ count: 0, lastMergedAt: null });
    }
    // a fetched board too, and an older service's board (no summary)
    const rev = revOf(s, P1.id);
    expect(applyFetched(s, P1.id, rev, { ok: true, data: { jobs: [], config: config([]), settled: { count: 5, lastMergedAt: null } } }).boards[P1.id]?.settled).toEqual({ count: 5, lastMergedAt: null });
    expect(applyFetched(s, P1.id, rev, { ok: true, data: { jobs: [], config: config([]) } }).boards[P1.id]?.settled).toEqual({ count: 0, lastMergedAt: null });
    // a config error keeps the last summary
    expect(applyEvent(s, 'error', { project: P1.id, reason: 'config.json: bad' }).boards[P1.id]?.settled).toEqual({ count: 3, lastMergedAt: '2026-10-20T00:00:00.000Z' });
  });

  test('a list is wanted once its board loads, again when the summary changes, and a failed one only on retry', () => {
    const listed = applyEvent(emptyState(), 'projects', { projects: [P1, P2] });
    expect(wantsSettled(listed, P1.id)).toBe(false); // no board yet
    expect(wantsSettled(listed, 'ffffffffffff')).toBe(false);
    let s = applyEvent(listed, 'board', narrowBoard({ count: 1, lastMergedAt: null }));
    expect(wantsSettled(s, P1.id)).toBe(true);
    const st = startSettled(s, P1.id);
    expect(wantsSettled(st.state, P1.id)).toBe(false); // already loading for this summary
    s = applySettled(st.state, P1.id, st.rev, { ok: true, data: { jobs: [{ id: '000-old', stage: 'merged' }, 'junk'] } });
    expect(s.settled[P1.id]).toMatchObject({ status: 'loaded', reason: null, summary: { count: 1, lastMergedAt: null } });
    expect(s.settled[P1.id]?.jobs?.map((j) => j.id)).toEqual(['000-old']);
    expect(settledCurrent(s, P1.id)).toBe(true);
    expect(wantsSettled(s, P1.id, true)).toBe(false);
    const moved = applyEvent(s, 'board', narrowBoard({ count: 1, lastMergedAt: '2026-10-21T00:00:00.000Z' }));
    expect(settledCurrent(moved, P1.id)).toBe(false);
    expect(wantsSettled(moved, P1.id)).toBe(true);
    // a refetch keeps the last list while it loads
    const again = startSettled(moved, P1.id);
    expect(again.state.settled[P1.id]).toMatchObject({ status: 'loading', summary: { count: 1, lastMergedAt: '2026-10-21T00:00:00.000Z' } });
    expect(again.state.settled[P1.id]?.jobs?.map((j) => j.id)).toEqual(['000-old']);
    const failed = applySettled(again.state, P1.id, again.rev, { ok: false, reason: 'config.json: bad' });
    expect(failed.settled[P1.id]).toMatchObject({ status: 'failed', reason: 'config.json: bad' });
    expect(wantsSettled(failed, P1.id)).toBe(false);
    expect(wantsSettled(failed, P1.id, true)).toBe(true);
  });

  test('an older fetch\'s answer is ignored, and a dropped project\'s list goes with it', () => {
    let s = applyEvent(applyEvent(emptyState(), 'projects', { projects: [P1, P2] }), 'board', narrowBoard({ count: 1, lastMergedAt: null }));
    const first = startSettled(s, P1.id);
    const second = startSettled(first.state, P1.id);
    expect(applySettled(second.state, P1.id, first.rev, { ok: true, data: { jobs: [{ id: '001-stale' }] } })).toBe(second.state);
    s = applySettled(second.state, P1.id, second.rev, { ok: true, data: { jobs: [] } });
    expect(Object.keys(s.settled)).toEqual([P1.id]);
    const dropped = applyEvent(s, 'projects', { projects: [P2] });
    expect(dropped.settled).toEqual({});
    expect(applyEvent(s, 'projects', { projects: [P1] }).settled[P1.id]).toBe(s.settled[P1.id]);
    expect(applySettled(dropped, P1.id, second.rev, { ok: true, data: { jobs: [] } })).toBe(dropped);
  });
});

describe('epics in the UI state (056 AC1)', () => {
  const E1 = { slug: 'auth', branch: 'factory/epic/auth', target: 'main', state: 'running', waitingOn: null, note: '', members: [{ slug: 'a', after: [], state: 'running', job: '001-a', stage: 'build', blockedOn: [] }], generated: [], counts: { running: 1 }, startedAt: '2026-10-22T00:00:00.000Z', endedAt: null, updated: '2026-10-22T01:00:00.000Z', extra: 1 };
  const E2 = { slug: 'billing', state: 'waiting', waitingOn: 'you', note: 'checkout is on dev', members: [], title: 'Billing rewrite' };
  const board = (epics: unknown, settled: unknown = { count: 0, lastMergedAt: null, epics: 0 }) => ({ project: P1.id, jobs: [{ id: '001-a', stage: 'build', epic: 'auth', kind: 'member' }], config: config(['code']), settled, epics });

  test('a board, a board event, and a fetched board hold their epics; malformed entries are skipped; a missing epics reads as []', () => {
    const s = applyEvent(twoProjects(), 'board', board([E1, 'junk', null, { state: 'running' }, { slug: '' }, E2, { ...E1, state: 'landed' }]));
    expect(s.boards[P1.id]?.epics.map((e) => e.slug)).toEqual(['auth', 'billing']); // a second entry with a slug already seen is skipped
    expect(s.boards[P1.id]?.epics[0]).toMatchObject({ slug: 'auth', title: null, branch: 'factory/epic/auth', target: 'main', state: 'running', waitingOn: null, members: [{ slug: 'a', job: '001-a' }] });
    expect(s.boards[P1.id]?.epics[1]).toMatchObject({ slug: 'billing', title: 'Billing rewrite', branch: 'factory/epic/billing', waitingOn: 'you', note: 'checkout is on dev' });
    expect(s.boards[P1.id]?.jobs[0]).toMatchObject({ id: '001-a', epic: 'auth', kind: 'member' });
    for (const missing of [undefined, null, 'x', {}, 3]) expect(applyEvent(s, 'board', board(missing)).boards[P1.id]?.epics).toEqual([]);
    expect(s.boards[P2.id]?.epics).toEqual([]); // a project whose board sent none
    const rev = revOf(s, P1.id);
    expect(applyFetched(s, P1.id, rev, { ok: true, data: board([E2]) }).boards[P1.id]?.epics.map((e) => e.slug)).toEqual(['billing']);
    expect(applyFetched(s, P1.id, rev, { ok: true, data: { jobs: [], config: config([]) } }).boards[P1.id]?.epics).toEqual([]);
    // an error keeps the last board's epics
    expect(applyEvent(s, 'error', { project: P1.id, reason: 'config.json: bad' }).boards[P1.id]?.epics.map((e) => e.slug)).toEqual(['auth', 'billing']);
  });

  test("a job's epic and kind: a standalone job has neither; a job in an epic with no readable kind is a member", () => {
    const s = applyEvent(twoProjects(), 'board', {
      project: P1.id,
      config: config([]),
      jobs: [{ id: '001-a', stage: 'spec' }, { id: '002-b', stage: 'spec', epic: 'auth', kind: 'sync' }, { id: '003-c', stage: 'spec', epic: 'auth', kind: 'odd' }, { id: '004-d', stage: 'spec', epic: '', kind: 'fix' }, { id: '005-e', stage: 'spec', epic: 7 }],
    });
    expect(s.boards[P1.id]?.jobs.map((j) => [j.id, j.epic, j.kind])).toEqual([
      ['001-a', null, null],
      ['002-b', 'auth', 'sync'],
      ['003-c', 'auth', 'member'],
      ['004-d', null, null],
      ['005-e', null, null],
    ]);
  });

  test("/settled's epics are cached with its jobs; a missing epics is []", () => {
    const s = applyEvent(twoProjects(), 'board', board([], { count: 1, lastMergedAt: null, epics: 1 }));
    const st = startSettled(s, P1.id);
    expect(st.state.settled[P1.id]?.epics).toBeNull();
    const loaded = applySettled(st.state, P1.id, st.rev, { ok: true, data: { jobs: [{ id: '000-old', stage: 'merged', epic: 'old' }], epics: [{ slug: 'old', state: 'landed', sha: 'abc1234' }, 'junk'] } });
    expect(loaded.settled[P1.id]?.epics?.map((e) => [e.slug, e.state, e.sha])).toEqual([['old', 'landed', 'abc1234']]);
    const again = startSettled(loaded, P1.id);
    expect(again.state.settled[P1.id]?.epics?.map((e) => e.slug)).toEqual(['old']); // kept while it reloads
    expect(applySettled(again.state, P1.id, again.rev, { ok: true, data: { jobs: [] } }).settled[P1.id]?.epics).toEqual([]);
  });

  test("the summary keeps its epics count, and a change in it alone triggers a settled refetch", () => {
    expect(toSummary({ count: 2, lastMergedAt: null, epics: 1 })).toEqual({ count: 2, lastMergedAt: null, epics: 1 });
    for (const bad of [-1, 1.5, '1', null]) expect(toSummary({ count: 2, lastMergedAt: null, epics: bad })).toEqual({ count: 2, lastMergedAt: null });
    let s = applyEvent(twoProjects(), 'board', board([], { count: 1, lastMergedAt: null, epics: 0 }));
    const st = startSettled(s, P1.id);
    s = applySettled(st.state, P1.id, st.rev, { ok: true, data: { jobs: [], epics: [] } });
    expect(wantsSettled(s, P1.id)).toBe(false);
    expect(settledCurrent(s, P1.id)).toBe(true);
    // a summary without `epics` (an older service) reads as 0: no refetch
    expect(wantsSettled(applyEvent(s, 'board', board([], { count: 1, lastMergedAt: null })), P1.id)).toBe(false);
    const landed = applyEvent(s, 'board', board([], { count: 1, lastMergedAt: null, epics: 1 }));
    expect(settledCurrent(landed, P1.id)).toBe(false);
    expect(wantsSettled(landed, P1.id)).toBe(true);
  });

  test('a project with no epics builds the same lanes, sidebar, counts, and search as before epics', () => {
    const plain = twoProjects();
    const withEmpty = applyEvent(applyEvent(plain, 'board', { project: P1.id, jobs: [{ id: '001-a', stage: 'spec' }], config: config(['code']), epics: [] }), 'board', { project: P2.id, jobs: [{ id: '001-a', stage: 'build' }], config: config(['security'], 6), epics: [] });
    const now = Date.parse('2026-10-22T12:00:00.000Z');
    const lanes = (s: UiState) => buildLanes(s.projects, boardJobs(s, ALL), now, false);
    expect(lanes(withEmpty)).toEqual(lanes(plain));
    expect(lanes(withEmpty).every((l) => l.subs.length === 0 && !l.header)).toBe(true);
    expect(sidebarModel(withEmpty, ALL)).toEqual(sidebarModel(plain, ALL));
    expect(subtitle(withEmpty, P1.id, 1, 0)).toEqual(subtitle(plain, P1.id, 1, 0));
    expect(find(withEmpty.projects, boardJobs(withEmpty, ALL), 'one', now)).toEqual(find(plain.projects, boardJobs(plain, ALL), 'one', now));
    expect(boardJobs(withEmpty, ALL).every((b) => b.epic === undefined)).toBe(true);
  });
});

describe('the release slot (059 AC6, AC7)', () => {
  test('empty until release data arrives', () => {
    expect(emptyState().release).toEqual({ info: null, rev: 0 });
  });

  test('a release event sets it and bumps its rev; a malformed one changes nothing', () => {
    const s = applyEvent(twoProjects(), 'release', releaseBody('0.2.0', '0.3.0'));
    expect(s.release.info?.running).toBe('0.2.0');
    expect(s.release.info?.onDisk).toBe('0.3.0');
    expect(s.release.info?.changelog.map((r) => r.version)).toEqual(['0.3.0', '0.2.0', '0.1.0']);
    expect(releaseRev(s)).toBe(1);
    for (const bad of [null, 'x', {}, { running: '0.2.0' }]) expect(applyEvent(s, 'release', bad)).toBe(s);
  });

  test('a projects event keeps the release, and carries each project\'s release', () => {
    let s = applyEvent(twoProjects(), 'release', releaseBody('0.2.0'));
    s = applyEvent(s, 'projects', { projects: [{ ...P1, release: projectRelease('0.1.0', 'behind') }, P2] });
    expect(s.release.info?.running).toBe('0.2.0');
    expect(s.projects).toEqual([{ ...P1, release: { installed: '0.1.0', state: 'behind' } }, P2]);
  });

  test('a fetched release applies unless a release event arrived since it was sent', () => {
    const s0 = twoProjects();
    const rev = releaseRev(s0);
    const fetched = applyFetchedRelease(s0, rev, { ok: true, data: releaseBody('0.1.0') });
    expect(fetched.release.info?.running).toBe('0.1.0');
    const newer = applyEvent(s0, 'release', releaseBody('0.2.0'));
    expect(applyFetchedRelease(newer, rev, { ok: true, data: releaseBody('0.1.0') })).toBe(newer);
    expect(applyFetchedRelease(newer, rev, { ok: false, reason: 'HTTP 404' })).toBe(newer);
  });

  test('a 404, another failure, or a malformed body is no release data', () => {
    const had = applyFetchedRelease(twoProjects(), 0, { ok: true, data: releaseBody('0.1.0') });
    expect(applyFetchedRelease(had, 0, { ok: false, reason: 'HTTP 404' }).release.info).toBeNull();
    expect(applyFetchedRelease(had, 0, { ok: true, data: { running: 7 } }).release.info).toBeNull();
    const none = twoProjects();
    expect(applyFetchedRelease(none, 0, { ok: false, reason: 'not found' })).toBe(none);
  });
});

describe('067: backlog counts and lists', () => {
  test('AC1: a narrow board (by event or fetched) carries its backlog counts; absent or malformed is none', () => {
    let s = applyEvent(emptyState(), 'projects', { projects: [P1, P2] });
    expect(s.boards[P1.id]?.backlog).toEqual({ queued: 0, exploring: 0 });
    s = applyEvent(s, 'board', { project: P1.id, jobs: [], config: config([]), backlog: { queued: 3, exploring: 1 } });
    expect(s.boards[P1.id]?.backlog).toEqual({ queued: 3, exploring: 1 });
    s = applyFetched(s, P2.id, revOf(s, P2.id), { ok: true, data: { jobs: [], config: config([]), backlog: { queued: 2, exploring: 0 } } });
    expect(s.boards[P2.id]?.backlog).toEqual({ queued: 2, exploring: 0 });
    s = applyEvent(s, 'board', { project: P1.id, jobs: [], config: config([]) });
    expect(s.boards[P1.id]?.backlog).toEqual({ queued: 0, exploring: 0 });
    s = applyEvent(s, 'board', { project: P1.id, jobs: [], config: config([]), backlog: { queued: 'three' } });
    expect(s.boards[P1.id]?.backlog).toEqual({ queued: 0, exploring: 0 });
    // an error keeps the last counts, as it keeps the last board
    s = applyEvent(s, 'error', { project: P2.id, reason: 'config.json: bad' });
    expect(s.boards[P2.id]?.backlog).toEqual({ queued: 2, exploring: 0 });
    // a `backlog` event carries no list: it changes no state by itself
    expect(applyEvent(s, 'backlog', { project: P1.id })).toBe(s);
  });

  test('AC3: each fetch replaces the list; an older response never overwrites a newer one; a failure keeps the last list and says why', () => {
    let s = applyEvent(emptyState(), 'projects', { projects: [P1, P2] });
    expect(emptyState().backlogs).toEqual({});
    const first = startBacklog(s, P1.id);
    s = first.state;
    expect(s.backlogs[P1.id]).toEqual({ status: 'loading', queued: null, exploring: null, reason: null, rev: 1 });
    const second = startBacklog(s, P1.id);
    s = second.state;
    const newer = { queued: [{ kind: 'text', slug: null, title: 'newer', done: null, status: null, members: null, abandoned: [] }], exploring: [] };
    const older = { queued: [{ kind: 'text', slug: null, title: 'older', done: null, status: null, members: null, abandoned: [] }], exploring: [] };
    s = applyBacklog(s, P1.id, second.rev, { ok: true, data: newer });
    s = applyBacklog(s, P1.id, first.rev, { ok: true, data: older }); // the slower, older response
    expect(s.backlogs[P1.id]?.queued?.map((i) => i.title)).toEqual(['newer']);
    expect(s.backlogs[P1.id]?.status).toBe('loaded');
    const third = startBacklog(s, P1.id);
    s = applyBacklog(third.state, P1.id, third.rev, { ok: false, reason: 'HTTP 500' });
    expect(s.backlogs[P1.id]).toMatchObject({ status: 'failed', reason: 'HTTP 500' });
    expect(s.backlogs[P1.id]?.queued?.map((i) => i.title)).toEqual(['newer']);
    expect(s.backlogs[P2.id]).toBeUndefined(); // the other project is untouched
    // an unlisted project is never started; a project that leaves drops its list
    expect(startBacklog(s, 'nobody').state).toBe(s);
    expect(applyEvent(s, 'projects', { projects: [P2] }).backlogs).toEqual({});
    expect(applyEvent(s, 'projects', { projects: [P1] }).backlogs[P1.id]).toBe(s.backlogs[P1.id]);
  });
});

// ---- machines (brief andon-machines-ui, AC2) ----

describe('machines in the UI state (AC2)', () => {
  const studioDown = '2026-10-22T14:02:00.000Z';
  const ok = (data: unknown): { ok: true; data: unknown } => ({ ok: true, data });

  test('a projects entry keeps its machine; one without (a service from before the hub) has none', () => {
    const s = applyEvent(emptyState(), 'projects', { projects: [LOCAL_FACTORY, STUDIO_FACTORY, P1, { ...P2, machine: 7 }] });
    expect(s.projects.map((p) => p.machine)).toEqual([HUB, 'studio', undefined, undefined]);
    expect(s.projects[1]?.id).toBe('1a2b3c4d5e6f@studio');
  });

  test('a machines event sets the list, in order: name, url, state, since, reason, release; malformed entries are skipped, unknown fields ignored', () => {
    const s = applyEvent(
      emptyState(),
      'machines',
      machinesBody(
        machineEntry(HUB, 'live', '2026-10-22T09:00:00.000Z', { extra: true }),
        machineEntry('studio', 'down', studioDown, { reason: 'unreachable', release: null }),
        { name: 'bad-state', url: 'https://x', state: 'asleep', since: studioDown, reason: null, release: null },
        { name: 'no-url', state: 'live', since: studioDown },
        { name: '', url: 'https://x', state: 'live', since: studioDown },
        { url: 'https://x', state: 'live', since: studioDown },
        'junk',
        machineEntry('agentbox', 'error', studioDown, { reason: 7, release: 3 }),
      ),
    );
    expect(s.machines.list).toEqual([
      { name: HUB, url: 'https://rocinante.example.ts.net:8766', state: 'live', since: '2026-10-22T09:00:00.000Z', reason: null, release: '0.2.0' },
      { name: 'studio', url: 'https://studio.example.ts.net:8766', state: 'down', since: studioDown, reason: 'unreachable', release: null },
      { name: 'agentbox', url: 'https://agentbox.example.ts.net:8766', state: 'error', since: studioDown, reason: null, release: null },
    ]);
    expect(s.machines.rev).toBe(1);
  });

  test('a malformed machines event changes nothing', () => {
    const s = applyEvent(emptyState(), 'machines', machinesBody(machineEntry(HUB)));
    for (const bad of [null, {}, { machines: 'x' }, []]) expect(applyEvent(s, 'machines', bad)).toBe(s);
  });

  test('a GET /machines applies at its rev, and one that resolves after a newer machines event is dropped', () => {
    const s0 = emptyState();
    const rev = machinesRev(s0);
    const fetched = applyFetchedMachines(s0, rev, ok(machinesBody(machineEntry(HUB), machineEntry('studio'))));
    expect(fetched.machines.list.map((m) => m.name)).toEqual([HUB, 'studio']);
    const evented = applyEvent(s0, 'machines', machinesBody(machineEntry(HUB), machineEntry('studio', 'down', studioDown)));
    const late = applyFetchedMachines(evented, rev, ok(machinesBody(machineEntry(HUB), machineEntry('studio'))));
    expect(late).toBe(evented);
    expect(late.machines.list[1]?.state).toBe('down');
  });

  test('a 404 (a service from before the hub) or a malformed body leaves the list empty', () => {
    const s0 = emptyState();
    expect(applyFetchedMachines(s0, 0, { ok: false, reason: 'not found' }).machines.list).toEqual([]);
    expect(applyFetchedMachines(s0, 0, ok({ nope: true })).machines.list).toEqual([]);
  });

  test('the last-seen down time is kept through the connecting that follows, and cleared once live', () => {
    let s = applyEvent(emptyState(), 'machines', machinesBody(machineEntry(HUB), machineEntry('studio', 'down', studioDown)));
    expect(s.machines.lastDown).toEqual({ studio: studioDown });
    s = applyEvent(s, 'machines', machinesBody(machineEntry(HUB), machineEntry('studio', 'connecting', '2026-10-22T14:30:00.000Z')));
    expect(s.machines.lastDown).toEqual({ studio: studioDown });
    s = applyEvent(s, 'machines', machinesBody(machineEntry(HUB), machineEntry('studio', 'live', '2026-10-22T14:31:00.000Z')));
    expect(s.machines.lastDown).toEqual({});
    s = applyEvent(s, 'machines', machinesBody(machineEntry(HUB), machineEntry('studio', 'down', studioDown)));
    s = applyEvent(s, 'machines', machinesBody(machineEntry(HUB))); // studio unlisted: forgotten
    expect(s.machines.lastDown).toEqual({});
  });
});
