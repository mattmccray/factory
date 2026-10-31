import { describe, expect, test } from 'bun:test';
import {
  BACKLOG_EVENT,
  BACKLOG_ID,
  BACKLOG_LABEL,
  DEFAULT_VIEW,
  GITHUB_ID,
  INSPECTOR_EVENT,
  INSPECTOR_ID,
  MERGED_EVENT,
  MERGED_ID,
  MERGED_KEY,
  NEEDS_ME_EVENT,
  NEEDS_ME_ID,
  SETTLED_EVENT,
  SETTLED_ID,
  SIDEBAR_EVENT,
  SIDEBAR_ID,
  GITHUB_URL,
  MINIMIZE_ID,
  SETTINGS_ID,
  SETTINGS_SIZE,
  SETTINGS_TITLE,
  SETTINGS_WINDOW_ID,
  SHOW_MAIN_ID,
  STATUS_BAR_EVENT,
  STATUS_BAR_ID,
  WHATS_NEW_EVENT,
  WHATS_NEW_ID,
  ZOOM_ID,
  appMenu,
  menuAction,
  mergedPayload,
  pageEventPayload,
  settingsUrl,
  settingsWindow,
  ABOUT_ID,
  CLOSE_WINDOW_ID,
  NEW_EXPLORATION_ID,
  START_WORK_EVENT,
  startWorkPayload,
  closeWindowStep,
  fileMenu,
  ABOUT_QUERY,
  ABOUT_SIZE,
  ABOUT_TITLE,
  ABOUT_WINDOW_ID,
  aboutUrl,
  aboutWindow,
  statusBarLabel,
  statusBarPayload,
  storedHidden,
  viewLabelUpdates,
  whatsNewPayload,
  childPosition,
  mainFrames,
  parseSize,
  placeOnMain,
} from './appmenu';
import type { Menu, MenuItem, MenuState, StartWorkPush, ViewState } from './appmenu';

/** A menu state: the defaults (everything shown, Needs Me off, no inspector), with `over` on top. */
const ms = (over: Partial<Omit<MenuState, 'view'>> = {}, view: Partial<ViewState> = {}): MenuState => ({ statusBarHidden: false, mergedHidden: false, ...over, view: { ...DEFAULT_VIEW, ...view } });

/** The View menu's items, for its labels. */
const viewItems = (needs: string, sidebar: string, inspector: string, bar: string, merged: string): MenuItem[] => [
  { id: NEEDS_ME_ID, label: needs, key: 'N' },
  { id: SETTLED_ID, label: 'Show Settled…', key: 'S' },
  { id: BACKLOG_ID, label: 'Show Backlog…', key: 'B' }, // 067 AC7: right after Show Settled…
  { separator: true },
  { id: SIDEBAR_ID, label: sidebar, key: 'ctrl+s' },
  { id: INSPECTOR_ID, label: inspector, key: 'alt+i' },
  { separator: true },
  { id: STATUS_BAR_ID, label: bar, key: '/' },
  { id: MERGED_ID, label: merged },
];

const expected = (toggle: string): Menu[] => [
  { role: 'app', items: [{ id: SETTINGS_ID, label: 'Settings…', key: ',', enabled: true }] },
  {
    title: 'File',
    items: [
      { id: NEW_EXPLORATION_ID, label: 'New Exploration…', key: 'n' }, // 075 AC1
      { id: CLOSE_WINDOW_ID, label: 'Close Window', key: 'w' }, // 073 AC3
    ],
  },
  { role: 'edit' },
  { title: 'View', items: viewItems('Show Only Needs Me', 'Hide Sidebar', 'Show Inspector', toggle, 'Hide Merged Column') },
  {
    title: 'Window',
    items: [{ id: MINIMIZE_ID, label: 'Minimize', key: 'm' }, { id: ZOOM_ID, label: 'Zoom' }, { separator: true }, { id: SHOW_MAIN_ID, label: 'Andon', key: '0' }],
  },
  { title: 'Help', role: 'help', items: [{ id: WHATS_NEW_ID, label: "What's New" }, { id: GITHUB_ID, label: 'Factory on GitHub' }] },
];

describe('AC1: the menu spec', () => {
  test('shown: the bar is Andon, File, Edit, View (Hide Status Bar), Window, Help, exactly', () => {
    expect(appMenu(ms())).toEqual(expected('Hide Status Bar'));
  });

  test('hidden: the same bar, with the toggle reading Show Status Bar', () => {
    expect(appMenu(ms({ statusBarHidden: true }))).toEqual(expected('Show Status Bar'));
    expect(statusBarLabel(true)).toBe('Show Status Bar');
    expect(statusBarLabel(false)).toBe('Hide Status Bar');
  });

  test('every clickable item has a unique id', () => {
    const items = appMenu(ms()).flatMap((m) => m.items ?? []).filter((i) => i.separator !== true);
    const ids = items.map((i) => i.id);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(15); // 067: Show Backlog…; 073: Close Window; 075: New Exploration…
  });
});

describe('AC2: clicks and the stored value', () => {
  test('each id maps to its action; unknown ids do nothing', () => {
    expect(menuAction(SETTINGS_ID)).toEqual({ kind: 'open-settings' });
    expect(menuAction(STATUS_BAR_ID)).toEqual({ kind: 'toggle-status-bar' });
    expect(menuAction(MINIMIZE_ID)).toEqual({ kind: 'minimize' });
    expect(menuAction(ZOOM_ID)).toEqual({ kind: 'zoom' });
    expect(menuAction(SHOW_MAIN_ID)).toEqual({ kind: 'show-main' });
    expect(menuAction(GITHUB_ID)).toEqual({ kind: 'open', url: 'https://github.com/mattmccray/factory' });
    expect(GITHUB_URL).toBe('https://github.com/mattmccray/factory');
    for (const id of ['ABOUT', 'about-window', 'SETTINGS', 'settings-window', 'show', 'quit', '', 'STATUSBAR']) expect({ id, action: menuAction(id) }).toEqual({ id, action: null });
  });

  test('only a stored true means hidden; missing or malformed means shown', () => {
    expect(storedHidden(true)).toBe(true);
    for (const v of [false, null, undefined, 'true', 1, 0, {}, [], { hidden: true }]) expect({ v, hidden: storedHidden(v) }).toEqual({ v, hidden: false });
  });

  test('the pushed event is `statusbar` carrying { hidden }', () => {
    expect(STATUS_BAR_EVENT).toBe('statusbar');
    expect(statusBarPayload(true)).toEqual({ hidden: true });
    expect(statusBarPayload(false)).toEqual({ hidden: false });
  });
});

describe('035 AC1: Settings… and the Settings window', () => {
  test('Settings… is enabled with ⌘, for either status bar state', () => {
    for (const hidden of [false, true]) {
      const item = appMenu(ms({ statusBarHidden: hidden }))[0]?.items?.[0];
      expect(item).toEqual({ id: SETTINGS_ID, label: 'Settings…', key: ',', enabled: true });
    }
  });

  test('the window: id `settings`, titled Settings, a fixed size, a standard frame with only the close button, a child of main, the settings view on the port', () => {
    expect(SETTINGS_WINDOW_ID).toBe('settings');
    expect(SETTINGS_TITLE).toBe('Settings');
    expect(SETTINGS_SIZE).toMatch(/^\d+x\d+$/);
    expect(settingsUrl(8766)).toBe('http://127.0.0.1:8766/?shell=mac&view=settings');
    expect(settingsUrl(9123)).toBe('http://127.0.0.1:9123/?shell=mac&view=settings');
    expect(settingsWindow(9123)).toEqual({
      page: 'http://127.0.0.1:9123/?shell=mac&view=settings',
      title: 'Settings',
      size: SETTINGS_SIZE,
      minSize: SETTINGS_SIZE,
      chrome: { frame: true, windowControls: ['close'] },
      parent: 'main',
    });
  });
});

describe("059 AC8: Help → What's New", () => {
  test("Help lists What's New above Factory on GitHub, for either status bar state", () => {
    for (const hidden of [false, true]) {
      const help = appMenu(ms({ statusBarHidden: hidden })).find((m) => m.title === 'Help');
      expect(help).toEqual({ title: 'Help', role: 'help', items: [{ id: WHATS_NEW_ID, label: "What's New" }, { id: GITHUB_ID, label: 'Factory on GitHub' }] });
    }
  });

  test('its id maps to the action that shows the main window and pushes the whatsnew event', () => {
    expect(WHATS_NEW_ID).toBe('whatsnew');
    expect(menuAction(WHATS_NEW_ID)).toEqual({ kind: 'whats-new' });
    expect(WHATS_NEW_EVENT).toBe('whatsnew');
    expect(whatsNewPayload()).toEqual({});
    for (const id of ['whats-new', 'WhatsNew', 'changelog']) expect({ id, action: menuAction(id) }).toEqual({ id, action: null });
  });
});

describe('063 AC1: the View menu', () => {
  const viewOf = (s: MenuState): MenuItem[] | undefined => appMenu(s).find((m) => m.title === 'View')?.items;

  test('the items, in order, with separators after Show Settled… and after the inspector item, for every state', () => {
    for (const statusBarHidden of [false, true]) {
      for (const mergedHidden of [false, true]) {
        for (const needsMe of [false, true]) {
          for (const sidebarShown of [false, true]) {
            for (const inspectorOpen of [false, true]) {
              const state = ms({ statusBarHidden, mergedHidden }, { needsMe, sidebarShown, inspectorOpen });
              expect({ state, items: viewOf(state) }).toEqual({
                state,
                items: viewItems(
                  needsMe ? 'Show All Jobs' : 'Show Only Needs Me',
                  sidebarShown ? 'Hide Sidebar' : 'Show Sidebar',
                  inspectorOpen ? 'Hide Inspector' : 'Show Inspector',
                  statusBarHidden ? 'Show Status Bar' : 'Hide Status Bar',
                  mergedHidden ? 'Show Merged Column' : 'Hide Merged Column',
                ),
              });
            }
          }
        }
      }
    }
  });

  test('the shortcuts: ⇧⌘N, ⇧⌘S, ⇧⌘B, ⌃⌘S, ⌥⌘I, ⌘/, and none for the Merged item', () => {
    const keys = (viewOf(ms()) ?? []).filter((i) => i.separator !== true).map((i) => [i.id, i.key]);
    expect(keys).toEqual([
      [NEEDS_ME_ID, 'N'],
      [SETTLED_ID, 'S'],
      [BACKLOG_ID, 'B'],
      [SIDEBAR_ID, 'ctrl+s'],
      [INSPECTOR_ID, 'alt+i'],
      [STATUS_BAR_ID, '/'],
      [MERGED_ID, undefined],
    ]);
    expect(viewOf(ms())?.find((i) => i.id === MERGED_ID)).not.toHaveProperty('key');
  });

  test('the bar around View is unchanged: Andon, File (073), Edit, View, Window, Help', () => {
    expect(appMenu(ms({ mergedHidden: true }, { needsMe: true })).map((m) => m.title ?? m.role)).toEqual(['app', 'File', 'edit', 'View', 'Window', 'Help']);
  });

  test('each new id maps to its action; the page actions push their event, and Show Settled… shows the window first', () => {
    expect(menuAction(MERGED_ID)).toEqual({ kind: 'toggle-merged' });
    expect(menuAction(NEEDS_ME_ID)).toEqual({ kind: 'page', event: NEEDS_ME_EVENT, show: false });
    expect(menuAction(SETTLED_ID)).toEqual({ kind: 'page', event: SETTLED_EVENT, show: true });
    expect(menuAction(BACKLOG_ID)).toEqual({ kind: 'page', event: BACKLOG_EVENT, show: true }); // 067 AC7: shows the board, as Settled does
    expect([BACKLOG_ID, BACKLOG_EVENT, BACKLOG_LABEL]).toEqual(['backlog', 'backlog', 'Show Backlog…']);
    expect(menuAction(SIDEBAR_ID)).toEqual({ kind: 'page', event: SIDEBAR_EVENT, show: false });
    expect(menuAction(INSPECTOR_ID)).toEqual({ kind: 'page', event: INSPECTOR_EVENT, show: false });
    expect([NEEDS_ME_EVENT, SETTLED_EVENT, SIDEBAR_EVENT, INSPECTOR_EVENT, MERGED_EVENT]).toEqual(['needsme', 'settled', 'sidebar', 'inspector', 'merged']);
    expect(pageEventPayload()).toEqual({});
    expect(mergedPayload(true)).toEqual({ hidden: true });
    expect(mergedPayload(false)).toEqual({ hidden: false });
    expect(MERGED_KEY).toBe('mergedHidden');
    for (const id of ['Merged', 'needs-me', 'NEEDSME', 'settled-sheet', 'Sidebar', 'inspect', 'view']) expect({ id, action: menuAction(id) }).toEqual({ id, action: null });
  });

  test('a view state change relabels only the items whose state changed', () => {
    expect(viewLabelUpdates(DEFAULT_VIEW, DEFAULT_VIEW)).toEqual([]);
    expect(viewLabelUpdates(DEFAULT_VIEW, { needsMe: true, sidebarShown: false, inspectorOpen: true })).toEqual([
      { id: NEEDS_ME_ID, label: 'Show All Jobs' },
      { id: SIDEBAR_ID, label: 'Show Sidebar' },
      { id: INSPECTOR_ID, label: 'Hide Inspector' },
    ]);
    expect(viewLabelUpdates({ needsMe: true, sidebarShown: false, inspectorOpen: true }, { needsMe: true, sidebarShown: true, inspectorOpen: true })).toEqual([{ id: SIDEBAR_ID, label: 'Hide Sidebar' }]);
    expect(DEFAULT_VIEW).toEqual({ needsMe: false, sidebarShown: true, inspectorOpen: false });
  });
});

describe('065 AC1: About Andon', () => {
  test("Tiny's reserved id `about` opens the About window; every other id maps as before", () => {
    expect(ABOUT_ID).toBe('about');
    expect(menuAction('about')).toEqual({ kind: 'open-about' });
    expect(menuAction(SETTINGS_ID)).toEqual({ kind: 'open-settings' });
    expect(menuAction(GITHUB_ID)).toEqual({ kind: 'open', url: GITHUB_URL });
  });

  test('the app-role items still hold only Settings… (⌘,): About is Tiny\'s own item, rerouted by tinyjs.json', () => {
    for (const hidden of [false, true]) {
      const app = appMenu(ms({ statusBarHidden: hidden })).find((m) => m.role === 'app');
      expect(app).toEqual({ role: 'app', items: [{ id: SETTINGS_ID, label: 'Settings…', key: ',', enabled: true }] });
    }
    const ids = appMenu(ms()).flatMap((m) => m.items ?? []).map((i) => i.id);
    expect(ids).not.toContain(ABOUT_ID);
  });
});

describe('065 AC2: the About window', () => {
  test('id `about`, titled About Andon, the about view on the port', () => {
    expect(ABOUT_WINDOW_ID).toBe('about');
    expect(ABOUT_TITLE).toBe('About Andon');
    expect(ABOUT_QUERY).toBe('?shell=mac&view=about');
    expect(aboutUrl(8766)).toBe('http://127.0.0.1:8766/?shell=mac&view=about');
    expect(aboutUrl(9123)).toBe('http://127.0.0.1:9123/?shell=mac&view=about');
  });

  test('073 AC1: a fixed size (size equals minSize), frameless with only the close button at its default spot, a child of main', () => {
    expect(ABOUT_SIZE).toMatch(/^\d+x\d+$/);
    expect(ABOUT_SIZE).toBe('440x400'); // unchanged
    expect(aboutWindow(9123)).toEqual({
      page: 'http://127.0.0.1:9123/?shell=mac&view=about',
      title: 'About Andon',
      size: ABOUT_SIZE,
      minSize: ABOUT_SIZE,
      chrome: { frame: false, windowControls: ['close'] },
      parent: 'main',
    });
    expect('windowControlsPos' in aboutWindow(8766).chrome).toBe(false);
  });
});

describe('073 AC3: File → Close Window (⌘W)', () => {
  test('the File menu comes right after the app menu and ends with Close Window, ⌘W', () => {
    for (const hidden of [false, true]) {
      const bar = appMenu(ms({ statusBarHidden: hidden }));
      expect(bar.map((m) => m.title ?? m.role)).toEqual(['app', 'File', 'edit', 'View', 'Window', 'Help']);
      expect(bar[1]).toEqual({ title: 'File', items: fileMenu() });
    }
    expect(fileMenu().at(-1)).toEqual({ id: CLOSE_WINDOW_ID, label: 'Close Window', key: 'w' });
  });

  test('its id maps to the close-window action; near misses do nothing', () => {
    expect(CLOSE_WINDOW_ID).toBe('closewindow');
    expect(menuAction(CLOSE_WINDOW_ID)).toEqual({ kind: 'close-window' });
    for (const id of ['close', 'close-window', 'CloseWindow', 'w', 'file']) expect({ id, action: menuAction(id) }).toEqual({ id, action: null });
  });
});

describe('073 AC4: what Close Window does to the focused window', () => {
  test('Settings and About close, main hides; only Andon windows count', () => {
    expect(closeWindowStep(['settings'])).toEqual({ id: 'settings', step: 'close' });
    expect(closeWindowStep(['about'])).toEqual({ id: 'about', step: 'close' });
    expect(closeWindowStep(['main'])).toEqual({ id: 'main', step: 'hide' });
    expect(closeWindowStep(['other', 'about'])).toEqual({ id: 'about', step: 'close' });
  });

  test('no focused Andon window, or more than one claiming focus, does nothing: it never guesses', () => {
    expect(closeWindowStep([])).toBeNull();
    expect(closeWindowStep(['other', 'Settings', 'About', 'MAIN'])).toBeNull();
    expect(closeWindowStep(['main', 'settings'])).toBeNull();
    expect(closeWindowStep(['about', 'settings'])).toBeNull();
  });
});

describe('075 AC1: File → New Exploration… (⌘N)', () => {
  test('the File menu is exactly New Exploration… (⌘N), then Close Window (⌘W)', () => {
    expect(NEW_EXPLORATION_ID).toBe('newexploration');
    expect(fileMenu()).toEqual([
      { id: NEW_EXPLORATION_ID, label: 'New Exploration…', key: 'n' },
      { id: CLOSE_WINDOW_ID, label: 'Close Window', key: 'w' },
    ]);
  });

  test('no other menu changes: ⌘N is free, the View menu keeps ⇧⌘N for Needs Me', () => {
    const keys = appMenu(ms())
      .flatMap((m) => m.items ?? [])
      .map((i) => i.key)
      .filter((k) => k !== undefined);
    expect(keys.filter((k) => k === 'n')).toEqual(['n']);
    expect(appMenu(ms())).toEqual(expected('Hide Status Bar'));
  });

  test('its click shows the main window, then pushes startwork with { action: new-exploration, project: null }', () => {
    expect(START_WORK_EVENT).toBe('startwork');
    expect(menuAction(NEW_EXPLORATION_ID)).toEqual({ kind: 'start-work', payload: { action: 'new-exploration', project: null } });
    for (const id of ['new-exploration', 'NewExploration', 'n', 'explore', 'startwork']) expect({ id, action: menuAction(id) }).toEqual({ id, action: null });
  });

  test('the payload builder carries exactly the action and the project', () => {
    expect(startWorkPayload({ action: 'new-exploration', project: null })).toEqual({ action: 'new-exploration', project: null });
    expect(startWorkPayload({ action: 'new-exploration', project: 'aaaaaaaaaaaa' })).toEqual({ action: 'new-exploration', project: 'aaaaaaaaaaaa' });
    expect(startWorkPayload({ action: 'next', project: 'aaaaaaaaaaaa' })).toEqual({ action: 'next', project: 'aaaaaaaaaaaa' });
    const extra: StartWorkPush & { command: string } = { action: 'next', project: 'aaaaaaaaaaaa', command: '/factory next' };
    expect(Object.keys(startWorkPayload(extra))).toEqual(['action', 'project']);
  });
});

// ---- 077: About and Settings open centered on the main window ----

describe('077 AC1: the child window is centered on the main window', () => {
  const screen = { x: 0, y: 0, width: 1728, height: 1117 };
  const main = { x: 200, y: 100, width: 1280, height: 820 };

  test('the fixed sizes parse to whole points', () => {
    expect(parseSize(ABOUT_SIZE)).toEqual({ width: 440, height: 400 });
    expect(parseSize(SETTINGS_SIZE)).toEqual({ width: 480, height: 360 });
    for (const bad of ['', '440', 'x400', '440x', 'axb', '-1x2', '0x10', '440 x 400']) expect({ bad, r: parseSize(bad) }).toEqual({ bad, r: null });
  });

  test('About (440x400) and Settings (480x360) get the top-left that centers them on the main frame', () => {
    expect(childPosition(main, screen, { width: 440, height: 400 })).toEqual({ x: 200 + 420, y: 100 + 210 });
    expect(childPosition(main, screen, { width: 480, height: 360 })).toEqual({ x: 200 + 400, y: 100 + 230 });
  });

  test('a half-point center is rounded to whole points', () => {
    const odd = { x: 201, y: 101, width: 1281, height: 821 };
    const at = childPosition(odd, screen, { width: 440, height: 400 });
    expect(at).toEqual({ x: Math.round(201 + 841 / 2), y: Math.round(101 + 421 / 2) });
    expect(Number.isInteger(at.x) && Number.isInteger(at.y)).toBe(true);
  });

  test('on a second screen, centering works in the global coordinates', () => {
    const right = { x: 1728, y: -200, width: 2560, height: 1440 };
    expect(childPosition({ x: 2000, y: 0, width: 1280, height: 820 }, right, { width: 480, height: 360 })).toEqual({ x: 2400, y: 230 });
  });
});

describe('077 AC2: the child window stays fully on the main window\'s screen', () => {
  const screen = { x: 0, y: 0, width: 1728, height: 1117 };
  const about = { width: 440, height: 400 };
  const settings = { width: 480, height: 360 };
  const inside = (at: { x: number; y: number }, s: typeof screen, c: typeof about): boolean =>
    at.x >= s.x && at.y >= s.y && at.x + c.width <= s.x + s.width && at.y + c.height <= s.y + s.height;

  test('a small main window against or past each edge and corner keeps the child inside', () => {
    const w = 300;
    const h = 200;
    const cases = {
      left: { x: -250, y: 400, width: w, height: h },
      right: { x: 1650, y: 400, width: w, height: h },
      top: { x: 700, y: -150, width: w, height: h },
      bottom: { x: 700, y: 1050, width: w, height: h },
      topLeft: { x: -280, y: -180, width: w, height: h },
      topRight: { x: 1700, y: -180, width: w, height: h },
      bottomLeft: { x: -280, y: 1100, width: w, height: h },
      bottomRight: { x: 1700, y: 1100, width: w, height: h },
      flushLeft: { x: 0, y: 0, width: w, height: h },
    };
    for (const [edge, m] of Object.entries(cases)) {
      for (const child of [about, settings]) {
        const at = childPosition(m, screen, child);
        expect({ edge, child, inside: inside(at, screen, child) }).toEqual({ edge, child, inside: true });
      }
    }
    expect(childPosition(cases.left, screen, about)).toEqual({ x: 0, y: 300 });
    expect(childPosition(cases.right, screen, about)).toEqual({ x: 1728 - 440, y: 300 });
    expect(childPosition(cases.top, screen, about)).toEqual({ x: 630, y: 0 });
    expect(childPosition(cases.bottom, screen, about)).toEqual({ x: 630, y: 1117 - 400 });
    expect(childPosition(cases.bottomRight, screen, settings)).toEqual({ x: 1728 - 480, y: 1117 - 360 });
  });

  test('the clamp uses the screen\'s own origin, on a screen that is not the primary one', () => {
    const left = { x: -1920, y: 100, width: 1920, height: 1080 };
    const at = childPosition({ x: -1950, y: 50, width: 300, height: 200 }, left, about);
    expect(at).toEqual({ x: -1920, y: 100 });
    expect(inside(at, left, about)).toBe(true);
  });

  test('a child larger than the screen is pinned to the screen\'s top-left', () => {
    const tiny = { x: 100, y: 50, width: 400, height: 300 };
    expect(childPosition({ x: 120, y: 60, width: 300, height: 200 }, tiny, about)).toEqual({ x: 100, y: 50 });
    // narrower than the screen only: x is pinned, y still centers (and clamps)
    expect(childPosition({ x: 120, y: 400, width: 300, height: 200 }, { x: 100, y: 50, width: 400, height: 1000 }, about)).toEqual({ x: 100, y: 300 });
  });
});

describe('077: the main window\'s state, as frames for the placement', () => {
  /** A main window state as Tiny reports it: 1280x820 page, 1280x820 outer (frameless), on a screen at `origin`. */
  const state = (x: number, y: number, origin = { x: 0, y: 0 }) => ({
    x,
    y,
    width: 1280,
    height: 820,
    outer: { width: 1282, height: 822 },
    screen: { width: 1728, height: 1117, scale: 2 },
    local: { x: x - origin.x, y: y - origin.y },
  });

  test('the main frame is its outer footprint; the screen origin is x - local.x, y - local.y', () => {
    expect(mainFrames(state(200, 100))).toEqual({ main: { x: 200, y: 100, width: 1282, height: 822 }, screen: { x: 0, y: 0, width: 1728, height: 1117 } });
    expect(mainFrames(state(-1700, 300, { x: -1728, y: 0 }))).toEqual({ main: { x: -1700, y: 300, width: 1282, height: 822 }, screen: { x: -1728, y: 0, width: 1728, height: 1117 } });
  });

  test('a state with a non-finite number gives no frames', () => {
    expect(mainFrames({ ...state(0, 0), x: Number.NaN })).toBeNull();
    expect(mainFrames({ ...state(0, 0), outer: { width: Number.POSITIVE_INFINITY, height: 1 } })).toBeNull();
    expect(mainFrames({ ...state(0, 0), screen: { width: 0, height: 1117 } })).toBeNull();
  });

  test('placeOnMain centers About and Settings on the main window from its state, clamped to its screen', () => {
    expect(placeOnMain(state(200, 100), ABOUT_SIZE)).toEqual({ x: 200 + 421, y: 100 + 211 });
    expect(placeOnMain(state(200, 100), SETTINGS_SIZE)).toEqual({ x: 200 + 401, y: 100 + 231 });
    expect(placeOnMain(state(-1200, 100), ABOUT_SIZE)).toEqual({ x: 0, y: 311 });
    expect(placeOnMain({ ...state(0, 0), x: Number.NaN }, ABOUT_SIZE)).toBeNull();
    expect(placeOnMain(state(0, 0), 'big')).toBeNull();
  });

  test('the window options carry x/y only when a position is given', () => {
    expect('x' in settingsWindow(8766) || 'y' in settingsWindow(8766)).toBe(false);
    expect('x' in aboutWindow(8766) || 'y' in aboutWindow(8766)).toBe(false);
    expect(settingsWindow(8766, null)).toEqual(settingsWindow(8766));
    expect(settingsWindow(8766, { x: 10, y: 20 })).toEqual({ ...settingsWindow(8766), x: 10, y: 20 });
    expect(aboutWindow(8766, { x: -5, y: 7 })).toEqual({ ...aboutWindow(8766), x: -5, y: 7 });
  });
});
