import { describe, expect, test } from 'bun:test';
import { MAX_COMMAND } from './handoff';
import type { MenuProject } from './projectmenu';
import { NEXT_COMMAND, START_WORK_METHOD, backlogPath, liveBacklog, needsBacklog, startArgv, startShape, startWorkRequest } from './startwork';

const PID = 'aaaaaaaaaaaa';
const ROOT = '/Users/me/code/factory';
const PROJECTS: MenuProject[] = [
  { id: PID, name: 'factory', root: ROOT, machine: null },
  { id: 'bbbbbbbbbbbb', name: 'rootless', root: null, machine: null },
  { id: 'cccccccccccc', name: 'relative', root: 'code/relative', machine: null },
];
const item = (kind: string, slug: string | null, title: string): Record<string, unknown> => ({ kind, slug, title, done: null, status: null, members: kind === 'epic' ? 2 : null, abandoned: [] });
const BACKLOG = {
  queued: [item('brief', 'notes-search', 'Full-text search'), item('epic', 'auth', 'Sign-in'), item('text', null, 'Tidy the README'), item('text', null, '   ')],
  exploring: [item('brief', 'tag-cloud', 'A tag cloud'), item('epic', 'billing', 'Billing plan')],
};

describe('068 AC1: the start request, checked against the projects and the live backlog', () => {
  test('the method name, and the backlog path the backend reads', () => {
    expect(START_WORK_METHOD).toBe('startWork');
    expect(backlogPath(PID)).toBe('/projects/aaaaaaaaaaaa/backlog');
    expect(backlogPath('a/b')).toBe('/projects/a%2Fb/backlog');
  });

  test('each valid request gets the listed project, the action, the command, and the thread title', () => {
    const p = { id: PID, name: 'factory', root: ROOT, machine: null };
    expect(startWorkRequest({ project: PID, action: 'run', slug: 'notes-search' }, PROJECTS, BACKLOG)).toEqual({ project: p, action: 'run', command: '/factory next Full-text search', title: 'next notes-search' });
    expect(startWorkRequest({ project: PID, action: 'run', title: 'Tidy the README' }, PROJECTS, BACKLOG)).toEqual({ project: p, action: 'run', command: '/factory next Tidy the README', title: 'next Tidy the README' });
    expect(startWorkRequest({ project: PID, action: 'epic', slug: 'auth' }, PROJECTS, BACKLOG)).toEqual({ project: p, action: 'epic', command: '/factory epic auth', title: 'epic auth' });
    expect(startWorkRequest({ project: PID, action: 'next' }, PROJECTS, BACKLOG)).toEqual({ project: p, action: 'next', command: '/factory next', title: 'next' });
    expect(startWorkRequest({ project: PID, action: 'explore', slug: 'tag-cloud' }, PROJECTS, BACKLOG)).toEqual({ project: p, action: 'explore', command: '/factory explore tag-cloud', title: 'explore tag-cloud' });
    expect(startWorkRequest({ project: PID, action: 'explore', slug: 'billing' }, PROJECTS, BACKLOG)?.command).toBe('/factory explore billing');
    expect(startWorkRequest({ project: PID, action: 'new-exploration', idea: 'a tag cloud' }, PROJECTS, BACKLOG)).toEqual({ project: p, action: 'new-exploration', command: '/factory explore "a tag cloud"', title: 'explore' });
  });

  test('Run next and New exploration need no backlog; the item actions do', () => {
    expect(startWorkRequest({ project: PID, action: 'next' }, PROJECTS, null)?.command).toBe(NEXT_COMMAND);
    expect(startWorkRequest({ project: PID, action: 'new-exploration', idea: 'x' }, PROJECTS, null)?.command).toBe('/factory explore "x"');
    for (const req of [{ project: PID, action: 'run', slug: 'notes-search' }, { project: PID, action: 'epic', slug: 'auth' }, { project: PID, action: 'explore', slug: 'tag-cloud' }]) {
      const s = startShape(req, PROJECTS);
      expect(s !== null && needsBacklog(s)).toBe(true);
      expect(startWorkRequest(req, PROJECTS, null)).toBeNull();
    }
    for (const req of [{ project: PID, action: 'next' }, { project: PID, action: 'new-exploration', idea: 'x' }]) {
      const s = startShape(req, PROJECTS);
      expect(s !== null && needsBacklog(s)).toBe(false);
    }
  });

  test('the title in a Run command is the service\'s copy, never the page\'s', () => {
    const b = { queued: [item('brief', 'notes-search', 'The service title')], exploring: [] };
    expect(startWorkRequest({ project: PID, action: 'run', slug: 'notes-search' }, PROJECTS, b)?.command).toBe('/factory next The service title');
  });

  test('an unknown or rootless project, or an item in the other group or with the wrong kind, is refused', () => {
    const bad: unknown[] = [
      { project: 'zzzzzzzzzzzz', action: 'next' },
      { project: 'bbbbbbbbbbbb', action: 'next' },
      { project: 'cccccccccccc', action: 'next' },
      { project: ROOT, action: 'next' },
      { project: '', action: 'next' },
      { project: PID, action: 'run', slug: 'auth' }, // a queued epic: Start epic, not Run
      { project: PID, action: 'run', slug: 'tag-cloud' }, // exploring, not queued
      { project: PID, action: 'run', slug: 'missing' },
      { project: PID, action: 'run', title: 'Full-text search' }, // a brief's title: it is named by its slug
      { project: PID, action: 'run', title: 'Tidy the readme' }, // not exactly equal
      { project: PID, action: 'run', title: 'Tidy the README ' },
      { project: PID, action: 'run', title: '   ' }, // a blank line's title
      { project: PID, action: 'run', title: '' },
      { project: PID, action: 'epic', slug: 'notes-search' }, // Start epic on a queued brief
      { project: PID, action: 'epic', slug: 'billing' }, // an exploring plan
      { project: PID, action: 'explore', slug: 'notes-search' }, // Continue exploring on a queued line
      { project: PID, action: 'explore', slug: 'auth' },
      { project: PID, action: 'explore', slug: 'nope' },
      ...['Auth', 'a b', '../auth', 'auth;rm', 'auth\n', '-auth', 'auth-', 'a--b', ''].map((slug) => ({ project: PID, action: 'epic', slug })),
      { project: PID, action: 'new-exploration', idea: '' },
      { project: PID, action: 'new-exploration', idea: '  \n\t ' },
      { project: PID, action: 'queue' },
      { project: PID, action: 'NEXT' },
      { project: PID, action: 'approve' },
    ];
    for (const p of bad) expect({ p, r: startWorkRequest(p, PROJECTS, BACKLOG) }).toEqual({ p, r: null });
  });

  test('extra fields, missing fields, wrong types, and non-objects are refused', () => {
    const bad: unknown[] = [
      null,
      undefined,
      'next',
      42,
      [],
      [PID, 'next'],
      {},
      { action: 'next' },
      { project: PID },
      { project: PID, action: 'next', slug: 'auth' },
      { project: PID, action: 'next', command: '/factory next' },
      { project: PID, action: 'run' },
      { project: PID, action: 'run', slug: 'notes-search', title: 'Full-text search' },
      { project: PID, action: 'run', slug: 'notes-search', prompt: 'x' },
      { project: PID, action: 'run', slug: 7 },
      { project: PID, action: 'run', title: ['Tidy the README'] },
      { project: PID, action: 'epic', slug: 'auth', root: ROOT },
      { project: PID, action: 'epic', title: 'Sign-in' },
      { project: PID, action: 'explore', slug: 'tag-cloud', idea: 'x' },
      { project: PID, action: 'explore' },
      { project: PID, action: 'new-exploration' },
      { project: PID, action: 'new-exploration', idea: 'x', slug: 'tag-cloud' },
      { project: PID, action: 'new-exploration', idea: 3 },
      { project: 1, action: 'next' },
      { project: PID, action: ['next'] },
    ];
    for (const p of bad) expect({ p, r: startWorkRequest(p, PROJECTS, BACKLOG) }).toEqual({ p, r: null });
  });

  test('a command over MAX_COMMAND is refused: an idea, or a service title, too long', () => {
    const fits = 'x'.repeat(MAX_COMMAND - '/factory explore ""'.length);
    expect(startWorkRequest({ project: PID, action: 'new-exploration', idea: fits }, PROJECTS, null)?.command).toHaveLength(MAX_COMMAND);
    expect(startWorkRequest({ project: PID, action: 'new-exploration', idea: `${fits}x` }, PROJECTS, null)).toBeNull();
    const long = 'y'.repeat(MAX_COMMAND);
    const b = { queued: [item('text', null, long)], exploring: [] };
    expect(startWorkRequest({ project: PID, action: 'run', title: long }, PROJECTS, b)).toBeNull();
  });

  test('a malformed backlog body counts as no backlog; a malformed item is skipped', () => {
    for (const body of [null, 'x', [], {}, { queued: [] }, { queued: 'no', exploring: [] }]) {
      expect({ body, b: liveBacklog(body) }).toEqual({ body, b: null });
      expect(startWorkRequest({ project: PID, action: 'epic', slug: 'auth' }, PROJECTS, body)).toBeNull();
    }
    expect(liveBacklog({ queued: [null, 1, { kind: 'weird', title: 'x' }, { kind: 'brief', slug: 3, title: 'x' }, item('epic', 'auth', 'Sign-in')], exploring: [] })).toEqual({
      queued: [{ kind: 'epic', slug: 'auth', title: 'Sign-in' }],
      exploring: [],
    });
  });
});

describe('068 AC2: the commands, and the thread title for send mode', () => {
  test('the idea is trimmed, newlines become spaces, and `"` and `\\` are escaped', () => {
    expect(startWorkRequest({ project: PID, action: 'new-exploration', idea: '  say "hi"\\now\r\nplease\n' }, PROJECTS, null)?.command).toBe('/factory explore "say \\"hi\\"\\\\now please"');
  });

  test('the send argv: `<t3> thread start --title <action item> <root> <command>`', () => {
    const w = startWorkRequest({ project: PID, action: 'epic', slug: 'auth' }, PROJECTS, BACKLOG);
    expect(w && startArgv('/opt/t3', w)).toEqual(['/opt/t3', 'thread', 'start', '--title', 'epic auth', ROOT, '/factory epic auth']);
    const n = startWorkRequest({ project: PID, action: 'next' }, PROJECTS, null);
    expect(n && startArgv('/opt/t3', n)).toEqual(['/opt/t3', 'thread', 'start', '--title', 'next', ROOT, '/factory next']);
  });
});
