import { expect, test } from 'bun:test';
import type { Fetcher } from './api';
import { startLive } from './live';
import type { EventSourceLike, Status } from './live';
import type { UiState } from './state';

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
  expect(asked.sort()).toEqual([`/projects/${P1.id}/board?settled=summary`, `/projects/${P2.id}/board?settled=summary`]);
  expect(live.state().boards[P1.id]?.jobs.map((j) => j.id)).toEqual(['001-a']);
  expect(live.state().boards[P2.id]?.error).toBe('config.json: bad');

  source.send('board', { project: P2.id, jobs: [{ id: '002-b', stage: 'review' }], config: { reviewers: ['code'] } });
  expect(live.state().boards[P2.id]?.error).toBeNull();
  source.send('error', { project: P1.id, reason: 'config.json: worse' });
  expect(live.state().boards[P1.id]?.error).toBe('config.json: worse');
  expect(live.state().boards[P1.id]?.jobs.map((j) => j.id)).toEqual(['001-a']);
  expect(asked).toHaveLength(2);

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
