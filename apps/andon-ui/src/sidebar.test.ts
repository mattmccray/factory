import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBoard } from './board';
import { HOUR, NOW, before, job, projectRelease, releaseBody, tag } from './fixtures';
import { kindOf } from './lanes';
import type { Status } from './live';
import { ALL, SELECTION_KEY, boardJobs, hotEpics, loadSelection, resolveSelection, saveSelection } from './projects';
import { BACKLOG_EVENT, INSPECTOR_EVENT, LEGEND, MAC_INSET, MENU_EVENTS, MERGED_EVENT, NEEDS_ME_EVENT, PUSHED_EVENTS, SETTLED_EVENT, SIDEBAR_EVENT, STATUS_BAR_EVENT, VIEW_STATE_METHOD, WHATS_NEW_EVENT, footer, footerLine, footerRelease, frame, isActive, projectStatus, pushSubscriber, reviewFailed, settleHours, settleText, shellMode, sidebarModel, statusBarHidden, mergedHidden, menuEventAction, viewStateCaller, subtitle, subtitleText, title } from './sidebar';
import { applyEvent, emptyState } from './state';
import type { UiState } from './state';
import { AGENT_LAB, HUB, LOCAL_FACTORY, LOCAL_NOTES, MACHINE_PROJECTS, STUDIO_API, STUDIO_FACTORY, localAt, machineEntry, machineProject, machinesBody } from './fixtures';
import { needsFilter } from './find';
import { needsHuman } from './projects';
import { sidebarStops } from './keys';

// Registered out of name order, so the sidebar's sort shows.
const ZED = { id: 'zzzzzzzzzzzz', name: 'zed', root: '/r/zed' }; // two needs-human, one active
const ALPHA = { id: 'aaaaaaaaaaaa', name: 'Alpha', root: '/r/alpha' }; // review failed: a complete round with a CHANGES
const MID = { id: 'mmmmmmmmmmmm', name: 'mid', root: '/r/mid' }; // active only
const BETA = { id: 'bbbbbbbbbbbb', name: 'beta', root: '/r/beta' }; // idle: only settled jobs
const NEW = { id: 'nnnnnnnnnnnn', name: 'new', root: '/r/new' }; // no board yet

function state(): UiState {
  let s = applyEvent(emptyState(), 'projects', { projects: [ZED, ALPHA, MID, BETA, NEW] });
  s = applyEvent(s, 'board', {
    project: ZED.id,
    config: { reviewers: ['code'] },
    jobs: [
      { id: '001-a', stage: 'needs-human', updated: before(HOUR) },
      { id: '002-b', stage: 'needs-human', updated: before(HOUR) },
      { id: '003-c', stage: 'review', round: 1, reviews: { code: 'CHANGES' }, updated: before(HOUR) }, // failed, but red wins
      { id: '004-d', stage: 'merged', endedAt: before(HOUR), updated: before(HOUR) },
    ],
  });
  s = applyEvent(s, 'board', {
    project: ALPHA.id,
    config: { reviewers: ['code', 'ui'], dashboard: { settleAfterHours: 2 } },
    jobs: [
      { id: '001-a', stage: 'review', round: 1, reviews: { code: 'PASS', ui: 'CHANGES' }, updated: before(HOUR) },
      { id: '002-b', stage: 'review', round: 1, reviews: { code: 'pending' }, updated: before(HOUR) },
    ],
  });
  s = applyEvent(s, 'board', {
    project: MID.id,
    config: {},
    jobs: [
      { id: '001-a', stage: 'claimed', updated: before(HOUR) },
      { id: '002-b', stage: 'build', round: 1, reviews: { code: 'CHANGES' }, updated: before(HOUR) }, // back in build after CHANGES: rework, not failed
      { id: '003-c', stage: 'approve', updated: before(HOUR) },
    ],
  });
  s = applyEvent(s, 'board', {
    project: BETA.id,
    config: {},
    jobs: [{ id: '001-a', stage: 'merged', endedAt: before(48 * HOUR), updated: before(48 * HOUR) }],
  });
  return s;
}

describe('the sidebar model (AC1)', () => {
  test('lists every registered project, sorted by name, case-insensitively', () => {
    expect(sidebarModel(state(), ALL).projects.map((p) => p.name)).toEqual(['Alpha', 'beta', 'mid', 'new', 'zed']);
  });

  test('each dot is the project\'s worst state: red > orange > blue > gray', () => {
    const rows = sidebarModel(state(), ALL).projects;
    expect(rows.map((p) => [p.name, p.state, p.dot])).toEqual([
      ['Alpha', 'review-failed', 'orange'],
      ['beta', 'idle', 'gray'],
      ['mid', 'active', 'blue'],
      ['new', 'idle', 'gray'],
      ['zed', 'needs-human', 'red'],
    ]);
  });

  test('badges: red with the needs-human count, else gray with the active count, else none', () => {
    const rows = sidebarModel(state(), ALL).projects;
    expect(rows.map((p) => [p.name, p.badge])).toEqual([
      ['Alpha', { tone: 'gray', count: 2, label: '2 active' }],
      ['beta', null],
      ['mid', { tone: 'gray', count: 3, label: '3 active' }],
      ['new', null],
      ['zed', { tone: 'red', count: 2, label: '2 need a human' }],
    ]);
  });

  test('All Projects carries a red badge with the total needs-human count, and none at zero', () => {
    expect(sidebarModel(state(), ALL).all).toEqual({ badge: { tone: 'red', count: 2, label: '2 need a human' }, selected: true });
    let s = state();
    s = applyEvent(s, 'board', { project: ZED.id, config: {}, jobs: [] });
    s = applyEvent(s, 'board', { project: ALPHA.id, config: {}, jobs: [{ id: '009-x', stage: 'needs-human' }] });
    expect(sidebarModel(s, ALL).all.badge).toEqual({ tone: 'red', count: 1, label: '1 needs a human' });
    expect(sidebarModel(applyEvent(s, 'board', { project: ALPHA.id, config: {}, jobs: [] }), ALL).all.badge).toBeNull();
  });

  test('a project with only settled or merged jobs is idle; active excludes merged and needs-human', () => {
    expect(projectStatus([job({ id: '1', stage: 'merged', endedAt: before(HOUR) })])).toEqual({ state: 'idle', badge: null });
    expect(projectStatus([])).toEqual({ state: 'idle', badge: null });
    for (const stage of ['claimed', 'spec', 'build', 'review', 'approve']) expect(isActive(job({ id: '1', stage }))).toBe(true);
    for (const stage of ['merged', 'needs-human', 'abandoned']) expect(isActive(job({ id: '1', stage }))).toBe(false);
  });

  test('review failed is the lanes\' §5 kind rule: stage review, the round complete, and a CHANGES (025 AC1)', () => {
    const cases: Array<Record<string, unknown>> = [
      { id: '1', stage: 'review', round: 1, reviews: { code: 'CHANGES', ui: 'PASS' } },
      { id: '1', stage: 'review', round: 1, reviews: { code: 'CHANGES', ui: 'pending' } },
      { id: '1', stage: 'review', round: 1, reviews: { code: 'PASS' } },
      { id: '1', stage: 'build', round: 1, reviews: { code: 'CHANGES' } },
      { id: '1', stage: 'build', round: 0 },
    ];
    expect(cases.map((c) => reviewFailed(job(c)))).toEqual([true, false, false, false, false]);
    for (const c of cases) expect(reviewFailed(job(c))).toBe(kindOf(tag(job(c)), NOW) === 'review-failed');
  });
});

describe('the selection (AC2)', () => {
  const store = (): { data: Map<string, string>; getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };

  test('a stored andon.project shows that project selected, and the board holds only its jobs', () => {
    const s = state();
    const kv = store();
    kv.setItem(SELECTION_KEY, MID.id);
    const sel = resolveSelection(s, loadSelection(kv));
    const model = sidebarModel(s, sel);
    expect(model.projects.filter((p) => p.selected).map((p) => p.id)).toEqual([MID.id]);
    expect(model.all.selected).toBe(false);
    expect(boardJobs(s, sel).every((b) => b.project.id === MID.id)).toBe(true);
    expect(boardJobs(s, sel)).toHaveLength(3);
  });

  test('selecting a row, or All Projects, saves it under andon.project', () => {
    const kv = store();
    saveSelection(kv, ALPHA.id);
    expect(kv.data.get('andon.project')).toBe(ALPHA.id);
    saveSelection(kv, ALL);
    expect(kv.data.get('andon.project')).toBe(ALL);
  });

  test('a stored id that is no longer registered falls back to All Projects', () => {
    const s = state();
    const kv = store();
    kv.setItem(SELECTION_KEY, 'gone');
    const sel = resolveSelection(s, loadSelection(kv));
    expect(sel).toBe(ALL);
    expect(sidebarModel(s, sel).all.selected).toBe(true);
    expect(sidebarModel(s, 'gone').all.selected).toBe(true); // even unresolved, no row is selected
    expect(sidebarModel(s, 'gone').projects.some((p) => p.selected)).toBe(false);
  });
});

describe('the footer and toolbar texts (AC3)', () => {
  test('the footer: connected with the project count, connecting, or unreachable, each with its dot', () => {
    expect(footer('live', 3)).toEqual({ text: 'Connected · 3 projects', dot: 'green', release: null });
    expect(footer('live', 1)).toEqual({ text: 'Connected · 1 project', dot: 'green', release: null });
    expect(footer('live', 12)).toEqual({ text: 'Connected · 12 projects', dot: 'green', release: null });
    expect(footer('connecting', 3)).toEqual({ text: 'Connecting…', dot: 'gray', release: null });
    expect(footer('down', 3)).toEqual({ text: 'Unreachable', dot: 'red', release: null });
    const statuses: readonly Status[] = ['live', 'connecting', 'down'];
    for (const status of statuses) for (const n of [0, 1, 3, 12]) expect(footer(status, n).text).not.toContain('andon-service');
  });

  test('the footer is one centered row whose text truncates instead of wrapping, beside a dot that never shrinks (041 AC3)', () => {
    const css = readFileSync(join(import.meta.dir, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (selector: string): string => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
      return m?.[1] ?? '';
    };
    const row = rule('.service');
    expect(row).toMatch(/display:\s*flex/);
    expect(row).toMatch(/align-items:\s*center/);
    const text = rule('.service .txt');
    for (const want of [/white-space:\s*nowrap/, /overflow:\s*hidden/, /text-overflow:\s*ellipsis/, /min-width:\s*0/]) expect(text).toMatch(want);
    expect(rule('.service .dot')).toMatch(/flex:\s*none/);
    const sidebar = readFileSync(join(import.meta.dir, 'Sidebar.svelte'), 'utf8');
    expect(sidebar).toContain('<span class="txt">{foot.text}</span>');
  });

  test('the footer\'s tooltip is its screen-reader announcement, from the one ANNOUNCE map (041 AC4)', () => {
    const sidebar = readFileSync(join(import.meta.dir, 'Sidebar.svelte'), 'utf8');
    expect(sidebar).toContain('<div class="service" title={ANNOUNCE[status]}>');
    expect(sidebar).toContain('<span class="sr-only" role="status">{ANNOUNCE[status]}</span>');
    expect(sidebar.match(/const ANNOUNCE\b/g)?.length).toBe(1);
  });

  test('the design doc\'s Footer bullet uses the one-line wording and names the service in the tooltip (041 AC6)', () => {
    const doc = readFileSync(join(import.meta.dir, '..', '..', '..', 'docs', 'design', 'andon-overview', 'design.md'), 'utf8');
    const bullet = /- \*\*Footer\*\*:[\s\S]*?(?=\n- |\n\n)/.exec(doc)?.[0] ?? '';
    expect(bullet).toContain('Connected · 12 projects');
    expect(bullet).not.toContain('andon-service');
    expect(bullet).toMatch(/tooltip/);
    expect(bullet).toContain('Connected to the Andon service');
  });

  test('the connection is announced, and shown with no projects, as the Andon service (029 AC4)', () => {
    const sidebar = readFileSync(join(import.meta.dir, 'Sidebar.svelte'), 'utf8');
    for (const want of ["connecting: 'Connecting to the Andon service'", "live: 'Connected to the Andon service'", "down: 'The Andon service is unreachable'"]) {
      expect({ want, found: sidebar.includes(want) }).toEqual({ want, found: true });
    }
    const app = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8');
    expect(app).toContain("The Andon service isn't answering.<br /><br />Install it once per machine with <code>factory service install</code>, or start it with <code>factory service start</code>.");
    expect(app).not.toContain('andon:service');
    expect(app).toContain('Connecting to the Andon service…');
    for (const text of [sidebar, app]) expect(text).not.toMatch(/andon[- ]agent/i);
  });

  test('the title is "Andon", or the selected project\'s name', () => {
    expect(title(state(), ALL)).toBe('Andon');
    expect(title(state(), MID.id)).toBe('mid');
    expect(title(state(), 'gone')).toBe('Andon');
  });

  test('the subtitle: "<scope> — N running, M waiting on you", with the waiting part omitted at zero', () => {
    const s = state();
    const board = buildBoard(boardJobs(s, ALL), NOW);
    const all = subtitle(s, ALL, board.running, board.waiting);
    expect(all).toEqual({ scope: 'All Projects', running: '6 running', waiting: '2 waiting on you', elsewhere: null });
    expect(subtitleText(all)).toBe('All Projects — 6 running, 2 waiting on you');
    const mid = subtitle(s, MID.id, 3, 0);
    expect(mid.waiting).toBeNull();
    expect(subtitleText(mid)).toBe('mid — 3 running, 2 waiting elsewhere');
  });

  test('a focused project shows "N waiting elsewhere" when other projects need a human (025 AC7)', () => {
    const s = state();
    expect(subtitle(s, MID.id, 3, 0).elsewhere).toBe('2 waiting elsewhere');
    expect(subtitle(s, ZED.id, 1, 2).elsewhere).toBeNull(); // its own needs-human jobs are "waiting on you"
    expect(subtitleText(subtitle(s, ZED.id, 1, 2))).toBe('zed — 1 running, 2 waiting on you');
    expect(subtitle(s, ALL, 6, 2).elsewhere).toBeNull();
    expect(subtitle(s, 'gone', 6, 2).elsewhere).toBeNull();
  });
});

describe('the status bar', () => {
  test('the legend names each state a card shows, in workflow order (034 AC1)', () => {
    expect(LEGEND.map((l) => l.key)).toEqual(['needs-human', 'claimed', 'spec', 'build', 'review', 'failed', 'approve', 'merged']);
    expect(LEGEND.map((l) => l.label)).toEqual(['Needs a human', 'Claimed', 'Spec', 'Building', 'In review', 'Review failed', 'At approver', 'Merged']);
  });

  test('"Settle after Nh" from the selection\'s settings', () => {
    const s = state();
    expect(settleText(settleHours(s, ALPHA.id))).toBe('Settle after 2h');
    expect(settleText(settleHours(s, ALL))).toBe('Settle after 2h / 24h');
    expect(settleText([])).toBe('Settle after 24h');
  });
});

describe('the shell mode (AC4)', () => {
  test('shell=mac is the Mac app; anything else is a browser', () => {
    expect(shellMode('?shell=mac')).toBe('mac');
    expect(shellMode('shell=mac')).toBe('mac');
    expect(shellMode('?x=1&shell=mac')).toBe('mac');
    for (const search of ['', '?', '?shell=', '?shell=MAC', '?shell=win', '?shellmac', '?x=shell=mac']) expect({ search, mode: shellMode(search) }).toEqual({ search, mode: 'browser' });
  });

  test('the Mac app: the 78px inset, drag regions, and a transparent sidebar', () => {
    expect(frame('mac', true)).toEqual({ inset: MAC_INSET, toolbarInset: 0, drag: true, transparentSidebar: true });
    expect(MAC_INSET).toBe(78);
    // with the sidebar hidden, the toolbar makes room for the traffic lights instead
    expect(frame('mac', false).toolbarInset).toBe(78);
  });

  test('a browser: no inset, no drag regions, and a solid sidebar', () => {
    expect(frame('browser', true)).toEqual({ inset: 0, toolbarInset: 0, drag: false, transparentSidebar: false });
    expect(frame('browser', false)).toEqual({ inset: 0, toolbarInset: 0, drag: false, transparentSidebar: false });
  });
});

describe("the Mac app's status bar event (032 AC5)", () => {
  /** A stand-in for the page's `window.tiny`: records subscriptions and delivers pushes. */
  function fakeHost(): { host: unknown; listeners: Map<string, (data: unknown) => void>; offs: string[] } {
    const listeners = new Map<string, (data: unknown) => void>();
    const offs: string[] = [];
    const host = {
      api: {
        on(event: string, fn: (data: unknown) => void): () => void {
          listeners.set(event, fn);
          return () => void offs.push(event);
        },
      },
    };
    return { host, listeners, offs };
  }

  test('the event is `statusbar`', () => {
    expect(STATUS_BAR_EVENT).toBe('statusbar');
  });

  test('in the Mac app the page subscribes through window.tiny.api.on, and can unsubscribe', () => {
    const { host, listeners, offs } = fakeHost();
    const subscribe = pushSubscriber('mac', host);
    expect(subscribe).not.toBeNull();
    const got: unknown[] = [];
    const off = subscribe?.(STATUS_BAR_EVENT, (d) => got.push(d));
    listeners.get('statusbar')?.({ hidden: true });
    expect(got).toEqual([{ hidden: true }]);
    off?.();
    expect(offs).toEqual(['statusbar']);
  });

  test('in a browser the page subscribes to nothing, even with a tiny global present', () => {
    expect(pushSubscriber('browser', fakeHost().host)).toBeNull();
    expect(pushSubscriber(shellMode(''), fakeHost().host)).toBeNull();
  });

  test('without a usable window.tiny the page subscribes to nothing', () => {
    for (const host of [undefined, null, 1, 'tiny', [], {}, { api: null }, { api: {} }, { api: { on: 'x' } }]) {
      expect({ host, sub: pushSubscriber('mac', host) }).toEqual({ host, sub: null });
    }
  });

  test('an unsubscribe that Tiny did not hand back is a no-op', () => {
    const off = pushSubscriber('mac', { api: { on: () => undefined } })?.('statusbar', () => undefined);
    expect(off).toBeFunction();
    expect(() => off?.()).not.toThrow();
  });

  test('hidden: true hides, hidden: false shows, and a malformed payload changes nothing', () => {
    expect(statusBarHidden({ hidden: true })).toBe(true);
    expect(statusBarHidden({ hidden: false })).toBe(false);
    for (const d of [undefined, null, true, 'hidden', [], {}, { hidden: 'true' }, { hidden: 1 }, { shown: true }]) {
      expect({ d, hidden: statusBarHidden(d) }).toEqual({ d, hidden: null });
    }
  });
});

describe('epics in the sidebar and the toolbar (056 AC5)', () => {
  const EPICS = { id: 'eeeeeeeeeeee', name: 'epics', root: '/r/epics' };
  const waiting = { slug: 'billing', state: 'waiting', waitingOn: 'you', note: 'checkout is on dev', members: [] };
  function withEpics(): UiState {
    let s = applyEvent(state(), 'projects', { projects: [ZED, ALPHA, MID, BETA, NEW, EPICS] });
    s = applyEvent(s, 'board', {
      project: EPICS.id,
      config: {},
      jobs: [
        { id: '010-a', stage: 'needs-human', epic: 'auth', kind: 'member' }, // an escalated member counts once, as any job
        { id: '011-b', stage: 'build', epic: 'auth', kind: 'member' },
        { id: '012-c', stage: 'review', epic: 'auth', kind: 'sync', round: 1, reviews: { code: 'pending' } },
        { id: '013-d', stage: 'merged', epic: 'auth', kind: 'member', endedAt: before(HOUR) },
      ],
      epics: [{ slug: 'auth', state: 'waiting', waitingOn: 'members', members: [] }, waiting],
    });
    return s;
  }

  test("a waiting epic adds one to its project's red badge and the All Projects badge; its jobs in working stages add to the gray count", () => {
    const s = withEpics();
    const row = sidebarModel(s, ALL).projects.find((p) => p.id === EPICS.id);
    expect([row?.state, row?.dot, row?.badge]).toEqual(['needs-human', 'red', { tone: 'red', count: 2, label: '2 need a human' }]);
    expect(sidebarModel(s, ALL).all.badge).toEqual({ tone: 'red', count: 4, label: '4 need a human' }); // zed's 2, the member, and the waiting epic
    expect(projectStatus(s.boards[EPICS.id]?.jobs.filter((j) => j.stage !== 'needs-human') ?? [], [])).toEqual({ state: 'active', badge: { tone: 'gray', count: 2, label: '2 active' } });
  });

  test('a project whose only activity is a waiting epic is needs-human, not idle', () => {
    expect(projectStatus([], [{ waitingOn: 'you' }])).toEqual({ state: 'needs-human', badge: { tone: 'red', count: 1, label: '1 needs a human' } });
    expect(projectStatus([], [{ waitingOn: 'members' }, { waitingOn: null }])).toEqual({ state: 'idle', badge: null });
  });

  test('the toolbar: the waiting epic adds to "M waiting on you", and to "K waiting elsewhere" from another project', () => {
    const s = withEpics();
    const board = buildBoard(boardJobs(s, EPICS.id), NOW);
    expect(board.waiting + hotEpics(s, EPICS.id)).toBe(2);
    expect(hotEpics(s, ALL)).toBe(1);
    expect(hotEpics(s, MID.id)).toBe(0);
    expect(subtitle(s, MID.id, 3, 0).elsewhere).toBe('4 waiting elsewhere');
    expect(subtitle(s, EPICS.id, board.running, board.waiting + hotEpics(s, EPICS.id))).toMatchObject({ waiting: '2 waiting on you', elsewhere: '2 waiting elsewhere' });
    const app = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8');
    expect(app).toContain('subtitle(ui, sel, board.running, board.waiting + hotEpics(ui, sel))');
  });
});

// ---- factory releases (059) ----

describe('sidebar rows by release state (059 AC1)', () => {
  const BEHIND = { ...MID, release: projectRelease('0.1.0', 'behind') };
  const CURRENT = { ...ALPHA, release: projectRelease('0.2.0', 'current') };
  const AHEAD = { ...BETA, release: projectRelease('0.3.0', 'ahead') };
  const UNKNOWN = { ...NEW, release: projectRelease(null, 'unknown') };
  const OLD = ZED; // an older service: no release

  function releases(withRelease = true): UiState {
    let s = state();
    s = applyEvent(s, 'projects', { projects: [OLD, CURRENT, BEHIND, AHEAD, UNKNOWN] });
    return withRelease ? applyEvent(s, 'release', releaseBody('0.2.0')) : s;
  }
  const row = (s: UiState, id: string) => sidebarModel(s, ALL).projects.find((p) => p.id === id);

  test('behind: a glyph after the name, whose hover text and accessible name name both releases', () => {
    const r = row(releases(), MID.id);
    expect(r?.release).toEqual({ state: 'behind', line: 'factory 0.1.0 installed · 0.2.0 available', glyph: { label: 'factory 0.1.0 installed · 0.2.0 available' } });
    expect(r?.title).toBe('/r/mid\nfactory 0.1.0 installed · 0.2.0 available');
  });

  test("behind before the service's running release is known: a newer release available", () => {
    const r = row(releases(false), MID.id);
    expect(r?.release?.glyph).toEqual({ label: 'factory 0.1.0 installed · a newer release available' });
  });

  test('current, ahead, and unknown: no glyph, each with its own hover line', () => {
    const s = releases();
    expect(row(s, ALPHA.id)?.release).toEqual({ state: 'current', line: 'factory 0.2.0 installed · up to date', glyph: null });
    expect(row(s, BETA.id)?.release).toEqual({ state: 'ahead', line: "factory 0.3.0 installed · newer than this machine's 0.2.0", glyph: null });
    expect(row(s, NEW.id)?.release).toEqual({ state: 'unknown', line: 'factory version unknown', glyph: null });
    expect(row(s, ALPHA.id)?.title).toBe('/r/alpha\nfactory 0.2.0 installed · up to date');
    expect(row(s, NEW.id)?.title).toBe('/r/new\nfactory version unknown');
  });

  test('unchanged: the dot, the badge, and the rest of the row are as without a release', () => {
    const withRel = sidebarModel(releases(), ALL).projects;
    const without = sidebarModel(applyEvent(releases(), 'projects', { projects: [OLD, ALPHA, MID, BETA, NEW] }), ALL).projects;
    expect(withRel.map(({ release, title, ...rest }) => rest)).toEqual(without.map(({ release, title, ...rest }) => rest));
    expect(row(releases(), ZED.id)?.badge).toEqual({ tone: 'red', count: 2, label: '2 need a human' });
  });

  test('the glyph is its own button beside the row button, never nested, never the red badge, and the release line describes the row', () => {
    const sidebar = readFileSync(join(import.meta.dir, 'Sidebar.svelte'), 'utf8');
    const li = /<li class="sbrow"[\s\S]*?<\/li>/.exec(sidebar)?.[0] ?? '';
    const rowButton = /<button\s+class="sbi"[\s\S]*?<\/button>/.exec(li)?.[0] ?? '';
    expect(rowButton).not.toBe('');
    expect(rowButton).not.toContain('relglyph');
    expect(rowButton.match(/<button/g)?.length).toBe(1);
    const after = li.slice(li.indexOf(rowButton) + rowButton.length);
    expect(after).toContain('<button class="relglyph" type="button" title={p.release.glyph.label} aria-label={p.release.glyph.label}');
    expect(after).not.toContain('badge');
    // The row's accessible name is unchanged; its release line is its description.
    expect(rowButton).toContain('aria-label={label(p.name, STATE_LABELS[p.state], p.badge)}');
    expect(rowButton).toContain('aria-describedby={p.release !== null ? `rel-${p.id}` : undefined}');
    expect(rowButton).toContain('<span class="sr-only" id="rel-{p.id}">{p.release.line}</span>');
  });

  test('the glyph is muted in both appearances: label tokens, never the red badge fill or a red', () => {
    const css = readFileSync(join(import.meta.dir, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/(^|\n)(\.relglyph[^{]*)\{([^}]*)\}/g)].map((m) => m[3] ?? '');
    expect(rules.length).toBeGreaterThan(0);
    for (const body of rules) {
      expect(body).not.toMatch(/--badge-red|--red\b|--red-ink|#fff\b/);
      for (const c of body.matchAll(/(?:^|[;\s])color:\s*([^;]+)/g)) expect(c[1]?.trim()).toMatch(/^var\(--label[23]\)$/);
    }
  });
});

describe('the footer release (059 AC2)', () => {
  test('live with release data: "Connected · N projects · v0.2.0", the version opening What\'s New', () => {
    const info = applyEvent(emptyState(), 'release', releaseBody('0.2.0')).release.info;
    const f = footer('live', 3, info);
    expect(f.text).toBe('Connected · 3 projects');
    expect(f.release).toEqual({ kind: 'version', text: 'v0.2.0', title: "What's new in v0.2.0" });
    expect(footerLine(f)).toBe('Connected · 3 projects · v0.2.0');
  });

  test('onDisk differs from running: the version becomes the restart note, which copies the restart command', () => {
    const info = applyEvent(emptyState(), 'release', releaseBody('0.2.0', '0.3.0')).release.info;
    const r = footer('live', 3, info).release;
    expect(r?.kind).toBe('restart');
    if (r?.kind !== 'restart') throw new Error('no restart note');
    expect(r.text).toBe('Restart service');
    expect(r.command).toBe('factory service restart');
    for (const part of ['v0.2.0', 'v0.3.0', 'factory service restart']) expect(r.title).toContain(part);
    expect(footerLine(footer('live', 1, info))).toBe('Connected · 1 project · Restart service');
  });

  test('onDisk null, or equal to running: no note', () => {
    expect(footerRelease({ running: '0.2.0', onDisk: null, changelog: [] })).toEqual({ kind: 'version', text: 'v0.2.0', title: "What's new in v0.2.0" });
    expect(footerRelease({ running: '0.2.0', onDisk: '0.2.0', changelog: [] })?.kind).toBe('version');
    expect(footerRelease({ running: null, onDisk: '0.2.0', changelog: [] })?.kind).toBe('restart');
    expect(footerRelease({ running: null, onDisk: null, changelog: [] })).toBeNull();
  });

  test('only while live', () => {
    const info = applyEvent(emptyState(), 'release', releaseBody('0.2.0')).release.info;
    expect(footer('connecting', 3, info)).toEqual({ text: 'Connecting…', dot: 'gray', release: null });
    expect(footer('down', 3, info)).toEqual({ text: 'Unreachable', dot: 'red', release: null });
  });

  test('one line: the version and the note never shrink or wrap, while the connection text truncates (design §3)', () => {
    const css = readFileSync(join(import.meta.dir, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (selector: string): string => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
    };
    const ver = rule('.service .ver');
    expect(ver).toMatch(/flex:\s*none/);
    expect(ver).toMatch(/white-space:\s*nowrap/);
    expect(rule('.service .sep')).toMatch(/flex:\s*none/);
    const sidebar = readFileSync(join(import.meta.dir, 'Sidebar.svelte'), 'utf8');
    expect(sidebar).toContain('onclick={() => onwhatsnew(null)}>{rel.text}</button>');
    expect(sidebar).toContain('onclick={() => oncopy(rel.command)}');
  });
});

describe('an older service (059 AC7)', () => {
  test('no release on project entries, no release event: no glyph, no hover line, the footer as before', () => {
    const s = state();
    for (const r of sidebarModel(s, ALL).projects) {
      expect(r.release).toBeNull();
      expect(r.title).toBe(s.projects.find((p) => p.id === r.id)?.root ?? '');
    }
    expect(s.release.info).toBeNull();
    expect(footer('live', 5, s.release.info)).toEqual({ text: 'Connected · 5 projects', dot: 'green', release: null });
    expect(footerLine(footer('live', 5, s.release.info))).toBe('Connected · 5 projects');
  });

  test('malformed release values count as missing, and nothing throws', () => {
    let s = applyEvent(emptyState(), 'projects', {
      projects: [
        { ...MID, release: 'behind' },
        { ...ALPHA, release: { installed: 1, state: 'behind' } },
        { ...BETA, release: { installed: '0.1.0', state: 'stale' } },
        { ...NEW, release: null },
      ],
    });
    for (const bad of [null, 'x', 3, {}, { running: 1 }, { running: '0.2.0', onDisk: '0.2.0', changelog: 'none' }]) s = applyEvent(s, 'release', bad);
    expect(s.release.info).toBeNull();
    for (const r of sidebarModel(s, ALL).projects) expect([r.id, r.release]).toEqual([r.id, null]);
    expect(footer('live', 4, s.release.info).release).toBeNull();
  });
});

describe("the Mac app's What's New event (059 AC8)", () => {
  test('the page subscribes to whatsnew through pushSubscriber and opens the whole sheet', () => {
    expect(WHATS_NEW_EVENT).toBe('whatsnew');
    const heard: string[] = [];
    const host = { api: { on: (event: string, fn: (data: unknown) => void) => { heard.push(event); fn({}); return () => undefined; } } };
    const sub = pushSubscriber('mac', host);
    let opened = 0;
    sub?.(WHATS_NEW_EVENT, () => opened++);
    expect(heard).toEqual(['whatsnew']);
    expect(opened).toBe(1);
    expect(pushSubscriber('browser', host)).toBeNull();
    const app = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8');
    expect(app).toContain("subscribe?.(WHATS_NEW_EVENT, () => openWhatsNew(null));");
  });
});

describe("063: the Mac app's View menu events", () => {
  test('AC4: the event names, and each page event maps to its action; anything else does nothing', () => {
    expect([MERGED_EVENT, NEEDS_ME_EVENT, SETTLED_EVENT, SIDEBAR_EVENT, INSPECTOR_EVENT]).toEqual(['merged', 'needsme', 'settled', 'sidebar', 'inspector']);
    // 067 AC7: Show Backlog…'s `backlog` event, right after Settled's
    expect(BACKLOG_EVENT).toBe('backlog');
    expect(PUSHED_EVENTS).toEqual(['statusbar', 'whatsnew', 'merged', 'needsme', 'settled', 'backlog', 'sidebar', 'inspector', 'startwork']); // 075: startwork
    expect(MENU_EVENTS).toEqual(['needsme', 'settled', 'backlog', 'sidebar', 'inspector']);
    expect(MENU_EVENTS.map(menuEventAction)).toEqual(['toggle-needs', 'open-settled', 'open-backlog', 'toggle-sidebar', 'toggle-inspector']);
    for (const e of ['statusbar', 'whatsnew', 'merged', 'NEEDSME', 'needs-me', '', 'settle', 'Backlog', 'backlogs']) expect({ e, a: menuEventAction(e) }).toEqual({ e, a: null });
  });

  test('AC3: the Merged event: hidden true hides, false shows, a malformed payload changes nothing', () => {
    expect(mergedHidden({ hidden: true })).toBe(true);
    expect(mergedHidden({ hidden: false })).toBe(false);
    for (const d of [undefined, null, true, {}, { hidden: 'true' }, { hidden: 1 }, { shown: true }]) expect({ d, h: mergedHidden(d) }).toEqual({ d, h: null });
  });

  test('AC4: App.svelte subscribes to each page event and acts on it', () => {
    const app = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8');
    for (const name of ['NEEDS_ME_EVENT', 'SETTLED_EVENT', 'BACKLOG_EVENT', 'SIDEBAR_EVENT', 'INSPECTOR_EVENT']) expect(app).toContain(`subscribe?.(${name}, () => onmenu(${name}));`);
    expect(app).toMatch(/case 'toggle-needs':\s*needs = !needs;/);
    expect(app).toMatch(/case 'open-settled':\s*openSettled\(null\);/);
    expect(app).toMatch(/case 'open-backlog':\s*openBacklog\(null\);/); // 067 AC7
    expect(app).toMatch(/case 'toggle-sidebar':\s*toggleSide\(\);/);
    expect(app).toMatch(/case 'toggle-inspector':\s*toggleInspector\(\);/);
    expect(app).toContain('if (hidden !== null) mergedOff = hidden;');
    expect(app).toContain('buildLanes(shownProjects, jobs, now, focused, summaries, epics, needs, mergedOff, backlogCounts)');
    expect(app).toContain('headerOf(lines.lanes, settleHours(ui, sel), mergedOff)');
  });
});

describe('063 AC5/AC7: the view-state report', () => {
  const host = (calls: unknown[][], answer: () => unknown = async () => null) => ({
    api: {
      call: (method: string, params: unknown) => {
        calls.push([method, params]);
        return answer();
      },
    },
  });

  test('the main window reports the three booleans by the one fixed method, only when they change', () => {
    expect(VIEW_STATE_METHOD).toBe('setViewState');
    const calls: unknown[][] = [];
    const report = viewStateCaller('mac', host(calls));
    if (report === null) throw new Error('no reporter');
    report({ needsMe: false, sidebarShown: true, inspectorOpen: false });
    report({ needsMe: false, sidebarShown: true, inspectorOpen: false }); // unchanged: not sent again
    report({ needsMe: true, sidebarShown: true, inspectorOpen: false }); // n
    report({ needsMe: true, sidebarShown: false, inspectorOpen: true }); // the inspector opened in a narrow window
    expect(calls).toEqual([
      ['setViewState', { needsMe: false, sidebarShown: true, inspectorOpen: false }],
      ['setViewState', { needsMe: true, sidebarShown: true, inspectorOpen: false }],
      ['setViewState', { needsMe: true, sidebarShown: false, inspectorOpen: true }],
    ]);
  });

  test('it sends only the three booleans, even from a wider object', () => {
    const calls: unknown[][] = [];
    const wide = { needsMe: true, sidebarShown: true, inspectorOpen: true, extra: 'x' };
    viewStateCaller('mac', host(calls))?.(wide);
    expect(calls).toEqual([['setViewState', { needsMe: true, sidebarShown: true, inspectorOpen: true }]]);
  });

  test('a call that throws or rejects is ignored', async () => {
    const calls: unknown[][] = [];
    const throwing = viewStateCaller('mac', host(calls, () => { throw new Error('gone'); }));
    expect(() => throwing?.({ needsMe: true, sidebarShown: true, inspectorOpen: false })).not.toThrow();
    const rejecting = viewStateCaller('mac', host(calls, () => Promise.reject(new Error('denied'))));
    expect(() => rejecting?.({ needsMe: true, sidebarShown: true, inspectorOpen: false })).not.toThrow();
    await new Promise((r) => setTimeout(r, 1));
    expect(calls).toHaveLength(2);
  });

  test('AC7: in a browser, or without a usable window.tiny, nothing reports', () => {
    expect(viewStateCaller('browser', host([]))).toBeNull();
    expect(viewStateCaller(shellMode(''), host([]))).toBeNull();
    for (const h of [undefined, null, {}, { api: null }, { api: {} }, { api: { call: 'x' } }]) expect({ h, r: viewStateCaller('mac', h) }).toEqual({ h, r: null });
  });

  test('App.svelte reports on every change of Needs Me, the effective sidebar, and the inspector', () => {
    const app = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8');
    expect(app).toContain("const reportView = viewStateCaller(mode, Reflect.get(window, 'tiny'));");
    expect(app).toMatch(/\$effect\(\(\) => \{\s*reportView\?\.\(\{ needsMe: needs, sidebarShown: sidebarOpen, inspectorOpen \}\);\s*\}\);/);
    expect(app).toContain('const sidebarOpen = $derived(sidebarShown(sidebar, innerWidth, inspectorOpen));');
  });
});

// ---- machines (brief andon-machines-ui) ----

const iso = (t: number): string => new Date(t).toISOString();
const LATER = localAt(16, 30); // "now": the same local day as 14:02

/** The three-machine fleet: studio has a needs-human job, rocinante's factory an active one; peers listed studio before agentbox. */
function machines(studio: Record<string, unknown> = machineEntry('studio'), agentbox: Record<string, unknown> = machineEntry('agentbox'), extra: Array<Record<string, unknown>> = []): UiState {
  let s = applyEvent(emptyState(), 'projects', { projects: MACHINE_PROJECTS });
  s = applyEvent(s, 'board', { project: STUDIO_FACTORY.id, config: {}, jobs: [{ id: '007-x', stage: 'needs-human', updated: before(HOUR) }] });
  s = applyEvent(s, 'board', { project: LOCAL_FACTORY.id, config: {}, jobs: [{ id: '001-a', stage: 'build', updated: before(HOUR) }] });
  return applyEvent(s, 'machines', machinesBody(machineEntry(HUB), studio, agentbox, ...extra));
}

describe('no peers: the board as today (machines AC1)', () => {
  test('no machines data, or only the hub listed: no headings, and the footer reads "Connected · N projects"', () => {
    const none = applyEvent(emptyState(), 'projects', { projects: MACHINE_PROJECTS.filter((p) => p.machine === HUB) });
    const alone = applyEvent(none, 'machines', machinesBody(machineEntry(HUB)));
    for (const s of [none, alone]) {
      expect(sidebarModel(s, ALL, LATER).machines).toEqual([]);
      expect(sidebarModel(s, ALL, LATER).projects.map((p) => p.name)).toEqual(['factory', 'notes']);
      expect(footerLine(footer('live', s.projects.length, null, s.machines.list))).toBe('Connected · 2 projects');
      expect(footerLine(footer('live', 2, { running: '0.2.0', onDisk: null, changelog: [] }, s.machines.list))).toBe('Connected · 2 projects · v0.2.0');
      expect(title(s, LOCAL_FACTORY.id)).toBe('factory');
    }
  });
});

describe('machine headings in the sidebar (machines AC3)', () => {
  test('Overview, then a heading per machine: the hub first, then the peers by name, each with its projects by name', () => {
    const m = sidebarModel(machines(), ALL, LATER);
    expect(m.all.selected).toBe(true);
    expect(m.machines.map((h) => [h.name, h.projects.map((p) => p.name)])).toEqual([
      [HUB, ['factory', 'notes']],
      ['agentbox', ['lab']],
      ['studio', ['api', 'factory']],
    ]);
    // the rows under a heading keep the bare name
    expect(m.machines[2]?.projects.find((p) => p.id === STUDIO_FACTORY.id)?.name).toBe('factory');
  });

  test("each heading's state text: nothing when live, gray connecting…, red down since, needs upgrade, or error", () => {
    const down = iso(localAt(14, 2));
    const cases: Array<[Record<string, unknown>, { text: string; tone: 'red' | 'gray' } | null]> = [
      [machineEntry('studio'), null],
      [machineEntry('studio', 'connecting', down), { text: 'connecting…', tone: 'gray' }],
      [machineEntry('studio', 'down', down), { text: 'down since 14:02', tone: 'red' }],
      [machineEntry('studio', 'down', iso(localAt(14, 2, 21))), { text: 'down since Oct 21 14:02', tone: 'red' }],
      [machineEntry('studio', 'error', down, { reason: 'from before peers: run factory upgrade and factory service restart on studio' }), { text: 'needs upgrade', tone: 'red' }],
      [machineEntry('studio', 'error', down, { reason: 'reports the same name as rocinante' }), { text: 'error', tone: 'red' }],
      [machineEntry('studio', 'error', down, { reason: 'not an Andon service' }), { text: 'error', tone: 'red' }],
    ];
    for (const [entry, want] of cases) expect({ entry, status: sidebarModel(machines(entry), ALL, LATER).machines.find((h) => h.name === 'studio')?.status }).toEqual({ entry, status: want });
    expect(sidebarModel(machines(), ALL, LATER).machines[0]?.status).toBeNull(); // the hub is always live
  });

  test("a heading's tooltip and description carry its reason and its release, when known", () => {
    const m = sidebarModel(machines(machineEntry('studio', 'down', iso(localAt(14, 2)), { reason: 'studio: unreachable', release: '0.2.0' }), machineEntry('agentbox', 'live', iso(localAt(9, 0)), { release: null })), ALL, LATER);
    expect(m.machines.find((h) => h.name === 'studio')?.detail).toBe('studio: unreachable\nfactory 0.2.0');
    expect(m.machines.find((h) => h.name === 'agentbox')?.detail).toBeNull();
    expect(m.machines[0]?.detail).toBe('factory 0.2.0');
  });

  test('a machine with no projects still shows its heading, with no rows', () => {
    const m = sidebarModel(machines(undefined, undefined, [machineEntry('spare', 'down', iso(localAt(8, 15)))]), ALL, LATER);
    expect(m.machines.map((h) => h.name)).toEqual([HUB, 'agentbox', 'spare', 'studio']);
    expect(m.machines.find((h) => h.name === 'spare')).toMatchObject({ projects: [], status: { text: 'down since 08:15', tone: 'red' } });
  });

  test("headings aren't selectable, and the sidebar's keyboard order skips them", () => {
    const m = sidebarModel(machines(), ALL, LATER);
    expect(sidebarStops(m, ALL)).toEqual([ALL, LOCAL_FACTORY.id, LOCAL_NOTES.id, AGENT_LAB.id, STUDIO_API.id, STUDIO_FACTORY.id]);
    for (const h of m.machines) expect(sidebarStops(m, ALL)).not.toContain(h.name);
    const sidebar = readFileSync(join(import.meta.dir, 'Sidebar.svelte'), 'utf8');
    expect(sidebar).toMatch(/<h3 class="mhead"[^>]*>/);
    expect(sidebar).not.toMatch(/<h3 class="mhead"[^>]*(onclick|tabindex)/);
  });

  test("All Projects' badge, the toolbar's counts, and Needs Me cover every machine", () => {
    const s = machines();
    expect(sidebarModel(s, ALL, LATER).all.badge).toEqual({ tone: 'red', count: 1, label: '1 needs a human' });
    expect(needsHuman(s).total).toBe(1);
    const board = buildBoard(boardJobs(s, ALL), NOW, []);
    expect([board.running, board.waiting]).toEqual([1, 1]);
    expect(subtitleText(subtitle(s, ALL, board.running, board.waiting))).toBe('All Projects — 1 running, 1 waiting on you');
    expect(needsFilter(s.projects, boardJobs(s, ALL)).projects.map((p) => p.id)).toEqual([STUDIO_FACTORY.id]);
  });

  test("a focused remote project's title and subtitle name its machine", () => {
    const s = machines();
    expect(title(s, STUDIO_FACTORY.id)).toBe('factory · studio');
    expect(title(s, LOCAL_FACTORY.id)).toBe('factory');
    expect(subtitle(s, STUDIO_FACTORY.id, 0, 1).scope).toBe('factory · studio');
  });
});

describe("the footer's machine count and trouble (machines AC6)", () => {
  const twelve = (studio: Record<string, unknown>, agentbox: Record<string, unknown> = machineEntry('agentbox')): UiState => {
    const projects = [...Array.from({ length: 5 }, (_, i) => machineProject(`a${i}a${i}a${i}a${i}a${i}a${i}`, `p${i}`, HUB)), ...Array.from({ length: 4 }, (_, i) => machineProject(`b${i}b${i}b${i}b${i}b${i}b${i}`, `s${i}`, 'studio')), ...Array.from({ length: 3 }, (_, i) => machineProject(`c${i}c${i}c${i}c${i}c${i}c${i}`, `g${i}`, 'agentbox'))];
    return applyEvent(applyEvent(emptyState(), 'projects', { projects }), 'machines', machinesBody(machineEntry(HUB), studio, agentbox));
  };
  const line = (s: UiState, release: Parameters<typeof footer>[2] = null): string => footerLine(footer('live', s.projects.length, release, s.machines.list));

  test('three machines, twelve projects, studio down: "Connected · 3 machines · 12 projects · studio down", the release part after', () => {
    const s = twelve(machineEntry('studio', 'down', iso(localAt(14, 2))));
    expect(s.projects).toHaveLength(12);
    expect(line(s)).toBe('Connected · 3 machines · 12 projects · studio down');
    expect(line(s, { running: '0.2.0', onDisk: null, changelog: [] })).toBe('Connected · 3 machines · 12 projects · studio down · v0.2.0');
  });

  test('an error machine adds "<name> needs upgrade" or "<name> error", in sidebar order; all live reads only the counts', () => {
    const upgrade = machineEntry('agentbox', 'error', iso(localAt(9, 0)), { reason: 'run factory upgrade and factory service restart on agentbox' });
    expect(line(twelve(machineEntry('studio', 'down', iso(localAt(14, 2))), upgrade))).toBe('Connected · 3 machines · 12 projects · agentbox needs upgrade · studio down');
    expect(line(twelve(machineEntry('studio', 'error', iso(localAt(9, 0)), { reason: 'a name clash' })))).toBe('Connected · 3 machines · 12 projects · studio error');
    expect(line(twelve(machineEntry('studio', 'connecting', iso(localAt(9, 0)))))).toBe('Connected · 3 machines · 12 projects');
    expect(line(twelve(machineEntry('studio')))).toBe('Connected · 3 machines · 12 projects');
    expect(footer('down', 12, null, twelve(machineEntry('studio')).machines.list)).toEqual({ text: 'Unreachable', dot: 'red', release: null });
  });
});
