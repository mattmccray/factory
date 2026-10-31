import { describe, expect, test } from 'bun:test';
import type { Fetcher } from './api';
import { projectRelease, releaseBody } from './fixtures';
import { footer, sidebarModel } from './sidebar';
import { ALL } from './projects';
import { whatsNew } from './release';
import { startLive } from './live';
import type { EventSourceLike, Status } from './live';
import type { UiState } from './state';
import { HUB, LOCAL_FACTORY, STUDIO_FACTORY, machineEntry, machinesBody } from './fixtures';

class FakeSource implements EventSourceLike {
  readyState = 0;
  listeners = new Map<string, Array<(e: unknown) => void>>();
  closed = false;
  addEventListener(type: string, listener: (e: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, e: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(e);
  }
  send(type: string, data: unknown): void {
    this.emit(type, { data: JSON.stringify(data) });
  }
}

const P1 = { id: 'aaaaaaaaaaaa', name: 'one', root: '/r/one' };
const P2 = { id: 'bbbbbbbbbbbb', name: 'two', root: '/r/two' };
const tick = () => new Promise((r) => setTimeout(r, 0));

test('a projects event fetches each board; board and error events then keep projects current, with no polling', async () => {
  const source = new FakeSource();
  const opened: string[] = [];
  const asked: string[] = [];
  const fetcher: Fetcher = async (path) => {
    asked.push(path);
    if (path.includes(P2.id)) return { ok: false, status: 500, text: async () => 'config.json: bad' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ jobs: [{ id: '001-a', stage: 'spec' }], config: { reviewers: [] } }) };
  };
  const states: UiState[] = [];
  const statuses: Status[] = [];
  const live = startLive({
    connect: (path) => {
      opened.push(path);
      return source;
    },
    fetcher,
    onState: (s) => states.push(s),
    onStatus: (s) => statuses.push(s),
  });
  expect(opened).toEqual(['/events?settled=summary']);
  expect(statuses).toEqual(['connecting']);
  source.emit('open', {});
  source.send('projects', { projects: [P1, P2] });
  await tick();
  expect(asked.sort()).toEqual([`/projects/${P1.id}/board?settled=summary`, `/projects/${P2.id}/board?settled=summary`, '/release']); // and the release, once (059)
  expect(live.state().boards[P1.id]?.jobs.map((j) => j.id)).toEqual(['001-a']);
  expect(live.state().boards[P2.id]?.error).toBe('config.json: bad');

  source.send('board', { project: P2.id, jobs: [{ id: '002-b', stage: 'review' }], config: { reviewers: ['code'] } });
  expect(live.state().boards[P2.id]?.error).toBeNull();
  source.send('error', { project: P1.id, reason: 'config.json: worse' });
  expect(live.state().boards[P1.id]?.error).toBe('config.json: worse');
  expect(live.state().boards[P1.id]?.jobs.map((j) => j.id)).toEqual(['001-a']);
  expect(asked).toHaveLength(3);

  source.emit('error', { type: 'error' }); // the connection dropped (no data)
  expect(statuses).toEqual(['connecting', 'live', 'down']);
  expect(states.length).toBeGreaterThan(0);
  live.stop();
  expect(source.closed).toBe(true);
});

test('a stream the browser gave up on is reopened; one it is retrying is left to the browser', async () => {
  const opened: FakeSource[] = [];
  const statuses: Status[] = [];
  const live = startLive({
    connect: () => {
      const s = new FakeSource();
      opened.push(s);
      return s;
    },
    fetcher: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    onState: () => undefined,
    onStatus: (s) => statuses.push(s),
    retryMs: 5,
  });
  const first = opened[0];
  if (first === undefined) throw new Error('not opened');
  first.emit('error', {}); // CONNECTING: the browser retries on its own
  await new Promise((r) => setTimeout(r, 20));
  expect(opened).toHaveLength(1);
  first.readyState = 2;
  first.emit('error', {});
  await new Promise((r) => setTimeout(r, 20));
  expect(opened).toHaveLength(2);
  opened[1]?.emit('open', {});
  first.emit('open', {}); // a stale source no longer reports
  expect(statuses).toEqual(['connecting', 'down', 'down', 'live']);
  live.stop();
  expect(opened[1]?.closed).toBe(true);
});

// ---- settled lists on demand (050 AC1, AC3, AC7) ----

const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const summary = (count: number, lastMergedAt: string | null) => ({ count, lastMergedAt });

/** A fake service: narrow boards and settled lists per project, every request recorded, and settled fetches held until released. */
function service() {
  const settled = new Map<string, unknown[]>();
  const failing = new Set<string>();
  const asked: string[] = [];
  const held: Array<() => void> = [];
  let hold = false;
  const fetcher: Fetcher = async (path) => {
    asked.push(path);
    const m = /^\/projects\/([^/]+)\/(board|settled)/.exec(path);
    if (m?.[2] === 'board') return ok({ jobs: [{ id: '010-live', stage: 'build' }], config: { reviewers: [] }, settled: summary(1, '2026-10-20T00:00:00.000Z') });
    const pid = m?.[1] ?? '';
    const jobs = settled.get(pid) ?? []; // read when asked, answered when released
    if (hold) await new Promise<void>((r) => held.push(r));
    if (failing.has(pid)) return { ok: false, status: 500, text: async () => 'config.json: maxRound must be a positive integer\nmore' };
    return ok({ jobs });
  };
  return {
    fetcher,
    asked,
    settled,
    failing,
    holdFetches: (on: boolean) => (hold = on),
    release: () => held.splice(0).forEach((r) => r()),
    releaseNewestFirst: () => held.splice(0).reverse().forEach((r) => r()),
    settledAsks: () => asked.filter((p) => p.endsWith('/settled')),
  };
}

async function started() {
  const source = new FakeSource();
  const svc = service();
  svc.settled.set(P1.id, [{ id: '001-old', stage: 'merged', endedAt: '2026-10-20T00:00:00.000Z' }]);
  svc.settled.set(P2.id, [{ id: '002-gone', stage: 'abandoned', endedAt: '2026-10-21T00:00:00.000Z' }]);
  const live = startLive({ connect: () => source, fetcher: svc.fetcher, onState: () => undefined, onStatus: () => undefined });
  source.send('projects', { projects: [P1, P2] });
  await tick();
  return { source, svc, live };
}

test('boards and board events store the settled summary; no settled list is fetched until a view needs one', async () => {
  const { source, svc, live } = await started();
  expect(live.state().boards[P1.id]?.settled).toEqual(summary(1, '2026-10-20T00:00:00.000Z'));
  source.send('board', { project: P2.id, jobs: [], config: { reviewers: [] }, settled: { count: 'x' } });
  expect(live.state().boards[P2.id]?.settled).toEqual(summary(0, null));
  source.send('board', { project: P2.id, jobs: [], config: { reviewers: [] } });
  expect(live.state().boards[P2.id]?.settled).toEqual(summary(0, null));
  await tick();
  expect(svc.settledAsks()).toEqual([]);
  live.stop();
});

test('a watched project\'s list is fetched once, cached, and shown as loading until it arrives', async () => {
  const { svc, live } = await started();
  svc.holdFetches(true);
  live.watch([P1.id]);
  expect(svc.settledAsks()).toEqual([`/projects/${P1.id}/settled`]);
  expect(live.state().settled[P1.id]?.status).toBe('loading');
  expect(live.state().settled[P1.id]?.jobs).toBeNull();
  live.watch([P1.id]); // the view re-renders: nothing new is fetched
  svc.release();
  await tick();
  expect(live.state().settled[P1.id]?.status).toBe('loaded');
  expect(live.state().settled[P1.id]?.jobs?.map((j) => j.id)).toEqual(['001-old']);
  expect(svc.settledAsks()).toHaveLength(1);
  // the global sheet: every project; the cached one is not fetched again
  svc.holdFetches(false);
  live.watch([P1.id, P2.id]);
  await tick();
  expect(svc.settledAsks()).toEqual([`/projects/${P1.id}/settled`, `/projects/${P2.id}/settled`]);
  live.stop();
});

test('a failed fetch keeps its reason (the first line of the body) and is retried when a view asks again', async () => {
  const { svc, live } = await started();
  svc.failing.add(P2.id);
  live.watch([P2.id]);
  await tick();
  expect(live.state().settled[P2.id]).toMatchObject({ status: 'failed', reason: 'config.json: maxRound must be a positive integer', jobs: null });
  live.watch([P2.id]); // still open: no retry loop
  await tick();
  expect(svc.settledAsks()).toHaveLength(1);
  svc.failing.clear();
  live.watch([]);
  live.watch([P2.id]); // reopened
  await tick();
  expect(live.state().settled[P2.id]?.status).toBe('loaded');
  expect(svc.settledAsks()).toHaveLength(2);
  live.stop();
});

test('while watched, a changed summary (count or lastMergedAt) refetches; an unchanged one does not, and a closed view never fetches (AC7)', async () => {
  const { source, svc, live } = await started();
  live.watch([P1.id]);
  await tick();
  expect(svc.settledAsks()).toHaveLength(1);
  const push = (settled: unknown, jobs: unknown[] = []) => source.send('board', { project: P1.id, jobs, config: { reviewers: [] }, settled });

  push(summary(1, '2026-10-20T00:00:00.000Z'), [{ id: '011-new', stage: 'spec' }]); // a job moved; the summary is the same
  await tick();
  expect(svc.settledAsks()).toHaveLength(1);

  svc.settled.set(P1.id, [{ id: '001-old', stage: 'merged' }, { id: '012-gone', stage: 'abandoned' }]);
  push(summary(2, '2026-10-20T00:00:00.000Z')); // one was abandoned: count changed
  await tick();
  expect(svc.settledAsks()).toHaveLength(2);
  expect(live.state().settled[P1.id]?.jobs?.map((j) => j.id)).toEqual(['001-old', '012-gone']);

  push(summary(2, '2026-10-21T00:00:00.000Z')); // lastMergedAt changed
  await tick();
  expect(svc.settledAsks()).toHaveLength(3);

  live.watch([]); // the view closed: the cache stays, the refetches stop
  push(summary(3, '2026-10-22T00:00:00.000Z'));
  await tick();
  expect(svc.settledAsks()).toHaveLength(3);
  expect(live.state().settled[P1.id]?.jobs?.map((j) => j.id)).toEqual(['001-old', '012-gone']);

  live.watch([P1.id]); // reopened after the summary changed: one refetch
  await tick();
  expect(svc.settledAsks()).toHaveLength(4);
  live.watch([]);
  live.watch([P1.id]); // reopened with the summary unchanged: the cache is used
  await tick();
  expect(svc.settledAsks()).toHaveLength(4);
  live.stop();
});

test('a slower, older settled fetch never overwrites a newer one', async () => {
  const { source, svc, live } = await started();
  svc.holdFetches(true);
  live.watch([P1.id]);
  svc.settled.set(P1.id, [{ id: '001-old', stage: 'merged' }, { id: '013-new', stage: 'abandoned' }]);
  source.send('board', { project: P1.id, jobs: [], config: { reviewers: [] }, settled: summary(2, '2026-10-20T00:00:00.000Z') });
  expect(svc.settledAsks()).toHaveLength(2);
  expect(live.state().settled[P1.id]?.summary).toEqual(summary(2, '2026-10-20T00:00:00.000Z'));
  svc.releaseNewestFirst(); // the newer answer lands first; the older one must not replace it
  await tick();
  await tick();
  expect(live.state().settled[P1.id]?.jobs?.map((j) => j.id)).toEqual(['001-old', '013-new']);
  live.stop();
});

test('a watched project waits for its board before its list is fetched', async () => {
  const source = new FakeSource();
  const svc = service();
  const live = startLive({ connect: () => source, fetcher: svc.fetcher, onState: () => undefined, onStatus: () => undefined });
  live.watch([P1.id]); // a cold #settled=<pid> link: nothing is listed yet
  expect(svc.settledAsks()).toEqual([]);
  source.send('projects', { projects: [P1] });
  expect(svc.settledAsks()).toEqual([]);
  await tick();
  expect(svc.settledAsks()).toEqual([`/projects/${P1.id}/settled`]);
  live.stop();
});

// ---- the factory release (059 AC6, AC7) ----

/** A fake service for releases: boards answer empty, and `/release` answers what `release` holds, held until let go when `hold` is on. */
function releaseService(answer: () => { ok: boolean; status: number; body: string }) {
  const asked: string[] = [];
  const held: Array<() => void> = [];
  let hold = false;
  const fetcher: Fetcher = async (path) => {
    asked.push(path);
    if (path !== '/release') return ok({ jobs: [], config: { reviewers: [] } });
    const a = answer(); // read when asked
    if (hold) await new Promise<void>((r) => held.push(r));
    return { ok: a.ok, status: a.status, text: async () => a.body };
  };
  return { fetcher, asked, holdFetches: (on: boolean) => (hold = on), letGo: () => held.splice(0).forEach((r) => r()) };
}

const json = (body: unknown) => ({ ok: true, status: 200, body: JSON.stringify(body) });

test('a projects event fetches GET /release once; the release event and changed projects update the glyph, the footer, and an open sheet', async () => {
  const source = new FakeSource();
  let body = json(releaseBody('0.2.0'));
  const svc = releaseService(() => body);
  const live = startLive({ connect: () => source, fetcher: svc.fetcher, onState: () => undefined, onStatus: () => undefined });
  const behind = { ...P1, release: projectRelease('0.1.0', 'behind') };
  source.send('projects', { projects: [behind, P2] });
  await tick();
  expect(svc.asked.filter((p) => p === '/release')).toHaveLength(1);
  expect(live.state().release.info?.running).toBe('0.2.0');
  const glyph = () => sidebarModel(live.state(), ALL).projects.find((p) => p.id === P1.id)?.release?.glyph ?? null;
  const scoped = () => whatsNew(live.state().release.info, { id: P1.id, project: live.state().projects.find((p) => p.id === P1.id) ?? null });
  expect(glyph()).toEqual({ label: 'factory 0.1.0 installed · 0.2.0 available' });
  expect(scoped().releases.map((r) => r.version)).toEqual(['0.2.0']);
  expect(footer('live', 2, live.state().release.info).release?.text).toBe('v0.2.0');

  // a git pull: the service still runs 0.2.0, its clone has 0.3.0
  source.send('release', releaseBody('0.2.0', '0.3.0'));
  expect(footer('live', 2, live.state().release.info).release?.kind).toBe('restart');
  // restarted: it runs 0.3.0, and the scoped sheet grows
  source.send('release', releaseBody('0.3.0'));
  expect(footer('live', 2, live.state().release.info).release?.text).toBe('v0.3.0');
  expect(scoped().releases.map((r) => r.version)).toEqual(['0.3.0', '0.2.0']);
  expect(whatsNew(live.state().release.info, null).releases).toHaveLength(3);

  // factory upgrade in the project: its release changes in a projects event
  body = json(releaseBody('0.3.0'));
  source.send('projects', { projects: [{ ...P1, release: projectRelease('0.3.0', 'current') }, P2] });
  expect(glyph()).toBeNull();
  expect(scoped().scope?.behind).toBe(false);
  await tick();
  expect(svc.asked.filter((p) => p === '/release')).toHaveLength(2);
  live.stop();
});

test('a GET /release that resolves after a newer release event does not overwrite it', async () => {
  const source = new FakeSource();
  const svc = releaseService(() => json(releaseBody('0.1.0')));
  const live = startLive({ connect: () => source, fetcher: svc.fetcher, onState: () => undefined, onStatus: () => undefined });
  svc.holdFetches(true);
  source.send('projects', { projects: [P1] });
  await tick();
  source.send('release', releaseBody('0.2.0')); // sent right after the first projects event
  svc.letGo(); // the older answer lands last
  await tick();
  await tick();
  expect(live.state().release.info?.running).toBe('0.2.0');
  live.stop();
});

test('a GET /release with no newer event applies; a later failure is no release data', async () => {
  const source = new FakeSource();
  let answer = json(releaseBody('0.2.0'));
  const svc = releaseService(() => answer);
  const live = startLive({ connect: () => source, fetcher: svc.fetcher, onState: () => undefined, onStatus: () => undefined });
  source.send('projects', { projects: [P1] });
  await tick();
  expect(live.state().release.info?.running).toBe('0.2.0');
  answer = { ok: false, status: 500, body: 'boom' };
  source.send('projects', { projects: [P1] });
  await tick();
  expect(live.state().release.info).toBeNull();
  live.stop();
});

test('an older service: no release on entries, no release event, and a 404 for /release; nothing shows and nothing throws (AC7)', async () => {
  for (const answer of [
    { ok: false, status: 404, body: 'not found' },
    { ok: true, status: 200, body: '<!doctype html>' }, // not JSON
    json({ running: 3 }), // malformed
    json(null),
  ]) {
    const source = new FakeSource();
    const svc = releaseService(() => answer);
    const live = startLive({ connect: () => source, fetcher: svc.fetcher, onState: () => undefined, onStatus: () => undefined });
    source.emit('open', {});
    source.send('projects', { projects: [P1, P2] });
    await tick();
    expect(live.state().release.info).toBeNull();
    expect(sidebarModel(live.state(), ALL).projects.map((p) => [p.release, p.title])).toEqual([
      [null, P1.root],
      [null, P2.root],
    ]);
    expect(footer('live', 2, live.state().release.info)).toEqual({ text: 'Connected · 2 projects', dot: 'green', release: null });
    expect(Object.values(live.state().boards).every((b) => b.loaded)).toBe(true);
    live.stop();
  }
});

describe('067 AC3: backlogs on demand, re-fetched on `backlog` events', () => {
  const item = (title: string) => ({ kind: 'brief', slug: 'x', title, done: null, status: 'ready', members: null, abandoned: [] });
  // A service whose backlog responses the test releases by hand, in any order.
  function service() {
    const asked: string[] = [];
    const pending: Array<{ path: string; resolve: (body: string, status?: number) => void }> = [];
    const fetcher: Fetcher = (path) => {
      asked.push(path);
      if (!path.endsWith('/backlog')) return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ jobs: [], config: { reviewers: [] } }) });
      return new Promise((done) => pending.push({ path, resolve: (body, status = 200) => done({ ok: status === 200, status, text: async () => body }) }));
    };
    return { asked, pending, fetcher, backlogAsks: () => asked.filter((p) => p.endsWith('/backlog')) };
  }

  test('nothing is fetched while no view watches; a watched project is fetched, re-fetched on its event, and replaced', async () => {
    const source = new FakeSource();
    const svc = service();
    const live = startLive({ connect: () => source, fetcher: svc.fetcher, onState: () => {}, onStatus: () => {} });
    source.send('projects', { projects: [P1, P2] });
    await tick();
    source.send('backlog', { project: P1.id }); // the sheet is closed: nothing
    await tick();
    expect(svc.backlogAsks()).toEqual([]);

    live.watchBacklog([P1.id]); // the sheet opens, filtered to P1
    expect(svc.backlogAsks()).toEqual([`/projects/${P1.id}/backlog`]);
    svc.pending.shift()?.resolve(JSON.stringify({ queued: [item('first')], exploring: [] }));
    await tick();
    expect(live.state().backlogs[P1.id]?.queued?.map((i) => i.title)).toEqual(['first']);

    source.send('backlog', { project: P2.id }); // another project's event: not watched
    source.send('backlog', { project: P1.id });
    await tick();
    expect(svc.backlogAsks()).toEqual([`/projects/${P1.id}/backlog`, `/projects/${P1.id}/backlog`]);
    svc.pending.shift()?.resolve(JSON.stringify({ queued: [item('second')], exploring: [item('drafting')] }));
    await tick();
    expect(live.state().backlogs[P1.id]?.queued?.map((i) => i.title)).toEqual(['second']);
    expect(live.state().backlogs[P1.id]?.exploring?.map((i) => i.title)).toEqual(['drafting']);

    live.watchBacklog([]); // the sheet closes
    source.send('backlog', { project: P1.id });
    source.send('backlog', 'not json'); // malformed: ignored
    source.emit('backlog', { data: '{' });
    await tick();
    expect(svc.backlogAsks()).toHaveLength(2);
    live.stop();
  });

  test('a slower, older response never overwrites a newer one; a failure shows for that project only', async () => {
    const source = new FakeSource();
    const svc = service();
    const live = startLive({ connect: () => source, fetcher: svc.fetcher, onState: () => {}, onStatus: () => {} });
    source.send('projects', { projects: [P1, P2] });
    await tick();
    live.watchBacklog([P1.id, P2.id]);
    source.send('backlog', { project: P1.id });
    await tick();
    const [p1old, p2, p1new] = [svc.pending[0], svc.pending[1], svc.pending[2]];
    expect([p1old?.path, p2?.path, p1new?.path]).toEqual([`/projects/${P1.id}/backlog`, `/projects/${P2.id}/backlog`, `/projects/${P1.id}/backlog`]);
    p1new?.resolve(JSON.stringify({ queued: [item('newer')], exploring: [] }));
    await tick();
    p1old?.resolve(JSON.stringify({ queued: [item('older')], exploring: [] }));
    p2?.resolve('config.json: bad', 500);
    await tick();
    expect(live.state().backlogs[P1.id]).toMatchObject({ status: 'loaded', reason: null });
    expect(live.state().backlogs[P1.id]?.queued?.map((i) => i.title)).toEqual(['newer']);
    expect(live.state().backlogs[P2.id]).toMatchObject({ status: 'failed', reason: 'config.json: bad' });
    live.stop();
  });

  test('a project watched before it is listed is fetched once the projects event lists it; a reconnect re-fetches watched ones', async () => {
    const source = new FakeSource();
    const svc = service();
    const live = startLive({ connect: () => source, fetcher: svc.fetcher, onState: () => {}, onStatus: () => {} });
    live.watchBacklog([P1.id]); // a #backlog=<pid> hash on load
    expect(svc.backlogAsks()).toEqual([]);
    source.send('projects', { projects: [P1, P2] });
    await tick();
    expect(svc.backlogAsks()).toEqual([`/projects/${P1.id}/backlog`]);
    source.send('projects', { projects: [P1, P2] }); // a reconnect may have missed events
    await tick();
    expect(svc.backlogAsks()).toEqual([`/projects/${P1.id}/backlog`, `/projects/${P1.id}/backlog`]);
    live.stop();
  });
});

// ---- machines (brief andon-machines-ui, AC2) ----

describe('machines, live (AC2)', () => {
  /** A fake hub: boards answer empty, and `/machines` answers what `answer` returns, held until let go when `hold` is on. */
  function hub(answer: () => { ok: boolean; status: number; body: string }) {
    const asked: string[] = [];
    const held: Array<() => void> = [];
    let hold = false;
    const fetcher: Fetcher = async (path) => {
      asked.push(path);
      if (path !== '/machines') return ok({ jobs: [], config: { reviewers: [] } });
      const a = answer();
      if (hold) await new Promise<void>((r) => held.push(r));
      return { ok: a.ok, status: a.status, text: async () => a.body };
    };
    return { fetcher, asked, machineAsks: () => asked.filter((p) => p === '/machines'), holdFetches: (on: boolean) => (hold = on), letGo: () => held.splice(0).forEach((r) => r()) };
  }
  const body = (b: unknown) => ({ ok: true, status: 200, body: JSON.stringify(b) });

  test('each projects event whose entries carry machine fetches GET /machines once; machines events keep it current', async () => {
    const source = new FakeSource();
    const svc = hub(() => body(machinesBody(machineEntry(HUB), machineEntry('studio'))));
    const live = startLive({ connect: () => source, fetcher: svc.fetcher, onState: () => undefined, onStatus: () => undefined });
    source.send('projects', { projects: [LOCAL_FACTORY, STUDIO_FACTORY] });
    await tick();
    expect(svc.machineAsks()).toHaveLength(1);
    expect(svc.asked).toContain('/projects/1a2b3c4d5e6f%40studio/board?settled=summary');
    expect(live.state().projects.map((p) => p.machine)).toEqual([HUB, 'studio']);
    expect(live.state().machines.list.map((m) => [m.name, m.state])).toEqual([
      [HUB, 'live'],
      ['studio', 'live'],
    ]);
    source.send('machines', machinesBody(machineEntry(HUB), machineEntry('studio', 'down', '2026-10-22T14:02:00.000Z', { reason: 'unreachable' })));
    expect(live.state().machines.list[1]).toMatchObject({ state: 'down', reason: 'unreachable' });
    source.send('projects', { projects: [LOCAL_FACTORY, STUDIO_FACTORY] });
    await tick();
    expect(svc.machineAsks()).toHaveLength(2);
    live.stop();
  });

  test('a GET /machines that resolves after a newer machines event is dropped', async () => {
    const source = new FakeSource();
    const svc = hub(() => body(machinesBody(machineEntry(HUB), machineEntry('studio'))));
    const live = startLive({ connect: () => source, fetcher: svc.fetcher, onState: () => undefined, onStatus: () => undefined });
    svc.holdFetches(true);
    source.send('projects', { projects: [LOCAL_FACTORY, STUDIO_FACTORY] });
    await tick();
    source.send('machines', machinesBody(machineEntry(HUB), machineEntry('studio', 'down', '2026-10-22T14:02:00.000Z')));
    svc.letGo(); // the older, live answer lands last
    await tick();
    expect(live.state().machines.list[1]?.state).toBe('down');
    live.stop();
  });

  test('a 404 on GET /machines leaves the list empty; a service from before the hub (no machine on any entry) is not asked', async () => {
    const source = new FakeSource();
    const svc = hub(() => ({ ok: false, status: 404, body: 'not found' }));
    const live = startLive({ connect: () => source, fetcher: svc.fetcher, onState: () => undefined, onStatus: () => undefined });
    source.send('projects', { projects: [LOCAL_FACTORY] });
    await tick();
    expect(svc.machineAsks()).toHaveLength(1);
    expect(live.state().machines.list).toEqual([]);
    source.send('projects', { projects: [P1, P2] });
    await tick();
    expect(svc.machineAsks()).toHaveLength(1);
    expect(live.state().machines.list).toEqual([]);
    live.stop();
  });
});
