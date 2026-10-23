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
  const asked: string[] = [];
  const fetcher: Fetcher = async (path) => {
    asked.push(path);
    if (path.includes(P2.id)) return { ok: false, status: 500, text: async () => 'config.json: bad' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ jobs: [{ id: '001-a', stage: 'spec' }], config: { reviewers: [] } }) };
  };
  const states: UiState[] = [];
  const statuses: Status[] = [];
  const live = startLive({ connect: () => source, fetcher, onState: (s) => states.push(s), onStatus: (s) => statuses.push(s) });
  expect(statuses).toEqual(['connecting']);
  source.emit('open', {});
  source.send('projects', { projects: [P1, P2] });
  await tick();
  expect(asked.sort()).toEqual([`/projects/${P1.id}/board`, `/projects/${P2.id}/board`]);
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
