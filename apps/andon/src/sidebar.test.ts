import { describe, expect, test } from 'bun:test';
import { buildBoard } from './board';
import { HOUR, NOW, before, job } from './fixtures';
import { ALL, SELECTION_KEY, boardJobs, loadSelection, resolveSelection, saveSelection } from './projects';
import { LEGEND, MAC_INSET, footer, frame, isActive, projectStatus, reviewFailed, settleHours, settleText, shellMode, sidebarModel, subtitle, subtitleText, title } from './sidebar';
import { applyEvent, emptyState } from './state';
import type { UiState } from './state';

// Registered out of name order, so the sidebar's sort shows.
const ZED = { id: 'zzzzzzzzzzzz', name: 'zed', root: '/r/zed' }; // two needs-human, one active
const ALPHA = { id: 'aaaaaaaaaaaa', name: 'Alpha', root: '/r/alpha' }; // review failed, back in build
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
      { id: '003-c', stage: 'build', round: 1, reviews: { code: 'CHANGES' }, updated: before(HOUR) }, // failed, but red wins
      { id: '004-d', stage: 'merged', endedAt: before(HOUR), updated: before(HOUR) },
    ],
  });
  s = applyEvent(s, 'board', {
    project: ALPHA.id,
    config: { reviewers: ['code', 'ui'], dashboard: { settleAfterHours: 2 } },
    jobs: [
      { id: '001-a', stage: 'build', round: 1, reviews: { code: 'PASS', ui: 'CHANGES' }, updated: before(HOUR) },
      { id: '002-b', stage: 'review', round: 1, reviews: { code: 'pending' }, updated: before(HOUR) },
    ],
  });
  s = applyEvent(s, 'board', {
    project: MID.id,
    config: {},
    jobs: [
      { id: '001-a', stage: 'claimed', updated: before(HOUR) },
      { id: '002-b', stage: 'build', round: 2, reviews: { code: 'PASS' }, updated: before(HOUR) }, // human-approved rework: not failed
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

  test('review failed: back in build after a round with a non-PASS verdict', () => {
    expect(reviewFailed(job({ id: '1', stage: 'build', round: 1, reviews: { code: 'CHANGES' } }))).toBe(true);
    expect(reviewFailed(job({ id: '1', stage: 'build', round: 2, reviews: { code: 'PASS', ui: 'PASS' } }))).toBe(false);
    expect(reviewFailed(job({ id: '1', stage: 'build', round: 0 }))).toBe(false); // the first build
    expect(reviewFailed(job({ id: '1', stage: 'review', round: 1, reviews: { code: 'CHANGES' } }))).toBe(false); // still in review
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
    expect(footer('live', 12)).toEqual({ text: 'Connected · andon-agent · 12 projects', dot: 'green' });
    expect(footer('live', 1)).toEqual({ text: 'Connected · andon-agent · 1 project', dot: 'green' });
    expect(footer('connecting', 3)).toEqual({ text: 'Connecting…', dot: 'gray' });
    expect(footer('down', 3)).toEqual({ text: 'Unreachable', dot: 'red' });
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
    expect(all).toEqual({ scope: 'All Projects', running: '6 running', waiting: '2 waiting on you' });
    expect(subtitleText(all)).toBe('All Projects — 6 running, 2 waiting on you');
    const mid = subtitle(s, MID.id, 3, 0);
    expect(mid.waiting).toBeNull();
    expect(subtitleText(mid)).toBe('mid — 3 running');
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
  test('shell=mac is the Mac shell; anything else is a browser', () => {
    expect(shellMode('?shell=mac')).toBe('mac');
    expect(shellMode('shell=mac')).toBe('mac');
    expect(shellMode('?x=1&shell=mac')).toBe('mac');
    for (const search of ['', '?', '?shell=', '?shell=MAC', '?shell=win', '?shellmac', '?x=shell=mac']) expect({ search, mode: shellMode(search) }).toEqual({ search, mode: 'browser' });
  });

  test('the Mac shell: the 78px inset, drag regions, and a transparent sidebar', () => {
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
