import { expect, test } from 'bun:test';
import { traySpec } from './badge';
import type { TraySpec } from './badge';
import type { DockLook } from './lantern';
import type { Http } from './http';
import type { NoticeText } from './notify';
import { startApp } from './app';

const P = { id: 'aaaaaaaaaaaa', name: 'factory', root: '/r/factory', machine: null };
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

// ---- machines (081): the local service as a hub, following studio ----

const L = { id: 'aaaaaaaaaaaa', name: 'factory', root: '/Users/me/code/factory', machine: 'rocinante' };
const S = { id: '1a2b3c4d5e6f@studio', name: 'factory', root: '/Users/studio/code/factory', machine: 'studio' };
const S2 = { id: '9f8e7d6c5b4a@studio', name: 'notes', root: '/Users/studio/code/notes', machine: 'studio' };
const LOCAL_BOARD = '/projects/aaaaaaaaaaaa/board';
const STUDIO_BOARD = '/projects/1a2b3c4d5e6f%40studio/board'; // `@` as `%40`, which the contract allows
const STUDIO2_BOARD = '/projects/9f8e7d6c5b4a%40studio/board';

type Answer = { status: number; body: unknown };

/** A fake hub: `/events` streams, and each board path answers what `boards` holds now (a 404 when it holds nothing). */
function fakeHub(boards: Map<string, Answer>): { http: Http; asked: string[]; send: (event: string, data: unknown) => void } {
  const controls: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const asked: string[] = [];
  const http: Http = async (path) => {
    asked.push(path);
    if (path === '/events') {
      const body = new ReadableStream<Uint8Array>({ start: (c) => void controls.push(c) });
      return { ok: true, status: 200, body, text: async () => '' };
    }
    const a = boards.get(path) ?? { status: 404, body: 'no such project' };
    const ok = a.status >= 200 && a.status < 300;
    return { ok, status: a.status, body: null, text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body)) };
  };
  const send = (event: string, data: unknown) => controls.at(-1)?.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  return { http, asked, send };
}

const ok200 = (body: unknown): Answer => ({ status: 200, body });
const STUDIO_DOWN: Answer = { status: 502, body: 'studio: the peer is unreachable' };
const nj = (id: string, title: string, stage: string, note = '', epic?: string) => (epic === undefined ? { id, title, stage, note } : { id, title, stage, note, epic });
const machinesEvent = (studio: string) => ({ machines: [{ name: 'rocinante', url: null, state: 'live', since: '2026-10-30T10:00:00Z', reason: null, release: null }, { name: 'studio', url: 'https://studio.tail.ts.net:8766/', state: studio, since: '2026-10-30T11:00:00Z', reason: studio === 'down' ? 'unreachable' : null, release: null }] });

test("081 AC2: the tray counts every machine's needs-human jobs and waiting epics, and still counts a down machine's", async () => {
  const boards = new Map<string, Answer>([
    [LOCAL_BOARD, ok200({ jobs: [nj('001-a', 'Alpha', 'needs-human', 'stuck')] })],
    [STUDIO_BOARD, ok200({ jobs: [nj('081-x', 'Ex', 'needs-human', 'round limit')], epics: [{ slug: 'auth', state: 'waiting', waitingOn: 'you', note: 'checkout is on dev', members: [] }] })],
  ]);
  const hub = fakeHub(boards);
  const trays: TraySpec[] = [];
  const notes: NoticeText[] = [];
  const app = startApp({ http: hub.http, tray: (t) => trays.push(t), dock: () => undefined, badge: () => undefined, notify: (n) => notes.push(n) }, { retryMs: 5 });
  await wait();
  hub.send('projects', { projects: [L, S] });
  await wait();
  expect(hub.asked).toEqual(['/events', LOCAL_BOARD, STUDIO_BOARD]);
  expect(trays.at(-1)).toEqual(traySpec(3));
  expect(trays.at(-1)).toMatchObject({ title: '3', tooltip: 'Andon: 3 need a human' });

  // studio goes down: the hub re-sends projects with studio still listed, and its board fetch is a 502
  boards.set(STUDIO_BOARD, STUDIO_DOWN);
  hub.send('machines', machinesEvent('down'));
  hub.send('projects', { projects: [L, S] });
  await wait();
  expect(hub.asked.slice(3)).toEqual([LOCAL_BOARD, STUDIO_BOARD]);
  expect(app.state().boards[S.id]?.error).toBe('studio: the peer is unreachable');
  expect(app.state().boards[S.id]?.jobs.map((j) => j.id)).toEqual(['081-x']);
  expect(trays.at(-1)).toEqual(traySpec(3)); // the shape and words of today's tray
  for (const t of trays) expect(t.menu).toEqual(traySpec(0).menu);
  expect(notes).toEqual([]);
  app.stop();
});

test('081 AC3: a remote job or epic notice names the machine; the same events on a local project read as today', async () => {
  const boards = new Map<string, Answer>([
    [LOCAL_BOARD, ok200({ jobs: [nj('001-a', 'Alpha', 'review'), nj('002-b', 'Beta', 'approved')], epics: [{ slug: 'auth', state: 'running', waitingOn: null, members: [{ slug: 'a' }] }] })],
    [STUDIO_BOARD, ok200({ jobs: [nj('081-x', 'Ex', 'review'), nj('082-y', 'Why', 'approved')], epics: [{ slug: 'auth', state: 'running', waitingOn: null, members: [{ slug: 'a' }] }] })],
  ]);
  const hub = fakeHub(boards);
  const notes: NoticeText[] = [];
  const app = startApp({ http: hub.http, tray: () => undefined, dock: () => undefined, badge: () => undefined, notify: (n) => notes.push(n) }, { retryMs: 5 });
  await wait();
  hub.send('projects', { projects: [L, S] });
  await wait();
  expect(notes).toEqual([]); // the baselines

  hub.send('board', { project: S.id, jobs: [nj('081-x', 'Ex', 'needs-human', 'round limit'), nj('082-y', 'Why', 'approved')], epics: [{ slug: 'auth', state: 'running', waitingOn: null, members: [{ slug: 'a' }] }] });
  await wait();
  expect(notes).toEqual([{ title: 'Ex needs a human', subtitle: 'factory · studio · 081-x', body: 'round limit' }]);

  hub.send('board', { project: S.id, jobs: [nj('081-x', 'Ex', 'needs-human', 'round limit'), nj('082-y', 'Why', 'merged', 'merged abc1234')], epics: [{ slug: 'auth', state: 'waiting', waitingOn: 'you', note: 'gate red', members: [{ slug: 'a' }] }] });
  await wait();
  hub.send('board', { project: S.id, jobs: [nj('081-x', 'Ex', 'needs-human', 'round limit'), nj('082-y', 'Why', 'merged', 'merged abc1234')], epics: [{ slug: 'auth', state: 'landed', waitingOn: null, members: [{ slug: 'a' }] }] });
  await wait();
  expect(notes.slice(1)).toEqual([
    { title: 'Why merged', subtitle: 'factory · studio · 082-y', body: 'merged abc1234' },
    { title: 'Epic waiting on you', subtitle: 'factory · studio · auth', body: 'gate red' },
    { title: 'Epic landed', subtitle: 'factory · studio · auth', body: 'auth: 1 member' },
  ]);

  notes.length = 0;
  hub.send('board', { project: L.id, jobs: [nj('001-a', 'Alpha', 'needs-human', 'round limit'), nj('002-b', 'Beta', 'merged', 'merged abc1234')], epics: [{ slug: 'auth', state: 'waiting', waitingOn: 'you', note: 'gate red', members: [{ slug: 'a' }] }] });
  await wait();
  hub.send('board', { project: L.id, jobs: [nj('001-a', 'Alpha', 'needs-human', 'round limit'), nj('002-b', 'Beta', 'merged', 'merged abc1234')], epics: [{ slug: 'auth', state: 'landed', waitingOn: null, members: [{ slug: 'a' }] }] });
  await wait();
  expect(notes).toEqual([
    { title: 'Alpha needs a human', subtitle: 'factory · 001-a', body: 'round limit' },
    { title: 'Beta merged', subtitle: 'factory · 002-b', body: 'merged abc1234' },
    { title: 'Epic waiting on you', subtitle: 'factory · auth', body: 'gate red' },
    { title: 'Epic landed', subtitle: 'factory · auth', body: 'auth: 1 member' },
  ]);
  app.stop();
});

test('081 AC4: a machine going down or coming back notifies nothing; a transition while it was down notifies once it is back; a new remote project is a silent baseline', async () => {
  const boards = new Map<string, Answer>([
    [LOCAL_BOARD, ok200({ jobs: [nj('001-a', 'Alpha', 'build')] })],
    [STUDIO_BOARD, ok200({ jobs: [nj('081-x', 'Ex', 'review'), nj('082-y', 'Why', 'build')] })],
  ]);
  const hub = fakeHub(boards);
  const notes: NoticeText[] = [];
  const opened: string[] = [];
  const app = startApp({ http: hub.http, tray: () => undefined, dock: () => undefined, badge: () => undefined, notify: (n) => notes.push(n), log: (l) => void opened.push(l) }, { retryMs: 5 });
  await wait();
  hub.send('projects', { projects: [L, S] });
  await wait();
  expect(notes).toEqual([]); // the baselines

  // studio goes down: a machines event, its board a 502, no board events (the hub may re-send projects)
  boards.set(STUDIO_BOARD, STUDIO_DOWN);
  hub.send('machines', machinesEvent('down'));
  await wait();
  hub.send('projects', { projects: [L, S] });
  await wait();
  expect(notes).toEqual([]);
  expect(app.state().projects.map((p) => p.id)).toEqual([L.id, S.id]);

  // meanwhile on studio, 081-x escalated; when it is back, the hub re-sends projects and fresh boards
  const back = { jobs: [nj('081-x', 'Ex', 'needs-human', 'round limit'), nj('082-y', 'Why', 'build')] };
  boards.set(STUDIO_BOARD, ok200(back));
  hub.send('machines', machinesEvent('connecting'));
  hub.send('machines', machinesEvent('live'));
  await wait();
  expect(notes).toEqual([]); // coming back is not news in itself
  hub.send('projects', { projects: [L, S] });
  await wait();
  hub.send('board', { project: S.id, ...back });
  await wait();
  expect(notes).toEqual([{ title: 'Ex needs a human', subtitle: 'factory · studio · 081-x', body: 'round limit' }]);

  // a studio project first listed now is a silent baseline, even with a job already in needs-human
  boards.set(STUDIO2_BOARD, ok200({ jobs: [nj('005-n', 'Notes', 'needs-human', 'stuck'), nj('006-m', 'More', 'merged', 'merged f00')] }));
  hub.send('projects', { projects: [L, S, S2] });
  await wait();
  expect(hub.asked.at(-1)).toBe(STUDIO2_BOARD);
  expect(notes).toHaveLength(1);
  // after its baseline it notifies as any project does
  hub.send('board', { project: S2.id, jobs: [nj('005-n', 'Notes', 'needs-human', 'stuck'), nj('006-m', 'More', 'merged', 'merged f00'), nj('007-o', 'Other', 'needs-human', 'why')] });
  await wait();
  expect(notes.at(-1)).toEqual({ title: 'Other needs a human', subtitle: 'notes · studio · 007-o', body: 'why' });
  expect(notes).toHaveLength(2);
  expect(opened).toEqual(['andon: following the service']); // one stream all along: no reconnect re-baselined anything
  app.stop();
});
