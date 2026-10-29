import { expect, test } from 'bun:test';
import { traySpec } from './badge';
import type { TraySpec } from './badge';
import type { DockLook } from './lantern';
import type { Http } from './http';
import type { NoticeText } from './notify';
import { startApp } from './app';

const P = { id: 'aaaaaaaaaaaa', name: 'factory', root: '/r/factory' };
const enc = new TextEncoder();
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('the Mac app keeps the tray count current and notifies on escalate and merge, re-baselining on reconnect', async () => {
  const controls: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  let board: unknown = { jobs: [{ id: '001-a', title: 'Alpha', stage: 'review', note: '' }] };
  const http: Http = async (path) => {
    if (path === '/events') {
      const body = new ReadableStream<Uint8Array>({ start: (c) => void controls.push(c) });
      return { ok: true, status: 200, body, text: async () => '' };
    }
    return { ok: true, status: 200, body: null, text: async () => JSON.stringify(board) };
  };
  const send = (event: string, data: unknown) => controls.at(-1)?.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  const trays: TraySpec[] = [];
  const notes: NoticeText[] = [];
  const app = startApp({ http, tray: (t) => trays.push(t), dock: () => undefined, badge: () => undefined, notify: (n) => notes.push(n) }, { retryMs: 5 });
  await wait();
  send('projects', { projects: [P] });
  await wait();
  expect(notes).toEqual([]); // the baseline
  expect(trays.map((t) => t.title)).toEqual(['', '']); // the empty state, then the fetched board's running job (the filled lantern)

  send('board', { project: P.id, jobs: [{ id: '001-a', title: 'Alpha', stage: 'needs-human', note: 'round limit' }] });
  await wait();
  expect(notes).toEqual([{ title: 'Alpha needs a human', subtitle: 'factory · 001-a', body: 'round limit' }]);
  expect(trays.at(-1)).toMatchObject({ title: '1', tooltip: 'Andon: 1 needs a human' });

  send('board', { project: P.id, jobs: [{ id: '001-a', title: 'Alpha', stage: 'needs-human', note: 'round limit' }] });
  await wait();
  expect(notes).toHaveLength(1);
  expect(trays).toHaveLength(3); // an unchanged tray isn't set again

  // reconnect: the fetched board is a new baseline, even though the job merged meanwhile
  board = { jobs: [{ id: '001-a', title: 'Alpha', stage: 'merged', note: 'merged abc' }] };
  controls.at(-1)?.close();
  await wait(20);
  send('projects', { projects: [P] });
  await wait();
  expect(notes).toHaveLength(1);
  expect(trays.at(-1)).toMatchObject({ title: '', tooltip: 'Andon: all clear' });

  send('board', { project: P.id, jobs: [{ id: '001-a', title: 'Alpha', stage: 'merged', note: 'merged abc' }, { id: '002-b', title: 'Beta', stage: 'merged', note: 'merged def' }] });
  await wait();
  expect(notes.at(-1)).toEqual({ title: 'Beta merged', subtitle: 'factory · 002-b', body: 'merged def' });
  expect(notes).toHaveLength(2);
  app.stop();
});

test('AC3: the Dock look, the tray, and the badge are each set only when their value changes', async () => {
  const controls: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const http: Http = async (path) => {
    if (path === '/events') {
      const body = new ReadableStream<Uint8Array>({ start: (c) => void controls.push(c) });
      return { ok: true, status: 200, body, text: async () => '' };
    }
    return { ok: true, status: 200, body: null, text: async () => JSON.stringify({ jobs: [] }) };
  };
  const send = (event: string, data: unknown) => controls.at(-1)?.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  const jobs = (...stages: string[]) => ({ project: P.id, jobs: stages.map((stage, i) => ({ id: `00${i}-x`, title: 'X', stage, note: '' })) });
  const looks: DockLook[] = [];
  const trays: Array<{ spec: TraySpec; running: boolean }> = [];
  const badges: string[] = [];
  const app = startApp(
    { http, tray: (spec, running) => trays.push({ spec, running }), dock: (l) => looks.push(l), badge: (t) => badges.push(t), notify: () => undefined },
    { retryMs: 5 },
  );
  const step = async (data: unknown) => {
    send('board', data);
    await wait();
  };
  await wait();
  send('projects', { projects: [P] });
  await wait();
  expect(looks).toEqual(['idle']);
  expect(trays.map((t) => t.running)).toEqual([false]);
  expect(badges).toEqual(['']);

  await step(jobs('merged')); // nothing changes
  await step(jobs('claimed')); // running: the look and the tray flag change, the count doesn't
  await step(jobs('build')); // still running: nothing changes
  await step(jobs('build', 'needs-human')); // escalated, running, count 1
  await step(jobs('review', 'needs-human')); // nothing changes
  await step(jobs('needs-human', 'needs-human')); // still escalated; not running; count 2
  await step(jobs('merged', 'merged')); // back to idle
  await step(jobs('merged', 'merged', 'mystery')); // an unknown stage changes nothing

  expect(looks).toEqual(['idle', 'running', 'escalated', 'idle']);
  expect(trays.map((t) => [t.spec.title, t.running])).toEqual([
    ['', false],
    ['', true],
    ['1', true],
    ['2', false],
    ['', false],
  ]);
  expect(badges).toEqual(['', '1', '2', '']);
  for (const t of trays) expect(t.spec).toEqual(traySpec(Number(t.spec.title)));
  app.stop();
});

test('056 AC8: the Mac app counts an epic waiting on you, notifies "Epic waiting on you" and "Epic landed", and stays quiet on member merges', async () => {
  const controls: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const auth = (state: string, waitingOn: string | null, note = '') => ({ slug: 'auth', state, waitingOn, note, members: [{ slug: 'a' }, { slug: 'b' }] });
  const http: Http = async (path) => {
    if (path === '/events') {
      const body = new ReadableStream<Uint8Array>({ start: (c) => void controls.push(c) });
      return { ok: true, status: 200, body, text: async () => '' };
    }
    // the first board already has an epic waiting on you: a baseline, so no notice
    return { ok: true, status: 200, body: null, text: async () => JSON.stringify({ jobs: [{ id: '001-a', title: 'Alpha', stage: 'build', note: '', epic: 'auth' }], epics: [auth('waiting', 'you', 'checkout is on dev')] }) };
  };
  const send = (event: string, data: unknown) => controls.at(-1)?.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  const trays: TraySpec[] = [];
  const notes: NoticeText[] = [];
  const app = startApp({ http, tray: (t) => trays.push(t), dock: () => undefined, badge: () => undefined, notify: (n) => notes.push(n) }, { retryMs: 5 });
  await wait();
  send('projects', { projects: [P] });
  await wait();
  expect(notes).toEqual([]);
  expect(trays.at(-1)).toMatchObject({ title: '1', tooltip: 'Andon: 1 needs a human' });

  send('board', { project: P.id, jobs: [{ id: '001-a', title: 'Alpha', stage: 'merged', note: 'merged abc', epic: 'auth' }], epics: [auth('running', null)] });
  await wait();
  expect(notes).toEqual([]); // merged into the epic branch: no notice
  expect(trays.at(-1)).toMatchObject({ title: '' });

  send('board', { project: P.id, jobs: [{ id: '001-a', title: 'Alpha', stage: 'merged', note: 'merged abc', epic: 'auth' }], epics: [auth('waiting', 'you', 'gate red on main')] });
  await wait();
  expect(notes).toEqual([{ title: 'Epic waiting on you', subtitle: 'factory · auth', body: 'gate red on main' }]);

  send('board', { project: P.id, jobs: [{ id: '001-a', title: 'Alpha', stage: 'merged', note: 'merged abc', epic: 'auth' }], epics: [auth('landed', null, 'landed f00d123')] });
  await wait();
  expect(notes.at(-1)).toEqual({ title: 'Epic landed', subtitle: 'factory · auth', body: 'auth: 2 members' });
  expect(notes).toHaveLength(2);
  app.stop();
});
