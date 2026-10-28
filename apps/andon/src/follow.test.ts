import { expect, test } from 'bun:test';
import { boardPath, startFollow } from './follow';
import type { Http, HttpResponse } from './http';
import type { AppState } from './state';

const P1 = { id: 'aaaaaaaaaaaa', name: 'one', root: '/r/one' };
const P2 = { id: 'bbbbbbbbbbbb', name: 'two', root: '/r/two' };
const enc = new TextEncoder();
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** An `/events` body the test writes to, frame by frame. */
class Stream {
  private ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
  cancelled = false;
  readonly body = new ReadableStream<Uint8Array>({
    start: (c) => {
      this.ctl = c;
    },
    cancel: () => {
      this.cancelled = true;
    },
  });
  raw(text: string): void {
    this.ctl?.enqueue(enc.encode(text));
  }
  send(event: string, data: unknown): void {
    this.raw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  close(): void {
    if (!this.cancelled) this.ctl?.close();
  }
}

const json = (status: number, body: unknown): HttpResponse => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, body: null, text: async () => text };
};

/** A fake service: `/events` answers with the next queued stream (or fails); boards come from `boards`. */
function fakeService(boards: (pid: string) => HttpResponse) {
  const asked: string[] = [];
  const streams: Stream[] = [];
  const queue: Array<Stream | 'fail' | 'refused'> = [];
  const http: Http = async (path) => {
    asked.push(path);
    if (path === '/events') {
      const next = queue.shift() ?? new Stream();
      if (next === 'refused') throw new Error('connection refused');
      if (next === 'fail') return json(500, 'boom');
      streams.push(next);
      return { ok: true, status: 200, body: next.body, text: async () => '' };
    }
    const pid = /^\/projects\/([^/]+)\/board$/.exec(path)?.[1];
    if (pid === undefined) return json(404, 'not found');
    return boards(pid);
  };
  return { http, asked, streams, queue };
}

const ids = (s: AppState, pid: string) => s.boards[pid]?.jobs.map((j) => `${j.id}:${j.stage}`);

test('AC3: a projects event fetches each listed board once; board and error events then update that project', async () => {
  const service = fakeService((pid) =>
    pid === P2.id ? json(500, 'config.json: bad\nmore') : json(200, { jobs: [{ id: '001-a', stage: 'review', title: 'A', extra: 1 }], config: {} }),
  );
  const boards: string[] = [];
  let opens = 0;
  const f = startFollow({ http: service.http, onOpen: () => opens++, onBoard: (pid) => boards.push(pid) });
  await wait();
  const s = service.streams[0];
  if (s === undefined) throw new Error('no stream');
  expect(opens).toBe(1);
  s.send('projects', { projects: [P1, P2] });
  await wait();
  expect(service.asked).toEqual(['/events', boardPath(P1.id), boardPath(P2.id)]);
  expect(ids(f.state(), P1.id)).toEqual(['001-a:review']);
  expect(f.state().boards[P2.id]?.error).toBe('config.json: bad');
  expect(boards).toEqual([P1.id]);

  s.send('board', { project: P2.id, jobs: [{ id: '002-b', stage: 'needs-human', note: 'help' }], config: {} });
  await wait();
  expect(ids(f.state(), P2.id)).toEqual(['002-b:needs-human']);
  expect(f.state().boards[P2.id]?.error).toBeNull();
  expect(f.state().boards[P2.id]?.jobs[0]?.note).toBe('help');
  s.send('error', { project: P1.id, reason: 'config.json: worse' });
  await wait();
  expect(f.state().boards[P1.id]?.error).toBe('config.json: worse');
  expect(ids(f.state(), P1.id)).toEqual(['001-a:review']); // keeps its last jobs
  expect(boards).toEqual([P1.id, P2.id]);
  expect(service.asked).toHaveLength(3); // no more fetches: events carry the boards
  f.stop();
  await wait();
  expect(s.cancelled).toBe(true);
});

test('AC3: malformed JSON, an unknown event, or a board for an unlisted project leaves the state unchanged', async () => {
  const service = fakeService(() => json(200, { jobs: [] }));
  const states: AppState[] = [];
  const f = startFollow({ http: service.http, onState: (st) => states.push(st) });
  await wait();
  const s = service.streams[0];
  if (s === undefined) throw new Error('no stream');
  s.send('projects', { projects: [P1] });
  await wait();
  const before = f.state();
  const count = states.length;
  s.raw('event: board\ndata: {not json\n\n');
  s.raw('event: projects\ndata: {"projects": "nope"}\n\n');
  s.send('round.finished', { project: P1.id, jobs: [{ id: '009-z', stage: 'needs-human' }] });
  s.send('board', { project: 'cccccccccccc', jobs: [{ id: '009-z', stage: 'needs-human' }] });
  s.send('board', { jobs: [] });
  await wait();
  expect(f.state()).toBe(before);
  expect(states).toHaveLength(count);
  f.stop();
});

test('AC3: a board event that lands while its fetch is in flight wins over the older fetch', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const service = fakeService(() => json(200, { jobs: [{ id: '001-a', stage: 'spec' }] }));
  const slow: Http = async (path) => {
    if (path !== '/events') await gate;
    return service.http(path);
  };
  const f = startFollow({ http: slow });
  await wait();
  service.streams[0]?.send('projects', { projects: [P1] });
  await wait();
  service.streams[0]?.send('board', { project: P1.id, jobs: [{ id: '001-a', stage: 'build' }] });
  await wait();
  release();
  await wait();
  expect(ids(f.state(), P1.id)).toEqual(['001-a:build']);
  f.stop();
});

test('AC3: a failed or dropped stream is reopened after the fixed delay, and boards are only fetched on projects events', async () => {
  const service = fakeService(() => json(200, { jobs: [] }));
  service.queue.push('refused', 'fail');
  const downs: string[] = [];
  let opens = 0;
  const f = startFollow({ http: service.http, retryMs: 20, onOpen: () => opens++, onDown: (w) => downs.push(w) });
  await wait(2);
  expect(service.asked).toEqual(['/events']); // refused
  await wait(10);
  expect(service.asked).toEqual(['/events']); // not before the delay
  await wait(20);
  expect(service.asked).toEqual(['/events', '/events']); // a 500
  await wait(30);
  expect(service.asked).toEqual(['/events', '/events', '/events']); // open
  expect(opens).toBe(1);
  expect(downs).toEqual(['connection refused', 'GET /events: HTTP 500']);

  service.streams[0]?.send('projects', { projects: [P1, P2] });
  await wait();
  service.streams[0]?.close(); // the service restarted
  await wait(40);
  expect(opens).toBe(2);
  service.streams[1]?.send('projects', { projects: [P1] });
  await wait(100); // idle: nothing is fetched on a timer
  expect(service.asked).toEqual(['/events', '/events', '/events', boardPath(P1.id), boardPath(P2.id), '/events', boardPath(P1.id)]);
  expect(downs).toEqual(['connection refused', 'GET /events: HTTP 500', 'the event stream ended']);
  f.stop();
  service.streams[1]?.close();
  await wait(50);
  expect(service.asked).toHaveLength(7); // a stopped follower never reconnects
});
