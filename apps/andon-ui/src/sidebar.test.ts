import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBoard } from './board';
import { HOUR, NOW, before, job, tag } from './fixtures';
import { kindOf } from './lanes';
import { ALL, SELECTION_KEY, boardJobs, loadSelection, resolveSelection, saveSelection } from './projects';
import { LEGEND, MAC_INSET, STATUS_BAR_EVENT, footer, frame, isActive, projectStatus, pushSubscriber, reviewFailed, settleHours, settleText, shellMode, sidebarModel, statusBarHidden, subtitle, subtitleText, title } from './sidebar';
import { applyEvent, emptyState } from './state';
import type { UiState } from './state';

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
    expect(footer('live', 12)).toEqual({ text: 'Connected · andon-service · 12 projects', dot: 'green' });
    expect(footer('live', 1)).toEqual({ text: 'Connected · andon-service · 1 project', dot: 'green' });
    expect(footer('connecting', 3)).toEqual({ text: 'Connecting…', dot: 'gray' });
    expect(footer('down', 3)).toEqual({ text: 'Unreachable', dot: 'red' });
  });

  test('the connection is announced, and shown with no projects, as the Andon service (029 AC4)', () => {
    const sidebar = readFileSync(join(import.meta.dir, 'Sidebar.svelte'), 'utf8');
    for (const want of ["connecting: 'Connecting to the Andon service'", "live: 'Connected to the Andon service'", "down: 'The Andon service is unreachable'"]) {
      expect({ want, found: sidebar.includes(want) }).toEqual({ want, found: true });
    }
    const app = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8');
    expect(app).toContain("The Andon service isn't answering.<br /><br />Start it from the factory repo: <code>bun run andon:service</code>");
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
  test('the legend names each state a card shows', () => {
    expect(LEGEND.map((l) => l.key)).toEqual(['needs-human', 'failed', 'review', 'approve', 'build', 'spec', 'claimed', 'merged']);
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
