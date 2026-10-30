import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchBacklog, fetchBrief, fetchPage, fetchPlan } from './api';
import type { Fetcher } from './api';
import {
  NO_BACKLOG,
  backlogCountText,
  backlogProjects,
  backlogSheet,
  docPage,
  pageOf,
  planMemberRows,
  planMembers,
  statusOf,
  titleOf,
  toBacklog,
  toBacklogCounts,
  toBacklogItem,
} from './backlog';
import type { BacklogList, DocText } from './backlog';
import { backlogBody, briefText, planText } from './fixtures';
import { markdown } from './markdown';

const P1 = { id: 'p1', name: 'Minerva' };
const P2 = { id: 'p2', name: 'ledgerline' };
const loaded = (data: unknown, rev = 1): BacklogList => ({ status: 'loaded', ...toBacklog(data), reason: null, rev });

describe('narrowing the service (067 AC1, AC2)', () => {
  test('a board\'s backlog counts: two non-negative integers, else none', () => {
    expect(toBacklogCounts({ queued: 3, exploring: 1 })).toEqual({ queued: 3, exploring: 1 });
    expect(toBacklogCounts({ queued: 0, exploring: 0 })).toEqual(NO_BACKLOG);
    for (const v of [undefined, null, 3, [], {}, { queued: 3 }, { queued: -1, exploring: 0 }, { queued: 1.5, exploring: 0 }, { queued: '3', exploring: 1 }]) expect({ v, c: toBacklogCounts(v) }).toEqual({ v, c: { queued: 0, exploring: 0 } });
  });

  test('items keep the service\'s fields and order; a malformed item is dropped, a brief with a bad slug is text', () => {
    const b = toBacklog(backlogBody());
    expect(b.queued.map((i) => [i.kind, i.slug, i.title])).toEqual([
      ['brief', 'notes-search', 'Full-text search'],
      ['epic', 'auth', 'Sign-in'],
      ['text', null, 'Tidy the README'],
    ]);
    expect(b.queued[0]).toEqual({ kind: 'brief', slug: 'notes-search', title: 'Full-text search', done: 'search finds notes by body', status: 'ready', members: null, abandoned: ['003-notes-search: too broad'] });
    expect(b.exploring.map((i) => i.slug)).toEqual(['tag-cloud']);
    expect(toBacklogItem({ kind: 'weird', title: 'x' })).toBeNull();
    expect(toBacklogItem({ kind: 'brief', slug: 'x' })).toBeNull();
    expect(toBacklogItem({ kind: 'brief', slug: '../etc', title: 'x' })?.kind).toBe('text');
    expect(toBacklogItem({ kind: 'epic', slug: 'e', title: 'x', members: 'many' })?.members).toBe(0);
    expect(toBacklog(null)).toEqual({ queued: [], exploring: [] });
    expect(toBacklog({ queued: 'no', exploring: [null, 1] })).toEqual({ queued: [], exploring: [] });
  });

  test('a text line has no page; a brief opens its brief, an epic its plan', () => {
    const [brief, epic, text] = toBacklog(backlogBody()).queued;
    expect(brief && pageOf('p1', brief)).toEqual({ kind: 'brief', project: 'p1', slug: 'notes-search' });
    expect(epic && pageOf('p1', epic)).toEqual({ kind: 'plan', project: 'p1', slug: 'auth' });
    expect(text && pageOf('p1', text)).toBeNull();
  });
});

describe('the Backlog sheet model (067 AC2)', () => {
  test('per project, Queued in response order (title, done-text, kind, member count, abandoned attempts), then In exploration', () => {
    const m = backlogSheet([P1], { p1: loaded(backlogBody()) }, null);
    expect(m.loading).toBe(false);
    expect(m.projects.map((p) => [p.id, p.name, p.groups.map((g) => g.name)])).toEqual([['p1', 'Minerva', ['Queued', 'In exploration']]]);
    const [queued, exploring] = m.projects[0]?.groups ?? [];
    expect(queued?.rows.map((r) => [r.kindLabel, r.title, r.done, r.members, r.abandoned])).toEqual([
      ['Brief', 'Full-text search', 'search finds notes by body', null, ['003-notes-search: too broad']],
      ['Epic', 'Sign-in', null, '3 members', []],
      ['Text', 'Tidy the README', 'the README reads well', null, []],
    ]);
    expect(queued?.rows.map((r) => r.page)).toEqual([{ kind: 'brief', project: 'p1', slug: 'notes-search' }, { kind: 'plan', project: 'p1', slug: 'auth' }, null]);
    expect(exploring?.rows.map((r) => [r.kindLabel, r.title, r.status])).toEqual([['Brief', 'A tag cloud', 'draft']]);
    expect(new Set(m.projects.flatMap((p) => p.groups.flatMap((g) => g.rows.map((r) => r.key)))).size).toBe(4);
    expect([m.queued, m.exploring]).toEqual([3, 1]);
    expect(backlogCountText(m)).toBe('3 queued · 1 in exploration');
  });

  test('briefs before plans, as served; an empty group is omitted, and a project with nothing is left out', () => {
    const exploring = [
      { kind: 'brief', slug: 'b', title: 'B', done: null, status: 'draft', members: null, abandoned: [] },
      { kind: 'epic', slug: 'a', title: 'A plan', done: null, status: 'draft', members: 0, abandoned: [] },
    ];
    const m = backlogSheet([P1, P2], { p1: loaded({ queued: [], exploring }), p2: loaded({ queued: [], exploring: [] }) }, null);
    expect(m.projects.map((p) => p.id)).toEqual(['p1']);
    expect(m.projects[0]?.groups.map((g) => [g.name, g.rows.map((r) => [r.kindLabel, r.title, r.members])])).toEqual([
      ['In exploration', [['Brief', 'B', null], ['Epic', 'A plan', '0 members']]],
    ]);
  });

  test('a filtered sheet shows only its project; clearing the filter shows every project in registration order', () => {
    const lists = { p1: loaded(backlogBody()), p2: loaded(backlogBody()) };
    expect(backlogProjects([P1, P2], 'p2')).toEqual(['p2']);
    expect(backlogProjects([P1, P2], 'gone')).toEqual([]);
    expect(backlogProjects([P1, P2], null)).toEqual(['p1', 'p2']);
    expect(backlogSheet([P1, P2], lists, 'p2').projects.map((p) => p.id)).toEqual(['p2']);
    expect(backlogSheet([P1, P2], lists, null).projects.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  test('until a first list arrives it is loading; a failed fetch shows that project\'s reason only, a re-fetch keeps the last list', () => {
    expect(backlogSheet([P1], {}, null)).toEqual({ projects: [], loading: true, queued: 0, exploring: 0 });
    expect(backlogSheet([P1], {}, 'p1').projects).toEqual([{ id: 'p1', name: 'Minerva', loading: true, reason: null, groups: [] }]);
    const failed: BacklogList = { status: 'failed', queued: null, exploring: null, reason: 'config.json: bad', rev: 1 };
    const m = backlogSheet([P1, P2], { p1: failed, p2: loaded(backlogBody()) }, null);
    expect(m.projects.map((p) => [p.id, p.reason, p.groups.length])).toEqual([
      ['p1', 'config.json: bad', 0],
      ['p2', null, 2],
    ]);
    expect(m.loading).toBe(false);
    const refetching: BacklogList = { ...loaded(backlogBody()), status: 'loading', rev: 2 };
    expect(backlogSheet([P1], { p1: refetching }, null).projects[0]?.groups.length).toBe(2);
  });

  test('App.svelte opens it from the toolbar unfiltered, keeps it in the hash, and fetches only while it is open or a search needs it', () => {
    const app = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8');
    expect(app).toContain('onbacklog={() => openBacklog(null)}');
    expect(app).toContain('backlog: backlogOpen ? { project: backlogProject } : null,');
    expect(app).toContain('page: openDoc ?? undefined,');
    expect(app).toContain("const backlogPids = $derived(backlogOpen ? backlogProjects(ui.projects, backlogProject) : query.trim() !== '' ? inView.map((p) => p.id) : []);");
    expect(app).toContain('live?.watchBacklog(backlogPids);');
  });

  test('the sheet is built like the Settled sheet, and rows with a page open it', () => {
    const sheet = readFileSync(join(import.meta.dir, 'BacklogSheet.svelte'), 'utf8');
    expect(sheet).toContain('<Sheet {open} labelledby="backlog-title" {onclose}>');
    expect(sheet).toContain('class="filter-chip"');
    expect(sheet).toContain('onclick={onclearfilter}');
    expect(sheet).toContain('onclick={() => onopenpage(page)}');
  });
});

describe('brief and plan pages (067 AC4, AC5)', () => {
  test('the page renders the text with markdown(), titled by its first heading, with its status', () => {
    const text = briefText('ready', 'Full-text search');
    const page = docPage({ kind: 'brief', project: 'p1', slug: 'notes-search' }, 'Minerva', { state: 'ok', path: 'briefs/notes-search.md', text });
    expect(page).toEqual({
      ref: { kind: 'brief', project: 'p1', slug: 'notes-search' },
      project: 'Minerva',
      kindLabel: 'Brief',
      path: 'briefs/notes-search.md',
      title: 'Full-text search',
      status: 'ready',
      html: markdown(text),
      note: null,
      members: null,
    });
    expect(docPage({ kind: 'brief', project: 'p1', slug: 's' }, 'Minerva', null)).toMatchObject({ html: null, note: 'Loading…', title: 's' });
    expect(docPage({ kind: 'plan', project: 'p1', slug: 's' }, 'Minerva', { state: 'missing' })).toMatchObject({ html: null, note: 'No such plan.', path: 'epics/s.md' });
    expect(docPage({ kind: 'brief', project: 'p1', slug: 's' }, 'Minerva', { state: 'failed', reason: 'HTTP 500' })).toMatchObject({ html: null, note: 'HTTP 500' });
  });

  test('statusOf and titleOf read a brief as the contract does: the first - Status: before any ## heading', () => {
    expect(statusOf(briefText(' draft '))).toBe('draft');
    expect(statusOf('# T\n\n## Intent\n- Status: ready\n')).toBeNull();
    expect(statusOf('no status')).toBeNull();
    expect(titleOf('# Title here\n', 's')).toBe('Title here');
    expect(titleOf('no heading', 'slug')).toBe('slug');
  });

  test('a plan\'s members, in plan order, from its ## Members section only', () => {
    expect(planMembers(planText)).toEqual(['auth-service', 'auth-ui', 'auth-docs']);
    expect(planMembers('# P\n- Status: draft\n')).toEqual([]);
    expect(planMembers('## Members\n- `ok`\n- `Bad_Slug`\n  - `indented`\n* `star`\n- `ok`\n')).toEqual(['ok']);
  });

  test('each member shows its brief\'s status, "no brief" for a 404, and opens its brief\'s page', () => {
    const briefs = new Map<string, DocText>([
      ['auth-service', { state: 'ok', path: 'briefs/auth-service.md', text: briefText('done') }],
      ['auth-ui', { state: 'missing' }],
    ]);
    const rows = planMemberRows('p1', planMembers(planText), briefs);
    expect(rows.map((r) => [r.n, r.slug, r.status, r.tone])).toEqual([
      [1, 'auth-service', 'done', 'done'],
      [2, 'auth-ui', 'no brief', 'none'],
      [3, 'auth-docs', '…', 'none'],
    ]);
    expect(rows[1]?.page).toEqual({ kind: 'brief', project: 'p1', slug: 'auth-ui' });
    const page = docPage({ kind: 'plan', project: 'p1', slug: 'auth' }, 'Minerva', { state: 'ok', path: 'epics/auth.md', text: planText }, briefs);
    expect(page.kindLabel).toBe('Plan');
    expect(page.members?.map((m) => m.status)).toEqual(['done', 'no brief', '…']);
    expect(planMemberRows('p1', ['x'], new Map([['x', { state: 'ok', path: 'briefs/x.md', text: '# X\n' }]]))[0]?.status).toBe('no status');
  });

  test('the inspector shows the page and lists its members, each opening its brief', () => {
    const ins = readFileSync(join(import.meta.dir, 'Inspector.svelte'), 'utf8');
    expect(ins).toContain('docPage(docRef, pageProject, docText, memberBriefs)');
    expect(ins).toContain('{@html doc.html}');
    expect(ins).toContain('onclick={() => onopenpage(m.page)}');
  });
});

describe('the fetches (067 AC2, AC4, AC5)', () => {
  const service = (routes: Record<string, { status: number; body: string }>, asked: string[] = []): Fetcher => async (path) => {
    asked.push(path);
    const r = routes[path] ?? { status: 404, body: 'not found' };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body };
  };

  test('the backlog, a brief, and a plan are GETs of their paths; a 404 is missing, other failures say why', async () => {
    const asked: string[] = [];
    const f = service(
      {
        '/projects/p1/backlog': { status: 200, body: JSON.stringify(backlogBody()) },
        '/projects/p1/briefs/notes-search': { status: 200, body: JSON.stringify({ path: 'briefs/notes-search.md', text: '# N\n' }) },
        '/projects/p1/plans/auth': { status: 500, body: 'boom\nmore' },
        '/projects/p1/briefs/odd': { status: 200, body: JSON.stringify({ text: 1 }) },
      },
      asked,
    );
    expect(await fetchBacklog(f, 'p1')).toEqual({ ok: true, data: backlogBody() });
    expect(await fetchBrief(f, 'p1', 'notes-search')).toEqual({ state: 'ok', path: 'briefs/notes-search.md', text: '# N\n' });
    expect(await fetchBrief(f, 'p1', 'gone')).toEqual({ state: 'missing' });
    expect(await fetchPlan(f, 'p1', 'auth')).toEqual({ state: 'failed', reason: 'boom' });
    expect(await fetchBrief(f, 'p1', 'odd')).toEqual({ state: 'failed', reason: 'unreadable' });
    expect(await fetchPage(f, { kind: 'plan', project: 'p1', slug: 'auth' })).toEqual({ state: 'failed', reason: 'boom' });
    expect(asked).toEqual(['/projects/p1/backlog', '/projects/p1/briefs/notes-search', '/projects/p1/briefs/gone', '/projects/p1/plans/auth', '/projects/p1/briefs/odd', '/projects/p1/plans/auth']);
  });

  test('a slug that fails the slug rule reads nothing', async () => {
    const asked: string[] = [];
    const f = service({}, asked);
    for (const slug of ['..', '../x', 'A', '', '-a', 'a-', 'a--b', 'a/b']) expect(await fetchBrief(f, 'p1', slug)).toEqual({ state: 'missing' });
    expect(await fetchPlan(f, 'p1', '..')).toEqual({ state: 'missing' });
    expect(asked).toEqual([]);
  });
});
