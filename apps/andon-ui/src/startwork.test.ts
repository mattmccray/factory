import { describe, expect, test } from 'bun:test';
// The Mac app's start module, imported by this test only: the page's sources never import Mac app
// code, and the Mac app's sources never import the UI, so the two command builders stay apart and
// this pins that they agree.
import { startWorkRequest } from '../../andon/src/startwork';
import { backlogSheet, toBacklog } from './backlog';
import type { BacklogList } from './backlog';
import { backlogBody } from './fixtures';
import { COPY_FAILED } from './handoff';
import type { HandoffOutcome } from './handoff';
import { shellMode } from './sidebar';
import {
  MAX_COMMAND,
  NEXT_COMMAND,
  START_WORK_METHOD,
  copyThenStart,
  exploreCommand,
  exploringStart,
  newExploration,
  newExplorationCommand,
  newExplorationStart,
  nextStart,
  pageStart,
  queuedStart,
  runCommand,
  startEpicCommand,
  startWorkCaller,
  LAST_EXPLORED_KEY,
  exploreOpen,
  loadLastExplored,
  pickerStart,
  saveLastExplored,
  startWorkPush,
} from './startwork';
import type { StartItem, StartWorkRequest } from './startwork';
import { HUB, LOCAL_FACTORY, STUDIO_FACTORY, machineEntry, machinesBody } from './fixtures';
import { remoteOfId } from './machines';
import { applyEvent, emptyState } from './state';

const PID = 'aaaaaaaaaaaa';
const PROJECTS = [{ id: PID, name: 'factory', root: '/Users/me/code/factory' }];
const loaded = (data: unknown): BacklogList => ({ status: 'loaded', ...toBacklog(data), reason: null, rev: 1 });

describe('068 AC2: the page builds the same commands as the Mac app', () => {
  test('the exact strings', () => {
    expect(runCommand('Full-text search')).toBe('/factory next Full-text search');
    expect(startEpicCommand('auth')).toBe('/factory epic auth');
    expect(NEXT_COMMAND).toBe('/factory next');
    expect(exploreCommand('tag-cloud')).toBe('/factory explore tag-cloud');
    expect(newExplorationCommand('  say "hi"\\now\r\nplease\n')).toBe('/factory explore "say \\"hi\\"\\\\now please"');
  });

  test("every row's, page's, and project's action agrees with the Mac app's command for the same request and backlog", () => {
    const body = backlogBody();
    const b = toBacklog(body);
    const items: StartItem[] = [
      ...b.queued.map((i) => queuedStart(PID, i)).filter((x): x is StartItem => x !== null),
      ...b.exploring.map((i) => exploringStart(PID, i)).filter((x): x is StartItem => x !== null),
      nextStart(PID),
    ];
    expect(items.map((i) => i.req.action)).toEqual(['run', 'epic', 'run', 'explore', 'next']);
    for (const i of items) expect({ req: i.req, mac: startWorkRequest(i.req, PROJECTS, body)?.command }).toEqual({ req: i.req, mac: i.command });
  });

  test('New exploration agrees for every idea in the table', () => {
    const ideas = ['plain', 'a "tag" cloud', 'C:\\path', 'line one\nline two\r\nthree\rfour', '  padded\t ', "it's `ticks` and $(sub)", 'café — ✓', '"', '\\', 'x'];
    for (const idea of ideas) {
      const req: StartWorkRequest = { project: PID, action: 'new-exploration', idea };
      expect({ idea, mac: startWorkRequest(req, PROJECTS, null)?.command }).toEqual({ idea, mac: newExplorationCommand(idea) });
    }
  });
});

describe('068 AC6: the actions each row, project, and page offers', () => {
  test('queued brief and text rows offer Run, a queued epic Start epic, an exploring row Continue exploring', () => {
    const m = backlogSheet([{ id: PID, name: 'factory' }], { [PID]: loaded(backlogBody()) }, null);
    const [queued, exploring] = m.projects[0]?.groups ?? [];
    expect(queued?.rows.map((r) => [r.kindLabel, r.start?.label, r.start?.req, r.start?.command])).toEqual([
      ['Brief', 'Run', { project: PID, action: 'run', slug: 'notes-search' }, '/factory next Full-text search'],
      ['Epic', 'Start epic', { project: PID, action: 'epic', slug: 'auth' }, '/factory epic auth'],
      ['Text', 'Run', { project: PID, action: 'run', title: 'Tidy the README' }, '/factory next Tidy the README'],
    ]);
    expect(exploring?.rows.map((r) => [r.start?.label, r.start?.req])).toEqual([['Continue exploring', { project: PID, action: 'explore', slug: 'tag-cloud' }]]);
    const plan = loaded({ queued: [], exploring: [{ kind: 'epic', slug: 'billing', title: 'Billing', done: null, status: 'draft', members: 0, abandoned: [] }] });
    expect(backlogSheet([{ id: PID, name: 'factory' }], { [PID]: plan }, null).projects[0]?.groups[0]?.rows[0]?.start?.req).toEqual({ project: PID, action: 'explore', slug: 'billing' });
  });

  test('each project offers Run next', () => {
    expect(nextStart(PID)).toEqual({ label: 'Run next', req: { project: PID, action: 'next' }, command: '/factory next' });
    expect(newExplorationStart(PID, ' a "tag" cloud ')).toEqual({ label: 'New exploration', req: { project: PID, action: 'new-exploration', idea: ' a "tag" cloud ' }, command: '/factory explore "a \\"tag\\" cloud"' });
  });

  test("a brief or plan page offers its item's action, or none when it is in neither group", () => {
    const list = loaded({ ...backlogBody(), exploring: [...backlogBody().exploring, { kind: 'epic', slug: 'billing', title: 'Billing', done: null, status: 'draft', members: 0, abandoned: [] }] });
    expect(pageStart({ kind: 'brief', project: PID, slug: 'notes-search' }, list)?.label).toBe('Run');
    expect(pageStart({ kind: 'brief', project: PID, slug: 'notes-search' }, list)?.command).toBe('/factory next Full-text search');
    expect(pageStart({ kind: 'plan', project: PID, slug: 'auth' }, list)?.label).toBe('Start epic');
    expect(pageStart({ kind: 'brief', project: PID, slug: 'tag-cloud' }, list)?.label).toBe('Continue exploring');
    expect(pageStart({ kind: 'plan', project: PID, slug: 'billing' }, list)?.req).toEqual({ project: PID, action: 'explore', slug: 'billing' });
    expect(pageStart({ kind: 'brief', project: PID, slug: 'auth' }, list)).toBeNull(); // a plan's slug, as a brief
    expect(pageStart({ kind: 'plan', project: PID, slug: 'notes-search' }, list)).toBeNull();
    expect(pageStart({ kind: 'brief', project: PID, slug: 'done-long-ago' }, list)).toBeNull();
    expect(pageStart({ kind: 'brief', project: PID, slug: 'notes-search' }, undefined)).toBeNull();
    expect(pageStart({ kind: 'brief', project: PID, slug: 'notes-search' }, { queued: null, exploring: null })).toBeNull();
  });

  test('the New exploration sheet blocks a blank idea or an over-long command, and says why', () => {
    expect(newExploration('a tag cloud')).toEqual({ text: '/factory explore "a tag cloud"', blocked: null });
    expect(newExploration('').blocked).toBe('An idea is required.');
    expect(newExploration(' \n\t ').blocked).toBe('An idea is required.');
    const fits = 'x'.repeat(MAX_COMMAND - '/factory explore ""'.length);
    expect(newExploration(fits).blocked).toBeNull();
    expect(newExploration(`${fits}x`).blocked).toBe('The command is over 8,000 characters.');
    expect(startWorkRequest({ project: PID, action: 'new-exploration', idea: `${fits}x` }, PROJECTS, null)).toBeNull();
  });
});

describe('068 AC5: the caller, and copy first, then start, then the toast', () => {
  const next: StartWorkRequest = { project: PID, action: 'next' };

  test('null in a plain browser, or when Tiny or its api.call is missing', () => {
    const host = { api: { call: async () => 'drafted' } };
    expect(startWorkCaller('browser', host)).toBeNull();
    expect(startWorkCaller(shellMode(''), host)).toBeNull();
    for (const h of [undefined, null, {}, { api: null }, { api: {} }, { api: { call: 'x' } }]) expect(startWorkCaller('mac', h)).toBeNull();
  });

  test('in the Mac app it calls exactly START_WORK_METHOD with the request, and narrows the answer', async () => {
    const calls: unknown[][] = [];
    let answer: unknown = 'sent';
    const api = {
      call(...args: unknown[]): Promise<unknown> {
        calls.push(args);
        return Promise.resolve(answer);
      },
    };
    const start = startWorkCaller('mac', { api });
    expect(start).not.toBeNull();
    expect(await start?.(next)).toBe('sent');
    expect(calls).toEqual([[START_WORK_METHOD, next]]);
    answer = 'junk';
    expect(await start?.(next)).toBeNull();
    const failing = startWorkCaller('mac', { api: { call: () => Promise.reject(new Error('denied')) } });
    expect(await failing?.(next)).toBeNull();
  });

  test('the command is copied before startWork is called, and the toast is the hand-off\'s for each outcome', async () => {
    const cases: Array<[HandoffOutcome | null, string]> = [
      ['drafted', 'Opened a draft in T3 Code'],
      ['sent', 'Sent to T3 Code'],
      ['no-github-remote', 'No GitHub remote; copied /factory next'],
      ['copy-only', 'Copied /factory next'],
      [null, 'Copied /factory next'],
    ];
    for (const [outcome, text] of cases) {
      const order: string[] = [];
      const write = async (c: string): Promise<boolean> => (order.push(`copy ${c}`), true);
      const start = async (r: StartWorkRequest): Promise<HandoffOutcome | null> => (order.push(`start ${r.action}`), outcome);
      expect(await copyThenStart(write, start, next, NEXT_COMMAND)).toEqual({ text, ok: true });
      expect(order).toEqual(['copy /factory next', 'start next']);
    }
    const failed = await copyThenStart(async () => false, async () => 'copy-only', next, NEXT_COMMAND);
    expect(failed).toEqual({ text: COPY_FAILED, ok: false });
  });

  test('in a plain browser every action only copies its command and says "Copied …"', async () => {
    const copied: string[] = [];
    const write = async (c: string): Promise<boolean> => (copied.push(c), true);
    const start = startWorkCaller('browser', { api: { call: async () => 'sent' } });
    const items = [nextStart(PID), ...toBacklog(backlogBody()).queued.map((i) => queuedStart(PID, i))].filter((x): x is StartItem => x !== null);
    for (const i of items) expect(await copyThenStart(write, start, i.req, i.command)).toEqual({ text: `Copied ${i.command}`, ok: true });
    expect(copied).toEqual(items.map((i) => i.command));
  });
});

// ---- 075: the startwork event ----

describe('075 AC5: the startwork payload check', () => {
  const LISTED = [
    { id: PID, name: 'factory' },
    { id: 'bbbbbbbbbbbb', name: 'notes' },
  ];

  test('accepts next with a listed id, and new-exploration with a listed id or null', () => {
    expect(startWorkPush({ action: 'next', project: PID }, LISTED)).toEqual({ action: 'next', project: PID });
    expect(startWorkPush({ action: 'new-exploration', project: 'bbbbbbbbbbbb' }, LISTED)).toEqual({ action: 'new-exploration', project: 'bbbbbbbbbbbb' });
    expect(startWorkPush({ action: 'new-exploration', project: null }, LISTED)).toEqual({ action: 'new-exploration', project: null });
    expect(startWorkPush({ project: null, action: 'new-exploration' }, LISTED)).toEqual({ action: 'new-exploration', project: null });
  });

  test('everything else does nothing', () => {
    const bad: unknown[] = [
      undefined,
      null,
      'next',
      42,
      [],
      [{ action: 'next', project: PID }],
      {},
      { action: 'next' },
      { project: PID },
      { action: 'run', project: PID },
      { action: 'explore', project: PID },
      { action: 'epic', project: PID },
      { action: 'NEXT', project: PID },
      { action: 'next', project: PID, command: '/factory next' },
      { action: 'new-exploration', project: null, idea: 'x' },
      { action: 'next', project: 42 },
      { action: 'next', project: '' },
      { action: 'new-exploration', project: '' },
      { action: 'new-exploration', project: ['x'] },
      { action: 'new-exploration', project: { id: PID } },
      { action: 'next', project: 'zzzzzzzzzzzz' },
      { action: 'new-exploration', project: 'zzzzzzzzzzzz' },
      { action: 'next', project: null },
      { action: 'new-exploration' },
      { action: 'new-exploration', project: undefined },
    ];
    for (const data of bad) expect({ data, push: startWorkPush(data, LISTED) }).toEqual({ data, push: null });
    expect(startWorkPush({ action: 'next', project: PID }, [])).toBeNull();
  });

  test('an accepted next is the Backlog sheet\'s Run next: copy, then startWork with { project, action: next }', async () => {
    const push = startWorkPush({ action: 'next', project: PID }, LISTED);
    expect(push).not.toBeNull();
    if (push === null || push.action !== 'next') return;
    const item = nextStart(push.project);
    expect(item).toEqual({ label: 'Run next', req: { project: PID, action: 'next' }, command: '/factory next' });
    const order: string[] = [];
    const sent: StartWorkRequest[] = [];
    const toast = await copyThenStart(
      async (c) => {
        order.push(`copy ${c}`);
        return true;
      },
      async (req) => {
        order.push('start');
        sent.push(req);
        return null;
      },
      item.req,
      item.command,
    );
    expect(order).toEqual(['copy /factory next', 'start']);
    expect(sent).toEqual([{ project: PID, action: 'next' }]);
    expect(toast.ok).toBe(true);
  });
});

describe('075 AC6: the project the New exploration sheet opens for', () => {
  const A = { id: 'aaaaaaaaaaaa', name: 'zeta', root: '/r/zeta' };
  const B = { id: 'bbbbbbbbbbbb', name: 'alpha', root: '/r/alpha' };
  const C = { id: 'cccccccccccc', name: 'mid', root: '/r/mid' };
  const ROOTLESS = { id: 'dddddddddddd', name: 'aaa-rootless', root: '' };
  const NULL_ROOT = { id: 'eeeeeeeeeeee', name: 'aab-null', root: null };
  const name = (p: { id: string; name: string }): { id: string; name: string } => ({ id: p.id, name: p.name });

  test('a named project (right-click, Backlog sheet) opens for it with no picker', () => {
    expect(exploreOpen(C.id, null, [A, B, C], B.id)).toEqual({ project: name(C), picker: null });
    expect(exploreOpen(C.id, A.id, [A, B, C], null)).toEqual({ project: name(C), picker: null });
    expect(exploreOpen('zzzzzzzzzzzz', null, [A, B, C], null)).toBeNull();
    expect(exploreOpen(ROOTLESS.id, null, [A, ROOTLESS], null)).toBeNull();
  });

  test('null with one project selected opens for it with no picker', () => {
    expect(exploreOpen(null, C.id, [A, B, C], B.id)).toEqual({ project: name(C), picker: null });
  });

  test('null under All Projects with exactly one listed project with a root opens for it with no picker', () => {
    expect(exploreOpen(null, null, [A], null)).toEqual({ project: name(A), picker: null });
    expect(exploreOpen(null, null, [ROOTLESS, A, NULL_ROOT], 'dddddddddddd')).toEqual({ project: name(A), picker: null });
    // a stale selection falls back as All Projects does
    expect(exploreOpen(null, 'zzzzzzzzzzzz', [A], null)).toEqual({ project: name(A), picker: null });
  });

  test('null under All Projects with several opens with a picker of only the rooted projects, by name', () => {
    const open = exploreOpen(null, null, [A, ROOTLESS, B, NULL_ROOT, C], null);
    expect(open).toEqual({ project: name(B), picker: [name(B), name(C), name(A)] });
  });

  test('the picker starts on the stored last-explored project when still listed with a root, else the first by name', () => {
    expect(exploreOpen(null, null, [A, B, C], C.id)?.project).toEqual(name(C));
    expect(exploreOpen(null, null, [A, B, C], 'zzzzzzzzzzzz')?.project).toEqual(name(B));
    expect(exploreOpen(null, null, [A, B, C, ROOTLESS], ROOTLESS.id)?.project).toEqual(name(B));
    expect(exploreOpen(null, null, [A, B, C], null)?.project).toEqual(name(B));
    expect(exploreOpen(null, null, [], null)).toBeNull();
    expect(exploreOpen(null, null, [ROOTLESS, NULL_ROOT], null)).toBeNull();
  });

  test('pickerStart: the last-explored choice, else the first by name, else null', () => {
    const choices = [name(A), name(B), name(C)];
    expect(pickerStart(choices, A.id)).toEqual(name(A));
    expect(pickerStart(choices, null)).toEqual(name(B));
    expect(pickerStart(choices, 'gone')).toEqual(name(B));
    expect(pickerStart([], A.id)).toBeNull();
    // a name tie falls back to the id
    expect(pickerStart([{ id: 'b', name: 'x' }, { id: 'a', name: 'x' }], null)).toEqual({ id: 'a', name: 'x' });
  });

  test('the last-explored key reads and writes through storage, and a blocked store is no store', () => {
    const map = new Map<string, string>();
    const store = { getItem: (k: string): string | null => map.get(k) ?? null, setItem: (k: string, v: string): void => void map.set(k, v) };
    expect(LAST_EXPLORED_KEY).toBe('andon.lastExplored');
    expect(loadLastExplored(store)).toBeNull();
    saveLastExplored(store, C.id);
    expect(map.get(LAST_EXPLORED_KEY)).toBe(C.id);
    expect(loadLastExplored(store)).toBe(C.id);
    map.set(LAST_EXPLORED_KEY, '');
    expect(loadLastExplored(store)).toBeNull();
    const blocked = {
      getItem: (): string | null => {
        throw new Error('blocked');
      },
      setItem: (): void => {
        throw new Error('blocked');
      },
    };
    expect(loadLastExplored(blocked)).toBeNull();
    expect(() => saveLastExplored(blocked, C.id)).not.toThrow();
    expect(loadLastExplored(null)).toBeNull();
  });
});

describe('starting work on a remote project (brief andon-machines-ui, AC7)', () => {
  const ID = '1a2b3c4d5e6f@studio';
  const state = () => applyEvent(applyEvent(emptyState(), 'projects', { projects: [LOCAL_FACTORY, STUDIO_FACTORY] }), 'machines', machinesBody(machineEntry(HUB), machineEntry('studio')));

  test('Start Work, Run Next, and New Exploration send the remote id unchanged', async () => {
    const calls: unknown[][] = [];
    const start = startWorkCaller('mac', { api: { call: (...args: unknown[]) => (calls.push(args), Promise.resolve('copy-only')) } });
    const items: StartItem[] = [nextStart(ID), newExplorationStart(ID, 'an idea'), { label: 'Run', req: { project: ID, action: 'run', slug: 'sign-in' }, command: runCommand('Sign-in') }];
    for (const item of items) await start?.(item.req);
    expect(calls.map((c) => c[1])).toEqual(items.map((i) => i.req));
    for (const c of calls) expect(c[1]).toMatchObject({ project: ID });
  });

  test('a successful copy-only or null outcome toasts "Copied. Run it on studio"; drafted, sent, no-github-remote, and local projects read as today', async () => {
    const s = state();
    const run = async (outcome: HandoffOutcome | null, pid: string, browser = false) =>
      copyThenStart(async () => true, browser ? null : async () => outcome, nextStart(pid).req, NEXT_COMMAND, remoteOfId(s, pid));
    expect(await run('copy-only', STUDIO_FACTORY.id)).toEqual({ text: 'Copied. Run it on studio', ok: true });
    expect(await run(null, STUDIO_FACTORY.id)).toEqual({ text: 'Copied. Run it on studio', ok: true });
    expect(await run(null, STUDIO_FACTORY.id, true)).toEqual({ text: 'Copied. Run it on studio', ok: true }); // a browser
    expect(await run('drafted', STUDIO_FACTORY.id)).toEqual({ text: 'Opened a draft in T3 Code', ok: true });
    expect(await run('sent', STUDIO_FACTORY.id)).toEqual({ text: 'Sent to T3 Code', ok: true });
    expect(await run('no-github-remote', STUDIO_FACTORY.id)).toEqual({ text: 'No GitHub remote; copied /factory next', ok: true });
    const quiet: Array<HandoffOutcome | null> = ['copy-only', null];
    for (const o of quiet) expect(await run(o, LOCAL_FACTORY.id)).toEqual({ text: 'Copied /factory next', ok: true });
    expect(await copyThenStart(async () => false, async () => 'copy-only', nextStart(ID).req, NEXT_COMMAND, 'studio')).toEqual({ text: COPY_FAILED, ok: false });
  });

  test('AC1: with only the hub listed, no project is remote, so no toast names a machine', () => {
    const s = applyEvent(state(), 'machines', machinesBody(machineEntry(HUB)));
    expect([remoteOfId(s, LOCAL_FACTORY.id), remoteOfId(s, STUDIO_FACTORY.id)]).toEqual([null, null]);
  });
});
