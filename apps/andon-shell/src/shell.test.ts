import { expect, test } from 'bun:test';
import type { TraySpec } from './badge';
import type { Http } from './http';
import type { NoticeText } from './notify';
import { startShell } from './shell';

const P = { id: 'aaaaaaaaaaaa', name: 'factory', root: '/r/factory' };
const enc = new TextEncoder();
const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('the shell keeps the tray count current and notifies on escalate and merge, re-baselining on reconnect', async () => {
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
  const shell = startShell({ http, tray: (t) => trays.push(t), notify: (n) => notes.push(n) }, { retryMs: 5 });
  await wait();
  send('projects', { projects: [P] });
  await wait();
  expect(notes).toEqual([]); // the baseline
  expect(trays.map((t) => t.title)).toEqual(['']);

  send('board', { project: P.id, jobs: [{ id: '001-a', title: 'Alpha', stage: 'needs-human', note: 'round limit' }] });
  await wait();
  expect(notes).toEqual([{ title: 'Alpha needs a human', subtitle: 'factory · 001-a', body: 'round limit' }]);
  expect(trays.at(-1)).toMatchObject({ title: '1', tooltip: 'Andon: 1 needs a human' });

  send('board', { project: P.id, jobs: [{ id: '001-a', title: 'Alpha', stage: 'needs-human', note: 'round limit' }] });
  await wait();
  expect(notes).toHaveLength(1);
  expect(trays).toHaveLength(2); // an unchanged tray isn't set again

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
  shell.stop();
});
