import { describe, expect, test } from 'bun:test';
import { fetchDocs } from './api';
import type { Fetcher } from './api';
import { buildBoard, isSettled } from './board';
import { HOUR, MINUTE, NOW, before, epic, narrowBoard } from './fixtures';
import { settledRows, settledTitle } from './inspector';
import {
  ALL,
  SELECTION_KEY,
  boardEpics,
  boardJobs,
  boardPath,
  docsPath,
  epicDocsPath,
  epicJobs,
  isEpicHeld,
  isHeld,
  lookupEpic,
  loadSelection,
  lookupJob,
  needsHuman,
  projectErrors,
  resolveSelection,
  reviewersFor,
  saveSelection,
  settledEpicsFor,
  settledFor,
  settledPath,
  settledStatus,
  settledTotal,
  sheetProjects,
  withSettled,
} from './projects';
import { applyEvent, applySettled, emptyState, startSettled } from './state';
import type { UiState } from './state';
import { HUB, LOCAL_FACTORY, STUDIO_FACTORY, job, machineEntry, machinesBody, tag } from './fixtures';
import { fetchBacklog, fetchBoard, fetchBrief, fetchEpicDocs, fetchPlan, fetchSettled } from './api';
import { MACHINES_PATH, backlogPath, briefPath, planPath } from './projects';

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

// ---- settled jobs on demand (050) ----

describe('the narrow board and the settled cache', () => {
  const config = (hours: number) => ({ reviewers: ['code'], dashboard: { settleAfterHours: hours } });
  const full1 = [
    { id: '001-live', stage: 'build', updated: before(HOUR) },
    { id: '002-old', stage: 'merged', endedAt: before(30 * HOUR), startedAt: before(40 * HOUR), round: 2 },
    { id: '003-older', stage: 'merged', endedAt: before(60 * HOUR) },
    { id: '004-gone', stage: 'abandoned', endedAt: before(5 * HOUR), note: 'not needed' },
    { id: '005-fresh', stage: 'merged', endedAt: before(HOUR) },
  ];
  const full2 = [{ id: '001-done', stage: 'merged', endedAt: before(10 * HOUR) }, { id: '002-up', stage: 'spec' }];
  const n1 = narrowBoard(full1, 24);
  const n2 = narrowBoard(full2, 6);
  const listed = (): UiState => applyEvent(emptyState(), 'projects', { projects: [P1, P2] });
  const narrow = (): UiState => {
    let s = applyEvent(listed(), 'board', { project: P1.id, jobs: n1.jobs, config: config(24), settled: n1.settled });
    s = applyEvent(s, 'board', { project: P2.id, jobs: n2.jobs, config: config(6), settled: n2.settled });
    return s;
  };
  const loadList = (s: UiState, pid: string, jobs: unknown[]): UiState => {
    const st = startSettled(s, pid);
    return applySettled(st.state, pid, st.rev, { ok: true, data: { jobs } });
  };
  const loaded = (): UiState => loadList(loadList(narrow(), P1.id, n1.settledJobs), P2.id, n2.settledJobs);
  const fullState = (): UiState => {
    let s = applyEvent(listed(), 'board', { project: P1.id, jobs: full1, config: config(24) });
    s = applyEvent(s, 'board', { project: P2.id, jobs: full2, config: config(6) });
    return s;
  };

  test('paths: the narrow board, the settled list (AC1)', () => {
    expect(boardPath('a b')).toBe('/projects/a%20b/board?settled=summary');
    expect(settledPath('a b')).toBe('/projects/a%20b/settled');
  });

  test('the toolbar\'s Settled N is the sum of the selection\'s counts, as on the full board (AC2)', () => {
    const old = buildBoard(boardJobs(fullState(), ALL), NOW).settled.length;
    expect(settledTotal(narrow(), ALL, NOW)).toBe(old);
    expect(settledTotal(narrow(), ALL, NOW)).toBe(4);
    expect(settledTotal(narrow(), P2.id, NOW)).toBe(1);
    // a held job that crosses on screen counts at once, and is never counted twice
    const fresh = n1.jobs.find((j) => j.id === '005-fresh');
    expect(fresh).toBeDefined();
    expect(settledTotal(narrow(), P1.id, NOW + 24 * HOUR)).toBe(4); // 3 in the summary + 005 crossed
    // once the service's push moves it into the summary, it is still counted once
    const after = narrowBoard(full1, 24, NOW + 24 * HOUR);
    const pushed = applyEvent(narrow(), 'board', { project: P1.id, jobs: after.jobs, config: config(24), settled: after.settled });
    expect(settledTotal(pushed, P1.id, NOW + 24 * HOUR)).toBe(4);
  });

  test('the Settled sheet lists the same rows as the full board did, newest first, once its lists are loaded (AC3)', () => {
    const before = buildBoard(boardJobs(fullState(), ALL), NOW).settled;
    const now = settledFor(loaded(), ALL, NOW);
    expect(settledRows(now, null)).toEqual(settledRows(before, null));
    expect(settledRows(now, P1.id)).toEqual(settledRows(before, P1.id));
    expect(settledTitle(now)).toBe(settledTitle(before));
    expect(settledRows(now, null).map((r) => r.id)).toEqual(['004-gone', '001-done', '002-old', '003-older']);
  });

  test('a job both held and in a cached list is listed once; a held one not yet settled stays off the sheet', () => {
    // the list was fetched after 005 crossed on the service, before the push that drops it from the board
    const raced = loadList(narrow(), P1.id, [...n1.settledJobs, full1[4]]);
    expect(settledFor(raced, P1.id, NOW + 24 * HOUR).filter((b) => b.job.id === '005-fresh')).toHaveLength(1);
    expect(settledFor(raced, P1.id, NOW).map((b) => b.job.id)).not.toContain('005-fresh');
  });

  test('the sheet\'s status: loading until a first list arrives, a failure\'s reason, and current only when every list matches its summary', () => {
    const s = narrow();
    expect(sheetProjects(s, null)).toEqual([P1.id, P2.id]);
    expect(sheetProjects(s, P2.id)).toEqual([P2.id]);
    expect(sheetProjects(s, 'unknown')).toEqual([]);
    expect(settledStatus(s, [P1.id])).toEqual({ loading: true, failures: [], current: false });
    const st = startSettled(s, P1.id);
    expect(settledStatus(st.state, [P1.id])).toEqual({ loading: true, failures: [], current: false });
    const failed = applySettled(st.state, P1.id, st.rev, { ok: false, reason: 'config.json: bad' });
    expect(settledStatus(failed, [P1.id])).toEqual({ loading: false, failures: [{ id: P1.id, name: 'one', reason: 'config.json: bad' }], current: false });
    const ok = loaded();
    expect(settledStatus(ok, [P1.id, P2.id])).toEqual({ loading: false, failures: [], current: true });
    // the summary moved on: still listed (no loading state), but not current until refetched
    const moved = applyEvent(ok, 'board', { project: P1.id, jobs: [], config: config(24), settled: { count: 9, lastMergedAt: null } });
    expect(settledStatus(moved, [P1.id])).toEqual({ loading: false, failures: [], current: false });
    expect(settledStatus(s, [])).toEqual({ loading: false, failures: [], current: true });
  });

  test('the inspector finds a job on its board or in its cached list; it is missing only once both have loaded without it (AC4)', () => {
    const live = { project: P1.id, id: '001-live' };
    const old = { project: P1.id, id: '002-old' };
    const never = { project: P1.id, id: '999-never' };
    expect(lookupJob(listed(), old)).toEqual({ state: 'waiting' }); // no board yet
    expect(lookupJob(emptyState(), old)).toEqual({ state: 'waiting' }); // nothing listed yet
    const s = narrow();
    expect(isHeld(s, live)).toBe(true);
    expect(isHeld(s, old)).toBe(false);
    const found = lookupJob(s, live);
    expect(found.state === 'found' ? found.item.key : null).toBe(`${P1.id}/001-live`);
    expect(lookupJob(s, old)).toEqual({ state: 'waiting' }); // its settled list hasn't loaded
    expect(lookupJob(s, never)).toEqual({ state: 'waiting' });
    const st = startSettled(s, P1.id);
    expect(lookupJob(st.state, never)).toEqual({ state: 'waiting' });
    const l = loaded();
    const settled = lookupJob(l, old);
    expect(settled.state === 'found' ? [settled.item.key, settled.item.settleAfterHours, settled.item.job.timing] : null).toEqual([`${P1.id}/002-old`, 24, null]);
    expect(lookupJob(l, never)).toEqual({ state: 'missing' });
    expect(lookupJob(l, { project: 'unregistered', id: '001' })).toEqual({ state: 'missing' });
    // a failed list never declares the job missing
    const failed = applySettled(st.state, P1.id, st.rev, { ok: false, reason: 'x' });
    expect(lookupJob(failed, never)).toEqual({ state: 'waiting' });
    // a list fetched for an older summary isn't trusted to be complete
    const moved = applyEvent(l, 'board', { project: P1.id, jobs: n1.jobs, config: config(24), settled: { count: 4, lastMergedAt: n1.settled.lastMergedAt } });
    expect(lookupJob(moved, never)).toEqual({ state: 'waiting' });
  });
});

describe('epics across the projects (056 AC1, AC5, AC6, AC7)', () => {
  const auth = { slug: 'auth', target: 'main', state: 'running', waitingOn: null, members: [{ slug: 'a', after: [], state: 'merged', job: '010-a', stage: 'merged', blockedOn: [] }], startedAt: before(5 * HOUR), endedAt: null };
  const hot = { slug: 'billing', state: 'waiting', waitingOn: 'you', note: 'checkout is on dev', members: [] };
  function epicState(): UiState {
    let s = state();
    s = applyEvent(s, 'board', {
      project: P2.id,
      config: { reviewers: ['security', 'ui'] },
      jobs: [
        { id: '001-same-id', stage: 'needs-human', updated: before(2 * HOUR) },
        { id: '010-a', stage: 'merged', epic: 'auth', kind: 'member', endedAt: before(30 * HOUR) },
        { id: '011-b', stage: 'needs-human', epic: 'auth', kind: 'member' },
        { id: '012-c', stage: 'build', epic: 'nowhere', kind: 'member' },
      ],
      settled: { count: 1, lastMergedAt: null, epics: 1 },
      epics: [auth, hot],
    });
    return s;
  }
  const withSettledList = (s: UiState): UiState => {
    const st = startSettled(s, P2.id);
    return applySettled(st.state, P2.id, st.rev, {
      ok: true,
      data: { jobs: [{ id: '005-old', stage: 'merged', epic: 'old', kind: 'member', endedAt: before(60 * HOUR) }], epics: [{ slug: 'old', state: 'landed', sha: 'abc1234', endedAt: before(50 * HOUR), members: [{ slug: 'x' }] }] },
    });
  };

  test("needs-human counts add each epic waiting on you; an escalated member counts once", () => {
    expect(needsHuman(epicState())).toEqual({ byProject: { [P1.id]: 2, [P2.id]: 3 }, total: 5 });
  });

  test("a job is tagged with its epic when its project has it, on the board or settled; an unknown epic tags nothing", () => {
    const s = withSettledList(epicState());
    const by = (key: string) => [...boardJobs(s, ALL), ...withSettled(s, ALL)].find((b) => b.key === key);
    expect(by(`${P2.id}/010-a`)?.epic?.slug).toBe('auth');
    expect(by(`${P2.id}/012-c`)?.epic).toBeUndefined();
    expect(by(`${P2.id}/005-old`)?.epic?.slug).toBe('old');
    expect(by(`${P1.id}/001-same-id`)?.epic).toBeUndefined();
    expect(boardEpics(s, ALL).map((e) => e.key)).toEqual([`${P2.id}/auth`, `${P2.id}/billing`]);
    expect(boardEpics(s, P1.id)).toEqual([]);
  });

  test("a merged member of a running epic never settles, however old; a landed epic's members settle with it", () => {
    const s = withSettledList(epicState());
    const merged = boardJobs(s, P2.id).find((b) => b.job.id === '010-a');
    expect(merged !== undefined && isSettled(merged, NOW)).toBe(false);
    expect(merged !== undefined && isSettled({ ...merged, epic: { ...(merged.epic ?? epic({})), state: 'landed', endedAt: before(23 * HOUR) } }, NOW)).toBe(false);
    expect(merged !== undefined && isSettled({ ...merged, epic: { ...(merged.epic ?? epic({})), state: 'landed', endedAt: before(25 * HOUR) } }, NOW)).toBe(true);
    expect(merged !== undefined && isSettled({ ...merged, epic: { ...(merged.epic ?? epic({})), state: 'abandoned', endedAt: before(MINUTE) } }, NOW)).toBe(true);
    const unknown = boardJobs(s, P2.id).find((b) => b.job.id === '012-c');
    expect(unknown !== undefined && isSettled({ ...unknown, job: { ...unknown.job, stage: 'merged', endedAt: before(99 * HOUR) } }, NOW)).toBe(false);
  });

  test('the epic page finds its epic on the board or in the settled list, waiting until that list loads, and lists its jobs', () => {
    const s = epicState();
    expect(lookupEpic(s, { project: P2.id, slug: 'auth' })).toMatchObject({ state: 'found', item: { key: `${P2.id}/auth`, project: { id: P2.id, name: 'two' }, settleAfterHours: 24 } });
    expect(lookupEpic(s, { project: P2.id, slug: 'old' })).toEqual({ state: 'waiting' });
    const loaded = withSettledList(s);
    expect(lookupEpic(loaded, { project: P2.id, slug: 'old' })).toMatchObject({ state: 'found', item: { key: `${P2.id}/old` } });
    expect(lookupEpic(loaded, { project: P2.id, slug: 'gone' })).toEqual({ state: 'missing' });
    expect(lookupEpic(loaded, { project: 'ffffffffffff', slug: 'auth' })).toEqual({ state: 'missing' });
    expect([isEpicHeld(loaded, { project: P2.id, slug: 'auth' }), isEpicHeld(loaded, { project: P2.id, slug: 'old' })]).toEqual([true, false]);
    expect(epicJobs(loaded, { project: P2.id, slug: 'auth' }).map((b) => b.job.id)).toEqual(['010-a', '011-b']);
    expect(epicJobs(loaded, { project: P2.id, slug: 'old' }).map((b) => b.job.id)).toEqual(['005-old']);
    expect(epicDocsPath('a b', 'auth')).toBe('/projects/a%20b/epics/auth/docs');
  });

  test("the Settled sheet's epics: held ones that settled on screen and the fetched ones, newest end first", () => {
    const s = withSettledList(epicState());
    expect(settledEpicsFor(s, ALL, NOW).map((e) => e.key)).toEqual([`${P2.id}/old`]);
    const later = applyEvent(s, 'board', { project: P2.id, config: {}, jobs: [], epics: [{ ...auth, state: 'landed', endedAt: before(25 * HOUR) }] });
    expect(settledEpicsFor(later, ALL, NOW).map((e) => e.key)).toEqual([`${P2.id}/auth`, `${P2.id}/old`]);
    expect(settledEpicsFor(later, P1.id, NOW)).toEqual([]);
  });
});

describe('a remote project\'s reads (brief andon-machines-ui, AC7)', () => {
  const ID = '1a2b3c4d5e6f@studio';
  const ENC = '1a2b3c4d5e6f%40studio';

  test('every read goes to the usual relative route with the id encoded', () => {
    expect(boardPath(ID)).toBe(`/projects/${ENC}/board?settled=summary`);
    expect(settledPath(ID)).toBe(`/projects/${ENC}/settled`);
    expect(docsPath(tag(job({ id: '007-x' }), { id: ID, name: 'factory' }))).toBe(`/projects/${ENC}/jobs/007-x/docs`);
    expect(epicDocsPath(ID, 'auth')).toBe(`/projects/${ENC}/epics/auth/docs`);
    expect(backlogPath(ID)).toBe(`/projects/${ENC}/backlog`);
    expect(briefPath(ID, 'sign-in')).toBe(`/projects/${ENC}/briefs/sign-in`);
    expect(planPath(ID, 'auth')).toBe(`/projects/${ENC}/plans/auth`);
    expect(MACHINES_PATH).toBe('/machines');
  });

  test('the fetches ask exactly those paths, and a down peer\'s 502 reads as any read failure', async () => {
    const asked: string[] = [];
    const fetcher: Fetcher = async (path) => {
      asked.push(path);
      return { ok: false, status: 502, text: async () => 'studio: unreachable' };
    };
    expect(await fetchBoard(fetcher, ID)).toEqual({ ok: false, reason: 'studio: unreachable' });
    expect(await fetchSettled(fetcher, ID)).toEqual({ ok: false, reason: 'studio: unreachable' });
    expect(await fetchBacklog(fetcher, ID)).toEqual({ ok: false, reason: 'studio: unreachable' });
    expect(await fetchBrief(fetcher, ID, 'sign-in')).toEqual({ state: 'failed', reason: 'studio: unreachable' });
    expect(await fetchPlan(fetcher, ID, 'auth')).toEqual({ state: 'failed', reason: 'studio: unreachable' });
    await expect(fetchEpicDocs(fetcher, ID, 'auth')).rejects.toThrow('studio: unreachable');
    await expect(fetchDocs(fetcher, tag(job({ id: '007-x' }), { id: ID, name: 'factory' }))).rejects.toThrow('studio: unreachable');
    expect(asked).toEqual([
      `/projects/${ENC}/board?settled=summary`,
      `/projects/${ENC}/settled`,
      `/projects/${ENC}/backlog`,
      `/projects/${ENC}/briefs/sign-in`,
      `/projects/${ENC}/plans/auth`,
      `/projects/${ENC}/epics/auth/docs`,
      `/projects/${ENC}/jobs/007-x/docs`,
    ]);
  });

  test('board jobs and epics of a remote project carry its machine; a local one\'s, none', () => {
    let s = applyEvent(emptyState(), 'projects', { projects: [LOCAL_FACTORY, STUDIO_FACTORY] });
    s = applyEvent(s, 'board', { project: STUDIO_FACTORY.id, config: {}, jobs: [{ id: '007-x', stage: 'spec' }] });
    s = applyEvent(s, 'board', { project: LOCAL_FACTORY.id, config: {}, jobs: [{ id: '001-a', stage: 'spec' }] });
    expect(boardJobs(s, ALL).map((b) => b.project)).toEqual([{ id: LOCAL_FACTORY.id, name: 'factory' }, { id: STUDIO_FACTORY.id, name: 'factory' }]); // no machines data yet
    s = applyEvent(s, 'machines', machinesBody(machineEntry(HUB), machineEntry('studio')));
    expect(boardJobs(s, ALL).map((b) => b.project)).toEqual([{ id: LOCAL_FACTORY.id, name: 'factory' }, { id: STUDIO_FACTORY.id, name: 'factory', remote: 'studio' }]);
  });
});
