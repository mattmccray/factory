// The adapter against a fake Tiny app. onTray and the lantern hooks touch no Tiny or txiki
// globals; the init tests stand in fake `tjs` and `__ANDON_REPO__` globals.
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { api, assetPath, checkApps, dockIcon, findT3, getSettings, handOff, hostHandoff, hostJobMenu, init, onContextMenu, runJobItem, showJobMenu, onMenu, onNavigate, onTray, reloadScript, runProjectItem, setDock, setSetting, setTray, showProjectMenu, trayIcon } from './backend';
import type { HandoffHost, JobMenuHost, MacApp, MacNavEvent, MacTraySpec, MacWinState, RunResult } from './backend';
import { itemId, projectMenuItems } from './projectmenu';
import { jobItemId, jobMenuItems } from './jobmenu';
import type { MenuProject } from './projectmenu';
import type { HandoffMode, Settings } from './settings';
import { GITHUB_ID, MINIMIZE_ID, SETTINGS_ID, SETTINGS_SIZE, SHOW_MAIN_ID, STATUS_BAR_ID, ZOOM_ID, appMenu, settingsWindow } from './appmenu';
import { trayNotice, traySpec } from './badge';

/** Which window ops fail. Mutable, so a test can heal the window between clicks. Each failing op is
 *  still recorded, then `getState` rejects and `restore`/`show` throw. */
interface Failures {
  getState?: boolean;
  restore?: boolean;
  show?: boolean;
}

function fakeApp(state: MacWinState | null, fail: Failures = {}): { app: MacApp; calls: string[] } {
  const calls: string[] = [];
  const op = (name: string, failing: boolean | undefined): void => {
    calls.push(name);
    if (failing === true) throw new Error(`${name} failed`);
  };
  const app: MacApp = {
    tray: { set: () => calls.push('tray.set') },
    icon: (path) => calls.push(`icon(${path})`) > 0,
    badge: (text) => calls.push(`badge(${text})`) > 0,
    notify: async () => {
      calls.push('notify');
      return true;
    },
    window: (id) => ({
      getState: async () => {
        op(`${id}.getState`, fail.getState);
        return state;
      },
      restore: () => op(`${id}.restore`, fail.restore),
      setAllSpaces: (on) => calls.push(`${id}.allSpaces(${on})`),
      show: () => op(`${id}.show`, fail.show),
      eval: () => calls.push(`${id}.eval`),
      minimize: () => calls.push(`${id}.minimize`),
      zoom: () => calls.push(`${id}.zoom`),
      setResizable: (on) => calls.push(`${id}.resizable(${on})`),
    }),
    windows: async () => ['main'],
    win: { open: (id) => calls.push(`win.open(${id})`) },
    setHideOnClose: () => calls.push('setHideOnClose'),
    quit: () => calls.push('quit'),
    push: () => calls.push('push'),
    menu: { set: () => calls.push('menu.set'), update: () => calls.push('menu.update'), setContext: () => calls.push('menu.setContext') },
    store: {
      get: async () => {
        calls.push('store.get');
        return null;
      },
      set: async () => calls.push('store.set') > 0,
    },
    shell: {
      open: async () => {
        calls.push('shell.open');
        return true;
      },
      reveal: async () => {
        calls.push('shell.reveal');
        return true;
      },
    },
    clipboard: { write: () => calls.push('clipboard.write') > 0 },
  };
  return { app, calls };
}

// The tray click reads only `minimized`, `fullscreen`, and `allSpaces`; Tiny's `visible` and `focused`
// play no part in it (rework 2), so a window in front and one hidden look the same to it. Settings…'s
// bring-back step also reads `visible` (037).
const st = (minimized: boolean, fullscreen = false, visible = true): MacWinState => ({ minimized, fullscreen, allSpaces: false, visible });
/** Show on the Space the user is on: join every Space, show, then pin it back to one. */
const showHere = (...mid: string[]): string[] => ['main.getState', 'main.allSpaces(true)', ...mid, 'main.show', 'main.allSpaces(false)'];

test('AC4 (rework 2): a left click shows the window on this Space and never hides it: hidden, behind, or in front', async () => {
  for (const s of [st(false), null]) {
    const { app, calls } = fakeApp(s);
    await onTray(null, app);
    expect(calls).toEqual(showHere());
  }
});

test('AC4: a left click on a minimized window restores it, then shows it', async () => {
  const { app, calls } = fakeApp(st(true));
  await onTray(null, app);
  expect(calls).toEqual(showHere('main.restore'));
});

test('rework 1: a fullscreen window is shown where it is, without joining every Space', async () => {
  const { app, calls } = fakeApp(st(false, true));
  await onTray(null, app);
  expect(calls).toEqual(['main.getState', 'main.show']);
});

test('rework 1: a second left click while the first is still showing the window is dropped', async () => {
  const { app, calls } = fakeApp(st(false));
  await Promise.all([onTray(null, app), onTray(null, app)]);
  expect(calls).toEqual(showHere());
});

test('AC4: the menu items behave as before', async () => {
  const show = fakeApp(st(false));
  await onTray('show', show.app);
  expect(show.calls).toEqual(['main.show']);
  const quit = fakeApp(st(false));
  await onTray('quit', quit.app);
  expect(quit.calls).toEqual(['quit']);
});

test('AC1: when show() throws, the window is still pinned back to one Space, and the click rejects', async () => {
  const { app, calls } = fakeApp(st(false), { show: true });
  await expect(onTray(null, app)).rejects.toThrow('main.show failed');
  expect(calls).toEqual(showHere());
  expect(calls.at(-1)).toBe('main.allSpaces(false)');
});

test('AC2: when restore() throws, the window is still pinned back to one Space, and show() is skipped', async () => {
  const { app, calls } = fakeApp(st(true), { restore: true });
  await expect(onTray(null, app)).rejects.toThrow('main.restore failed');
  expect(calls).toEqual(['main.getState', 'main.allSpaces(true)', 'main.restore', 'main.allSpaces(false)']);
  expect(calls).not.toContain('main.show');
});

test('AC3: when getState() rejects, the click falls back to a plain show() and resolves', async () => {
  const { app, calls } = fakeApp(st(false), { getState: true });
  await expect(onTray(null, app)).resolves.toBeUndefined();
  expect(calls).toEqual(['main.getState', 'main.show']);
});

test('AC4: a failed click does not jam the next one', async () => {
  const failures: (keyof Failures)[] = ['show', 'getState'];
  for (const failing of failures) {
    const fail: Failures = { [failing]: true };
    const { app, calls } = fakeApp(st(false), fail);
    await onTray(null, app).catch(() => undefined);
    fail[failing] = false;
    calls.length = 0;
    await onTray(null, app);
    expect(calls).toEqual(showHere());
  }
});

// ---- the lantern: Dock icon, tray icon, badge ----

const REPO = resolve(import.meta.dir, '..', '..', '..');
const ASSETS = join(REPO, 'apps', 'andon', 'assets');

/** A fake app that records the Dock icon, the badge, and every tray spec. */
function lanternApp(): { app: MacApp; icons: string[]; badges: string[]; trays: MacTraySpec[] } {
  const icons: string[] = [];
  const badges: string[] = [];
  const trays: MacTraySpec[] = [];
  const { app } = fakeApp(null);
  app.icon = (p) => icons.push(p) > 0;
  app.badge = (t) => badges.push(t) > 0;
  app.tray = { set: (spec) => void trays.push(spec) };
  return { app, icons, badges, trays };
}

test('AC4: each Dock look maps to the bundle icon or an absolute asset path that exists', () => {
  expect(dockIcon(REPO, 'idle')).toBe('');
  expect(dockIcon(REPO, 'running')).toBe(join(ASSETS, 'dock-running.png'));
  expect(dockIcon(REPO, 'escalated')).toBe(join(ASSETS, 'dock-escalated.png'));
  const { app, icons } = lanternApp();
  setDock(app, REPO, 'idle');
  setDock(app, REPO, 'running');
  setDock(app, REPO, 'escalated');
  expect(icons).toEqual(['', join(ASSETS, 'dock-running.png'), join(ASSETS, 'dock-escalated.png')]);
  for (const p of icons.slice(1)) {
    expect(p.startsWith('/')).toBe(true);
    expect(dirname(p)).toBe(ASSETS);
    expect(existsSync(p)).toBe(true);
  }
  expect(existsSync(join(ASSETS, 'icon.png'))).toBe(true); // what '' resets to (the bundle icon)
});

test('AC4: the tray icon is the outlined or filled lantern, as a template image, with the spec unchanged', () => {
  expect(trayIcon(REPO, false)).toBe(join(ASSETS, 'tray-idle.png'));
  expect(trayIcon(REPO, true)).toBe(join(ASSETS, 'tray-running.png'));
  const { app, trays } = lanternApp();
  setTray(app, REPO, traySpec(2), false);
  setTray(app, REPO, traySpec(2), true);
  expect(trays).toEqual([
    { ...traySpec(2), icon: join(ASSETS, 'tray-idle.png'), template: true },
    { ...traySpec(2), icon: join(ASSETS, 'tray-running.png'), template: true },
  ]);
  for (const t of trays) {
    expect(typeof t.icon).toBe('string');
    expect(dirname(String(t.icon))).toBe(ASSETS);
    expect(existsSync(String(t.icon))).toBe(true);
  }
  expect(assetPath('/the/repo/', 'x.png')).toBe('/the/repo/apps/andon/assets/x.png');
});

// ---- init: the idle look before the service answers and after it fails to start ----

interface FakeProcess {
  stdout: ReadableStream<Uint8Array> | null;
  kill(): void;
  wait(): Promise<{ exit_status: number; term_signal: string | null }>;
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** Stand in txiki's `tjs` and the build-time repo path. `curl` runs `curl`; any other spawn runs `service`. */
function fakeGlobals(curl: () => FakeProcess, service: () => FakeProcess): void {
  Reflect.set(globalThis, '__ANDON_REPO__', REPO);
  Reflect.set(globalThis, '__ANDON_BUN__', '/the/bun');
  Reflect.set(globalThis, 'tjs', { env: {}, spawn: (argv: string[]) => (argv[0] === 'curl' ? curl() : service()) });
}

afterEach(() => {
  for (const k of ['__ANDON_REPO__', '__ANDON_BUN__', 'tjs']) Reflect.deleteProperty(globalThis, k);
});

/** The Dock is idle (never set, or reset with '') and the badge is clear (never set, or ''). */
function expectIdle(l: ReturnType<typeof lanternApp>): void {
  expect(l.icons.every((p) => p === '')).toBe(true);
  expect(l.badges.every((t) => t === '')).toBe(true);
}

test('AC5: before the service answers, the tray shows the notice with the outlined lantern, and the Dock is idle', () => {
  const hung: FakeProcess = { stdout: new ReadableStream<Uint8Array>(), kill: () => undefined, wait: never };
  fakeGlobals(
    () => hung,
    () => hung,
  );
  const l = lanternApp();
  init(l.app);
  expect(l.trays).toEqual([{ ...trayNotice('starting the service'), icon: join(ASSETS, 'tray-idle.png'), template: true }]);
  expectIdle(l);
});

test('AC5: when the service fails to start, the tray shows the reason with the outlined lantern, and the Dock is idle', async () => {
  const unreachable = (): FakeProcess => ({
    stdout: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    kill: () => undefined,
    wait: async () => ({ exit_status: 7, term_signal: null }),
  });
  fakeGlobals(unreachable, () => {
    throw new Error('no bun here');
  });
  const l = lanternApp();
  init(l.app);
  for (let i = 0; i < 50 && l.trays.length < 2; i++) await new Promise((r) => setTimeout(r, 2));
  expect(l.trays).toHaveLength(2);
  const last = l.trays.at(-1);
  expect(last?.tooltip).toStartWith('Andon: could not start the service');
  expect(last).toMatchObject({ title: '', icon: join(ASSETS, 'tray-idle.png'), template: true });
  expectIdle(l);
});

test('the reload after starting the service (or on another port) keeps ?shell=mac', () => {
  expect(reloadScript(8766)).toBe('location.replace("http://127.0.0.1:8766/?shell=mac")');
  expect(reloadScript(9123)).toBe('location.replace("http://127.0.0.1:9123/?shell=mac")');
});

// ---- the app menu ----

/** The main window's state as the menu fake reports it: a state, null, or `'fail'` (`getState` rejects). */
type MainState = { current: MacWinState | null | 'fail' };

/** A fake app that records the menu bar, the store, the pushes, and the shell, with `stored` as the
 *  status bar choice in the store, and `main.current` as the main window's state. */
function menuApp(stored: unknown): { app: MacApp; log: unknown[][]; store: Map<string, unknown>; open: Set<string>; main: MainState } {
  const log: unknown[][] = [];
  const store = new Map<string, unknown>([['statusBarHidden', stored]]);
  const { app } = fakeApp(st(false));
  app.menu = {
    set: (menus) => void log.push(['menu.set', menus]),
    update: (id, patch) => void log.push(['menu.update', id, patch]),
    setContext: (items) => void log.push(['menu.setContext', items]),
  };
  app.store = {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => {
      store.set(key, value);
      log.push(['store.set', key, value]);
      return true;
    },
  };
  app.push = (event, data) => void log.push(['push', event, data]);
  app.shell = {
    open: async (target) => {
      log.push(['shell.open', target]);
      return true;
    },
    reveal: async (path) => {
      log.push(['shell.reveal', path]);
      return true;
    },
  };
  const main: MainState = { current: st(false) };
  app.window = (id) => ({
    getState: async () => {
      const state = main.current;
      if (state === 'fail') throw new Error(`${id}.getState failed`);
      return state;
    },
    restore: () => log.push([`${id}.restore`]),
    setAllSpaces: (on) => log.push([`${id}.allSpaces`, on]),
    show: () => log.push([`${id}.show`]),
    eval: () => log.push([`${id}.eval`]),
    minimize: () => log.push([`${id}.minimize`]),
    zoom: () => log.push([`${id}.zoom`]),
    setResizable: (on) => log.push([`${id}.resizable`, on]),
  });
  const open = new Set<string>(['main']);
  app.windows = async () => [...open];
  app.win = {
    open: (id, opts) => {
      open.add(id);
      log.push(['win.open', id, opts]);
    },
  };
  return { app, log, store, open, main };
}

/** init, with the service never answering, then let the stored choice be read. */
async function initMenu(stored: unknown): Promise<ReturnType<typeof menuApp>> {
  const hung: FakeProcess = { stdout: new ReadableStream<Uint8Array>(), kill: () => undefined, wait: never };
  fakeGlobals(
    () => hung,
    () => hung,
  );
  const m = menuApp(stored);
  init(m.app);
  for (let i = 0; i < 50 && !m.log.some((e) => e[0] === 'menu.set'); i++) await new Promise((r) => setTimeout(r, 1));
  return m;
}

const menuSet = (log: unknown[][]): unknown[][] => log.filter((e) => e[0] === 'menu.set');

test('AC3: init sets the menu bar with the label for the stored state', async () => {
  const shown = await initMenu(null);
  expect(menuSet(shown.log)).toEqual([['menu.set', appMenu(false)]]);
  const hidden = await initMenu(true);
  expect(menuSet(hidden.log)).toEqual([['menu.set', appMenu(true)]]);
  const malformed = await initMenu('yes');
  expect(menuSet(malformed.log)).toEqual([['menu.set', appMenu(false)]]);
});

test('AC3: init still sets the menu bar (status bar shown) when the store cannot be read', async () => {
  const hung: FakeProcess = { stdout: new ReadableStream<Uint8Array>(), kill: () => undefined, wait: never };
  fakeGlobals(
    () => hung,
    () => hung,
  );
  const m = menuApp(true);
  m.app.store.get = async () => {
    throw new Error('no store');
  };
  init(m.app);
  for (let i = 0; i < 50 && menuSet(m.log).length === 0; i++) await new Promise((r) => setTimeout(r, 1));
  expect(menuSet(m.log)).toEqual([['menu.set', appMenu(false)]]);
});

test('AC3: the toggle flips the state, relabels the item, pushes the new state, and stores it', async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  await onMenu(STATUS_BAR_ID, m.app);
  expect(m.log).toEqual([
    ['store.set', 'statusBarHidden', true],
    ['menu.update', STATUS_BAR_ID, { label: 'Show Status Bar' }],
    ['push', 'statusbar', { hidden: true }],
  ]);
  m.log.length = 0;
  await onMenu(STATUS_BAR_ID, m.app);
  expect(m.log).toEqual([
    ['store.set', 'statusBarHidden', false],
    ['menu.update', STATUS_BAR_ID, { label: 'Hide Status Bar' }],
    ['push', 'statusbar', { hidden: false }],
  ]);
  expect(m.store.get('statusBarHidden')).toBe(false);
});

test('AC3: a toggle after a relaunch starts from the stored state', async () => {
  const m = await initMenu(true);
  m.log.length = 0;
  await onMenu(STATUS_BAR_ID, m.app);
  expect(m.log[1]).toEqual(['menu.update', STATUS_BAR_ID, { label: 'Hide Status Bar' }]);
  expect(m.store.get('statusBarHidden')).toBe(false);
});

test('AC3: Window and Help items minimize, zoom, show the window as the tray click does, and open GitHub', async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  await onMenu(MINIMIZE_ID, m.app);
  await onMenu(ZOOM_ID, m.app);
  expect(m.log).toEqual([['main.minimize'], ['main.zoom']]);
  m.log.length = 0;
  await onMenu(SHOW_MAIN_ID, m.app);
  expect(m.log).toEqual([['main.allSpaces', true], ['main.show'], ['main.allSpaces', false]]); // the tray click's show path
  m.log.length = 0;
  await onMenu(GITHUB_ID, m.app);
  expect(m.log).toEqual([['shell.open', 'https://github.com/mattmccray/factory']]);
});

test('AC3: unknown ids do nothing', async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  for (const id of ['about', 'nope', 'SETTINGS']) await onMenu(id, m.app);
  expect(m.log).toEqual([]);
});

// ---- the Settings window (035) ----

test('035 AC1: Settings… opens the settings window on the service port, not resizable; a second click shows and focuses it', async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  await onMenu(SETTINGS_ID, m.app);
  expect(m.log).toEqual([
    ['win.open', 'settings', { page: 'http://127.0.0.1:8766/?shell=mac&view=settings', title: 'Settings', size: SETTINGS_SIZE, minSize: SETTINGS_SIZE, chrome: { frame: true, windowControls: ['close'] }, parent: 'main' }],
    ['settings.resizable', false],
  ]);
  m.log.length = 0;
  await onMenu(SETTINGS_ID, m.app);
  expect(m.log).toEqual([['settings.show']]);
});

test('035 AC1: the settings window loads from the port init resolved', async () => {
  const hung: FakeProcess = { stdout: new ReadableStream<Uint8Array>(), kill: () => undefined, wait: never };
  Reflect.set(globalThis, '__ANDON_REPO__', REPO);
  Reflect.set(globalThis, '__ANDON_BUN__', '/the/bun');
  Reflect.set(globalThis, 'tjs', { env: { ANDON_PORT: '9123' }, spawn: () => hung });
  const m = menuApp(null);
  init(m.app);
  m.log.length = 0;
  await onMenu(SETTINGS_ID, m.app);
  expect(m.log.filter((e) => e[0] === 'win.open')).toEqual([['win.open', 'settings', settingsWindow(9123)]]);
});

test('035 AC1: two quick clicks open one window', async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  await Promise.all([onMenu(SETTINGS_ID, m.app), onMenu(SETTINGS_ID, m.app)]);
  expect(m.log.filter((e) => e[0] === 'win.open')).toHaveLength(1);
});

test('035 AC1: once the settings window is closed, Settings… opens it again', async () => {
  const m = await initMenu(null);
  await onMenu(SETTINGS_ID, m.app);
  m.open.delete('settings');
  m.log.length = 0;
  await onMenu(SETTINGS_ID, m.app);
  expect(m.log.map((e) => e[0])).toEqual(['win.open', 'settings.resizable']);
});

// ---- Settings… brings the main window back first (037) ----

const openCall = (port = 8766): unknown[] => ['win.open', 'settings', settingsWindow(port)];

test('037 AC2: with the main window up, Settings… opens the close-only child window, not resizable, and leaves main alone', async () => {
  const m = await initMenu(null);
  m.main.current = st(false, false, true);
  m.log.length = 0;
  await onMenu(SETTINGS_ID, m.app);
  expect(m.log).toEqual([openCall(), ['settings.resizable', false]]);
  expect(m.log.some((e) => e[0] === 'main.restore' || e[0] === 'main.show')).toBe(false);
});

test('037 AC3: with the main window hidden, Settings… shows it, then opens Settings; once open, shows main, then Settings', async () => {
  const m = await initMenu(null);
  m.main.current = st(false, false, false);
  m.log.length = 0;
  await onMenu(SETTINGS_ID, m.app);
  expect(m.log).toEqual([['main.show'], openCall(), ['settings.resizable', false]]);
  m.log.length = 0;
  await onMenu(SETTINGS_ID, m.app);
  expect(m.log).toEqual([['main.show'], ['settings.show']]);
});

test('037 AC4: with the main window minimized, Settings… restores and shows it, then opens Settings; once open, then shows Settings', async () => {
  const m = await initMenu(null);
  m.main.current = st(true, false, false);
  m.log.length = 0;
  await onMenu(SETTINGS_ID, m.app);
  expect(m.log).toEqual([['main.restore'], ['main.show'], openCall(), ['settings.resizable', false]]);
  m.log.length = 0;
  await onMenu(SETTINGS_ID, m.app);
  expect(m.log).toEqual([['main.restore'], ['main.show'], ['settings.show']]);
});

test('037 AC5: with Settings open, Settings… never opens a second window: main is brought back, then Settings shown and focused', async () => {
  const m = await initMenu(null);
  await onMenu(SETTINGS_ID, m.app);
  for (const state of [st(false, false, false), st(true, false, false), st(false, false, true)]) {
    m.main.current = state;
    m.log.length = 0;
    await onMenu(SETTINGS_ID, m.app);
    expect(m.log.filter((e) => e[0] === 'win.open')).toEqual([]);
    expect(m.log.at(-1)).toEqual(['settings.show']);
    expect(m.log.filter((e) => e[0] === 'settings.show')).toHaveLength(1);
  }
});

test('037 AC5: two quick clicks with the main window hidden open one window and bring main back once', async () => {
  const m = await initMenu(null);
  m.main.current = st(true, false, false);
  m.log.length = 0;
  await Promise.all([onMenu(SETTINGS_ID, m.app), onMenu(SETTINGS_ID, m.app)]);
  expect(m.log).toEqual([['main.restore'], ['main.show'], openCall(), ['settings.resizable', false]]);
});

test('037 AC6: when the main window state cannot be read (rejects or null), Settings… shows main, no restore, and still opens or shows Settings', async () => {
  for (const current of ['fail', null] as const) {
    const m = await initMenu(null);
    m.main.current = current;
    m.log.length = 0;
    await onMenu(SETTINGS_ID, m.app);
    expect(m.log).toEqual([['main.show'], openCall(), ['settings.resizable', false]]);
    m.log.length = 0;
    await onMenu(SETTINGS_ID, m.app);
    expect(m.log).toEqual([['main.show'], ['settings.show']]);
  }
});

test('037: a main window that throws on show still lets Settings… open Settings', async () => {
  const m = await initMenu(null);
  m.main.current = st(false, false, false);
  const base = m.app.window;
  m.app.window = (id) => {
    const w = base(id);
    if (id !== 'main') return w;
    return {
      ...w,
      show: () => {
        m.log.push(['main.show']);
        throw new Error('main.show failed');
      },
    };
  };
  m.log.length = 0;
  await onMenu(SETTINGS_ID, m.app);
  expect(m.log).toEqual([['main.show'], openCall(), ['settings.resizable', false]]);
});

const SETTINGS_META = { window: 'settings', origin: 'http://127.0.0.1:8766' };
/** The settings with the status bar choice, the default T3 Code choice, and no `t3` (the fake `tjs` has no files). */
const snap = (hidden: boolean, t3Handoff: HandoffMode = 'draft', t3Found = false): Settings => ({ statusBarHidden: hidden, t3Handoff, t3Found });

test('035 AC2: from any window but Settings, getSettings and setSetting answer null and change nothing', async () => {
  const m = await initMenu(true);
  m.log.length = 0;
  for (const meta of [{ window: 'main' }, { window: 'other' }, {}, null, undefined, 'settings']) {
    expect(await getSettings(m.app, meta)).toBeNull();
    expect(await setSetting({ key: 'statusBarHidden', value: false }, m.app, meta)).toBeNull();
    expect(await api.getSettings(null, m.app, meta)).toBeNull();
    expect(await api.setSetting({ key: 'statusBarHidden', value: false }, m.app, meta)).toBeNull();
  }
  expect(m.log).toEqual([]);
  expect(m.store.get('statusBarHidden')).toBe(true);
  expect(await getSettings(m.app, SETTINGS_META)).toEqual(snap(true)); // still hidden
});

test('035 AC3: getSettings returns the stored choice: exactly true is hidden', async () => {
  for (const [stored, hidden] of [[true, true], [false, false], [null, false], ['yes', false], [1, false]] as const) {
    const m = await initMenu(stored);
    expect({ stored, s: await api.getSettings(undefined, m.app, SETTINGS_META) }).toEqual({ stored, s: snap(hidden) });
  }
});

test('035 AC3: a malformed setSetting from Settings changes nothing', async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  for (const params of [{ key: 'statusBarHidden', value: 'yes' }, { key: 'nope', value: true }, null, undefined, { key: 'statusBarHidden', value: true, extra: 1 }, [], 'statusBarHidden']) {
    expect({ params, r: await setSetting(params, m.app, SETTINGS_META) }).toEqual({ params, r: null });
  }
  expect(m.log).toEqual([]);
  expect(m.store.get('statusBarHidden')).toBeNull();
});

test('035 AC4: a valid setSetting stores the choice, relabels the View menu, pushes statusbar, and returns the settings', async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  expect(await api.setSetting({ key: 'statusBarHidden', value: true }, m.app, SETTINGS_META)).toEqual(snap(true));
  expect(m.log).toEqual([
    ['store.set', 'statusBarHidden', true],
    ['menu.update', STATUS_BAR_ID, { label: 'Show Status Bar' }],
    ['push', 'statusbar', { hidden: true }],
  ]);
  expect(m.store.get('statusBarHidden')).toBe(true);
  // the value it already holds flips nothing
  m.log.length = 0;
  expect(await setSetting({ key: 'statusBarHidden', value: true }, m.app, SETTINGS_META)).toEqual(snap(true));
  expect(m.log).toEqual([]);
  // back to shown
  expect(await setSetting({ key: 'statusBarHidden', value: false }, m.app, SETTINGS_META)).toEqual(snap(false));
  expect(m.log).toEqual([
    ['store.set', 'statusBarHidden', false],
    ['menu.update', STATUS_BAR_ID, { label: 'Hide Status Bar' }],
    ['push', 'statusbar', { hidden: false }],
  ]);
});

test('035 AC4: the View menu toggle after a Settings change starts from it, and Settings reads the toggle', async () => {
  const m = await initMenu(null);
  await setSetting({ key: 'statusBarHidden', value: true }, m.app, SETTINGS_META);
  m.log.length = 0;
  await onMenu(STATUS_BAR_ID, m.app);
  expect(m.log).toEqual([
    ['store.set', 'statusBarHidden', false],
    ['menu.update', STATUS_BAR_ID, { label: 'Hide Status Bar' }],
    ['push', 'statusbar', { hidden: false }],
  ]);
  expect(await getSettings(m.app, SETTINGS_META)).toEqual(snap(false));
});

test('035 AC4: the choice survives a relaunch: init reads what setSetting stored', async () => {
  const m = await initMenu(null);
  await setSetting({ key: 'statusBarHidden', value: true }, m.app, SETTINGS_META);
  const again = await initMenu(m.store.get('statusBarHidden'));
  expect(menuSet(again.log)).toEqual([['menu.set', appMenu(true)]]);
  expect(await getSettings(again.app, SETTINGS_META)).toEqual(snap(true));
});

test('036 AC5: getSettings carries the stored T3 Code choice (draft when nothing valid is stored) and whether t3 is there now', async () => {
  for (const [stored, mode] of [[null, 'draft'], ['send', 'send'], ['copy', 'copy'], ['draft', 'draft'], ['auto', 'draft'], [true, 'draft']] as const) {
    const m = await initMenu(null);
    m.store.set('t3Handoff', stored);
    expect({ stored, s: await getSettings(m.app, SETTINGS_META) }).toEqual({ stored, s: snap(false, mode) });
  }
  const m = await initMenu(true);
  fakeMachine([], ['/opt/homebrew/bin/t3']);
  expect(await api.getSettings(null, m.app, SETTINGS_META)).toEqual(snap(true, 'draft', true));
  fakeMachine([], []);
  expect(await api.getSettings(null, m.app, SETTINGS_META)).toEqual(snap(true, 'draft', false));
});

test('036 AC5: setSetting stores a valid T3 Code choice and refuses anything else; the status bar is untouched', async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  for (const value of ['send', 'copy', 'draft'] as const) {
    expect(await api.setSetting({ key: 't3Handoff', value }, m.app, SETTINGS_META)).toEqual(snap(false, value));
    expect(m.store.get('t3Handoff')).toBe(value);
  }
  expect(m.log).toEqual([
    ['store.set', 't3Handoff', 'send'],
    ['store.set', 't3Handoff', 'copy'],
    ['store.set', 't3Handoff', 'draft'],
  ]);
  m.log.length = 0;
  for (const value of ['auto', 'Send', '', true, null, 1]) expect({ value, r: await setSetting({ key: 't3Handoff', value }, m.app, SETTINGS_META) }).toEqual({ value, r: null });
  expect(await setSetting({ key: 't3Handoff', value: 'send' }, m.app, { window: 'main' })).toBeNull();
  expect(m.log).toEqual([]);
  expect(m.store.get('t3Handoff')).toBe('draft');
});

test("AC3: when the main window's main frame finishes loading, the current state is pushed; nothing else pushes", async () => {
  const m = await initMenu(true);
  m.log.length = 0;
  await onNavigate({ window: 'main', kind: 'finish', isMainFrame: true }, m.app);
  await onNavigate({ window: 'main', kind: 'finish' }, m.app);
  expect(m.log).toEqual([
    ['push', 'statusbar', { hidden: true }],
    ['push', 'statusbar', { hidden: true }],
  ]);
  m.log.length = 0;
  const others: MacNavEvent['kind'][] = ['policy', 'start', 'commit', 'fail', 'crash'];
  for (const kind of others) {
    await expect(onNavigate({ window: 'main', kind, isMainFrame: true }, m.app)).resolves.toBeUndefined();
  }
  await onNavigate({ window: 'main', kind: 'finish', isMainFrame: false }, m.app);
  await onNavigate({ window: 'other', kind: 'finish', isMainFrame: true }, m.app);
  expect(m.log).toEqual([]);
});

test('AC3: a page that finishes loading before the store is read gets the stored state', async () => {
  const hung: FakeProcess = { stdout: new ReadableStream<Uint8Array>(), kill: () => undefined, wait: never };
  fakeGlobals(
    () => hung,
    () => hung,
  );
  const m = menuApp(true);
  init(m.app);
  await onNavigate({ window: 'main', kind: 'finish', isMainFrame: true }, m.app);
  expect(m.log.filter((e) => e[0] === 'push')).toEqual([['push', 'statusbar', { hidden: true }]]);
});

// ---- a project's right-click menu ----

const PID = 'aaaaaaaaaaaa';
const ROOT = '/Users/me/code/factory';
const PROJECTS: MenuProject[] = [
  { id: PID, name: 'factory', root: ROOT },
  { id: 'bbbbbbbbbbbb', name: 'rootless', root: null },
];

/** A process that exits with `code`, having written `stderr`. */
const exited = (code: number, stderr = '') => ({
  stdout: null,
  stderr: { text: async () => stderr },
  kill: () => undefined,
  wait: async () => ({ exit_status: code, term_signal: null }),
});

/** Stand in `tjs` for the app check: `installed` apps answer `open -Ra` with 0, and `files` are executables. */
function fakeMachine(installed: string[], files: string[], home = '/Users/me'): string[][] {
  const spawned: string[][] = [];
  Reflect.set(globalThis, 'tjs', {
    env: { HOME: home },
    spawn: (argv: string[]) => {
      spawned.push(argv);
      const app = argv[2] ?? '';
      return exited(argv[0] === 'open' && argv[1] === '-Ra' && installed.includes(app) ? 0 : 1);
    },
    stat: async (path: string) => {
      if (!files.includes(path)) throw new Error('ENOENT');
      return { isFile: true, mode: 0o100755 };
    },
  });
  return spawned;
}

/** A fake app that records the context menu, the clipboard, reveals, and notifications. */
function contextApp(opts: { clipboard?: boolean; reveal?: Error } = {}): { app: MacApp; log: unknown[][] } {
  const m = menuApp(null);
  m.app.clipboard = {
    write: (data) => {
      m.log.push(['clipboard.write', data]);
      return opts.clipboard ?? true;
    },
  };
  m.app.shell.reveal = async (path) => {
    m.log.push(['shell.reveal', path]);
    if (opts.reveal !== undefined) throw opts.reveal;
    return true;
  };
  m.app.notify = async (title, body) => {
    m.log.push(['notify', title, body]);
    return true;
  };
  return { app: m.app, log: m.log };
}

const contexts = (log: unknown[][]): unknown[] => log.filter((e) => e[0] === 'menu.setContext').map((e) => e[1]);

test('AC1: the app check finds VS Code and Ghostty with open -Ra, and t3 at ~/.t3/bin/t3 before Homebrew', async () => {
  const spawned = fakeMachine(['Visual Studio Code'], ['/Users/me/.t3/bin/t3', '/opt/homebrew/bin/t3']);
  expect(await checkApps()).toEqual({ vscode: true, ghostty: false, t3: '/Users/me/.t3/bin/t3' });
  expect(spawned).toEqual([
    ['open', '-Ra', 'Visual Studio Code'],
    ['open', '-Ra', 'Ghostty'],
  ]);
  fakeMachine(['Ghostty'], ['/opt/homebrew/bin/t3']);
  expect(await checkApps()).toEqual({ vscode: false, ghostty: true, t3: '/opt/homebrew/bin/t3' });
  fakeMachine([], []);
  expect(await checkApps()).toEqual({ vscode: false, ghostty: false, t3: null });
  fakeMachine([], ['/Users/other/.t3/bin/t3'], '/Users/other');
  expect((await checkApps()).t3).toBe('/Users/other/.t3/bin/t3');
});

test("AC1: a listed project's request sets its menu, grayed out where the app check says so", async () => {
  fakeMachine(['Visual Studio Code'], ['/opt/homebrew/bin/t3']);
  const { app, log } = contextApp();
  await showProjectMenu({ project: PID }, app, PROJECTS);
  expect(contexts(log).at(-1)).toEqual(projectMenuItems(PID, { vscode: true, ghostty: false, t3: '/opt/homebrew/bin/t3' }));
  // the app check runs again on every request: Ghostty installed since
  fakeMachine(['Visual Studio Code', 'Ghostty'], ['/opt/homebrew/bin/t3']);
  log.length = 0;
  await showProjectMenu({ project: PID }, app, PROJECTS);
  expect(contexts(log)).toEqual([
    projectMenuItems(PID, { vscode: true, ghostty: false, t3: '/opt/homebrew/bin/t3' }), // at once, from the last check
    projectMenuItems(PID, { vscode: true, ghostty: true, t3: '/opt/homebrew/bin/t3' }), // then the fresh one
  ]);
});

test("AC2: null, an unknown id, or a rootless project restores WebKit's menu; a malformed request does nothing", async () => {
  fakeMachine([], []);
  const { app, log } = contextApp();
  for (const project of [null, 'zzzzzzzzzzzz', 'bbbbbbbbbbbb', ROOT]) await showProjectMenu({ project }, app, PROJECTS);
  expect(log).toEqual([
    ['menu.setContext', null],
    ['menu.setContext', null],
    ['menu.setContext', null],
    ['menu.setContext', null],
  ]);
  log.length = 0;
  for (const params of [undefined, null, PID, 42, { project: 42 }, { project: '' }, { root: ROOT }]) await showProjectMenu(params, app, PROJECTS);
  expect(log).toEqual([]);
});

test("AC2: a newer request wins over an older one's slower app check", async () => {
  fakeMachine([], []);
  const { app, log } = contextApp();
  await showProjectMenu({ project: PID }, app, PROJECTS); // warm the check
  fakeMachine(['Ghostty'], []); // the next check differs, so the older request would set the menu again
  log.length = 0;
  const first = showProjectMenu({ project: PID }, app, PROJECTS);
  const second = showProjectMenu({ project: null }, app, PROJECTS);
  await Promise.all([first, second]);
  expect(contexts(log).at(-1)).toBeNull();
});

test('AC2: the api names its methods, and with the app not following the service it lists no project', async () => {
  expect(Object.keys(api)).toEqual(['projectMenu', 'getSettings', 'setSetting', 'handOff', 'jobMenu']);
  fakeMachine([], []);
  const { app, log } = contextApp();
  await api.projectMenu({ project: PID }, app);
  expect(log).toEqual([['menu.setContext', null]]);
  log.length = 0;
  await onContextMenu(itemId('copy', PID), app);
  expect(log).toEqual([]);
});

const ok = async (): Promise<RunResult> => ({ ok: true, reason: '' });

test('AC2: each item runs its action on the looked-up root, and a success shows nothing', async () => {
  const { app, log } = contextApp();
  const ran: string[][] = [];
  const runner = async (argv: string[]): Promise<RunResult> => {
    ran.push(argv);
    return ok();
  };
  for (const item of ['copy', 'reveal', 'vscode', 't3', 'ghostty'] satisfies Parameters<typeof itemId>[0][]) await runProjectItem(itemId(item, PID), app, PROJECTS, '/Users/me/.t3/bin/t3', runner);
  expect(log).toEqual([
    ['clipboard.write', { text: ROOT }],
    ['shell.reveal', ROOT],
  ]);
  expect(ran).toEqual([
    ['open', '-a', 'Visual Studio Code', ROOT],
    ['/Users/me/.t3/bin/t3', 'app', ROOT],
    ['open', '-a', 'Ghostty', ROOT],
  ]);
});

test('AC2: an unknown project, a rootless one, an unknown item, or a non-string id runs nothing', async () => {
  const { app, log } = contextApp();
  const ran: string[][] = [];
  const runner = async (argv: string[]): Promise<RunResult> => {
    ran.push(argv);
    return ok();
  };
  for (const id of [itemId('copy', 'zzzzzzzzzzzz'), itemId('vscode', 'bbbbbbbbbbbb'), `project-menu:rm:${PID}`, 'statusbar', `project-menu:copy:${ROOT}`, null, 7]) {
    await runProjectItem(id, app, PROJECTS, '/x/t3', runner);
  }
  await runProjectItem(itemId('t3', PID), app, PROJECTS, null, runner);
  expect(log).toEqual([]);
  expect(ran).toEqual([]);
});

test('AC6: a failed action shows one notification naming the project, the app or action, and the reason, and logs it', async () => {
  const fail = (reason: string) => async (): Promise<RunResult> => ({ ok: false, reason });
  const cases: { id: string; app: ReturnType<typeof contextApp>; runner: () => Promise<RunResult>; text: string }[] = [
    { id: itemId('t3', PID), app: contextApp(), runner: fail('T3 Code is not running'), text: "Couldn't open factory in T3 Code: T3 Code is not running" },
    { id: itemId('vscode', PID), app: contextApp(), runner: fail('exited with status 1'), text: "Couldn't open factory in VS Code: exited with status 1" },
    { id: itemId('ghostty', PID), app: contextApp(), runner: fail('no Ghostty'), text: "Couldn't open factory in Ghostty: no Ghostty" },
    { id: itemId('reveal', PID), app: contextApp({ reveal: new Error('no such folder') }), runner: ok, text: "Couldn't reveal factory in Finder: no such folder" },
    { id: itemId('copy', PID), app: contextApp({ clipboard: false }), runner: ok, text: "Couldn't copy the path of factory: the clipboard refused the write" },
  ];
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (line: string) => void logged.push(line);
  try {
    for (const c of cases) {
      await runProjectItem(c.id, c.app.app, PROJECTS, '/x/t3', c.runner);
      expect(c.app.log.filter((e) => e[0] === 'notify')).toEqual([['notify', 'Andon', c.text]]);
    }
  } finally {
    console.log = realLog;
  }
  expect(logged).toEqual(cases.map((c) => `andon: ${c.text}`));
});

test("AC6: a command's non-zero exit is a failure with its stderr as the reason, run under the app's environment", async () => {
  Reflect.set(globalThis, 'tjs', {
    env: { HOME: '/Users/me' },
    spawn: () => exited(1, 'Error: T3 Code is not running\n'),
    stat: async () => {
      throw new Error('ENOENT');
    },
  });
  const { app, log } = contextApp();
  await runProjectItem(itemId('t3', PID), app, PROJECTS, '/x/t3');
  expect(log).toEqual([['notify', 'Andon', "Couldn't open factory in T3 Code: Error: T3 Code is not running"]]);
  Reflect.set(globalThis, 'tjs', {
    env: {},
    spawn: () => {
      throw new Error('spawn failed');
    },
  });
  const b = contextApp();
  await runProjectItem(itemId('ghostty', PID), b.app, PROJECTS, null);
  expect(b.log).toEqual([['notify', 'Andon', "Couldn't open factory in Ghostty: spawn failed"]]);
  Reflect.set(globalThis, 'tjs', { env: {}, spawn: () => exited(0) });
  const c = contextApp();
  await runProjectItem(itemId('vscode', PID), c.app, PROJECTS, null);
  expect(c.log).toEqual([]);
});

// ---- the T3 Code hand-off (036) ----

const MAIN_META = { window: 'main', origin: 'http://127.0.0.1:8766' };
const JOB = '036-t3-handoff';
const T3 = '/Users/me/.t3/bin/t3';

/** A fake host: the listed projects, the `t3` found, the `origin` git gives, and a runner that records every argv. */
function fakeHost(opts: { t3?: string | null; origin?: string | null; run?: RunResult } = {}): { host: HandoffHost; ran: string[][]; origins: string[] } {
  const ran: string[][] = [];
  const origins: string[] = [];
  const host: HandoffHost = {
    projects: () => PROJECTS,
    findT3: async () => (opts.t3 === undefined ? T3 : opts.t3),
    origin: async (root) => {
      origins.push(root);
      return opts.origin === undefined ? 'git@github.com:mattmccray/factory.git\n' : opts.origin;
    },
    run: async (argv) => {
      ran.push(argv);
      return opts.run ?? { ok: true, reason: '' };
    },
  };
  return { host, ran, origins };
}

/** A context app with the T3 Code choice stored. */
function handoffApp(mode: unknown): ReturnType<typeof contextApp> {
  const c = contextApp();
  c.app.store = {
    get: async (key) => (key === 't3Handoff' ? mode : null),
    set: async (key, value) => c.log.push(['store.set', key, value]) > 0,
  };
  return c;
}

const APPROVE = { project: PID, job: JOB, action: 'approve' };

test('036 AC3: draft mode with a GitHub origin opens exactly the prompt link, and answers drafted', async () => {
  for (const mode of ['draft', null, 'nonsense']) {
    const { app, log } = handoffApp(mode);
    const h = fakeHost();
    expect(await handOff(APPROVE, app, MAIN_META, h.host)).toBe('drafted');
    expect(h.origins).toEqual([ROOT]);
    expect(h.ran).toEqual([['open', 't3code://new?prompt=%2Ffactory%20approve%20036-t3-handoff&repo=mattmccray/factory']]);
    expect(log).toEqual([]);
  }
  const { app } = handoffApp('draft');
  const h = fakeHost({ origin: 'https://github.com/mattmccray/factory' });
  expect(await handOff({ project: PID, job: JOB, action: 'rework', note: 'add "the" test' }, app, MAIN_META, h.host)).toBe('drafted');
  expect(h.ran).toEqual([['open', `t3code://new?prompt=${encodeURIComponent('/factory rework 036-t3-handoff "add \\"the\\" test"')}&repo=mattmccray/factory`]]);
});

test('036 AC3: draft mode with no GitHub origin opens nothing and answers no-github-remote', async () => {
  for (const origin of [null, '', 'https://gitlab.com/a/b.git\n', '/Users/me/code/factory\n']) {
    const { app, log } = handoffApp('draft');
    const h = fakeHost({ origin });
    expect({ origin, r: await handOff(APPROVE, app, MAIN_META, h.host) }).toEqual({ origin, r: 'no-github-remote' });
    expect(h.ran).toEqual([]);
    expect(log).toEqual([]);
  }
});

test('036 AC3: a failed open notifies and answers copy-only', async () => {
  const { app, log } = handoffApp('draft');
  const h = fakeHost({ run: { ok: false, reason: 'no application knows t3code:' } });
  const realLog = console.log;
  console.log = () => undefined;
  try {
    expect(await handOff(APPROVE, app, MAIN_META, h.host)).toBe('copy-only');
  } finally {
    console.log = realLog;
  }
  expect(log).toEqual([['notify', 'Andon', "Couldn't open a draft in T3 Code: no application knows t3code:"]]);
});

test('036 AC4: send mode runs exactly the t3 thread start argv with the listed root, and answers sent', async () => {
  const { app, log } = handoffApp('send');
  const h = fakeHost();
  expect(await handOff(APPROVE, app, MAIN_META, h.host)).toBe('sent');
  expect(await handOff({ project: PID, job: JOB, action: 'abandon', note: 'superseded by 040' }, app, MAIN_META, h.host)).toBe('sent');
  expect(h.ran).toEqual([
    [T3, 'thread', 'start', '--title', 'approve 036-t3-handoff', ROOT, '/factory approve 036-t3-handoff'],
    [T3, 'thread', 'start', '--title', 'abandon 036-t3-handoff', ROOT, '/factory abandon 036-t3-handoff "superseded by 040"'],
  ]);
  expect(h.origins).toEqual([]);
  expect(log).toEqual([]);
});

test('036 AC4: a failed send notifies "Couldn\'t send to T3 Code: <reason>" and answers copy-only', async () => {
  const { app, log } = handoffApp('send');
  const h = fakeHost({ run: { ok: false, reason: 'Error: T3 Code is not running' } });
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (line: string) => void logged.push(line);
  try {
    expect(await handOff(APPROVE, app, MAIN_META, h.host)).toBe('copy-only');
  } finally {
    console.log = realLog;
  }
  expect(log).toEqual([['notify', 'Andon', "Couldn't send to T3 Code: Error: T3 Code is not running"]]);
  expect(logged).toEqual(["andon: Couldn't send to T3 Code: Error: T3 Code is not running"]);
});

test('036 AC4: with the host runner, a non-zero exit gives its last stderr line, and a spawn error its message', async () => {
  const spawned: string[][] = [];
  const machine = (spawn: (argv: string[]) => unknown): void => {
    Reflect.set(globalThis, 'tjs', {
      env: { HOME: '/Users/me' },
      spawn: (argv: string[]) => {
        spawned.push(argv);
        return spawn(argv);
      },
      stat: async (path: string) => {
        if (path !== T3) throw new Error('ENOENT');
        return { isFile: true, mode: 0o100755 };
      },
    });
  };
  const host: HandoffHost = { ...hostHandoff, projects: () => PROJECTS };
  const realLog = console.log;
  console.log = () => undefined;
  try {
    machine(() => exited(1, 'starting\nError: unknown project\n'));
    expect(await findT3()).toBe(T3);
    const a = handoffApp('send');
    expect(await handOff(APPROVE, a.app, MAIN_META, host)).toBe('copy-only');
    expect(a.log).toEqual([['notify', 'Andon', "Couldn't send to T3 Code: Error: unknown project"]]);
    expect(spawned).toEqual([[T3, 'thread', 'start', '--title', 'approve 036-t3-handoff', ROOT, '/factory approve 036-t3-handoff']]);
    machine(() => {
      throw new Error('spawn failed');
    });
    const b = handoffApp('send');
    expect(await handOff(APPROVE, b.app, MAIN_META, host)).toBe('copy-only');
    expect(b.log).toEqual([['notify', 'Andon', "Couldn't send to T3 Code: spawn failed"]]);
  } finally {
    console.log = realLog;
  }
});

test('036 AC3: with the host runner, git is asked for the origin as an argv, and its stdout read', async () => {
  const spawned: string[][] = [];
  Reflect.set(globalThis, 'tjs', {
    env: { HOME: '/Users/me' },
    spawn: (argv: string[]) => {
      spawned.push(argv);
      const git = argv[0] === 'git';
      return { stdout: git ? { text: async () => 'https://github.com/mattmccray/factory.git\n' } : null, stderr: null, kill: () => undefined, wait: async () => ({ exit_status: 0, term_signal: null }) };
    },
    stat: async () => ({ isFile: true, mode: 0o100755 }),
  });
  const { app, log } = handoffApp('draft');
  expect(await handOff(APPROVE, app, MAIN_META, { ...hostHandoff, projects: () => PROJECTS })).toBe('drafted');
  expect(spawned).toEqual([
    ['git', '-C', ROOT, 'remote', 'get-url', 'origin'],
    ['open', 't3code://new?prompt=%2Ffactory%20approve%20036-t3-handoff&repo=mattmccray/factory'],
  ]);
  expect(log).toEqual([]);
});

test('036 AC5: copy mode, or no t3, runs and opens nothing and answers copy-only', async () => {
  for (const [mode, t3] of [['copy', T3], ['draft', null], ['send', null], ['copy', null]] as const) {
    const { app, log } = handoffApp(mode);
    const h = fakeHost({ t3 });
    expect({ mode, t3, r: await handOff(APPROVE, app, MAIN_META, h.host) }).toEqual({ mode, t3, r: 'copy-only' });
    expect(h.ran).toEqual([]);
    expect(h.origins).toEqual([]);
    expect(log).toEqual([]);
  }
});

test('036 AC1: a refused request, or a call from any window but main, runs, opens, and notifies nothing', async () => {
  const requests: unknown[] = [
    null,
    { project: 'zzzzzzzzzzzz', job: JOB, action: 'approve' },
    { project: 'bbbbbbbbbbbb', job: JOB, action: 'approve' },
    { project: PID, job: '36-x', action: 'approve' },
    { project: PID, job: JOB, action: 'merge' },
    { project: PID, job: JOB, action: 'rework', note: '  ' },
    { project: PID, job: JOB, action: 'abandon', note: 'x'.repeat(8000) },
    { project: PID, job: JOB, action: 'approve', command: 'rm -rf /' },
  ];
  for (const mode of ['draft', 'send']) {
    for (const params of requests) {
      const { app, log } = handoffApp(mode);
      const h = fakeHost();
      expect({ mode, params, r: await handOff(params, app, MAIN_META, h.host) }).toEqual({ mode, params, r: null });
      expect(h.ran).toEqual([]);
      expect(h.origins).toEqual([]);
      expect(log).toEqual([]);
    }
    for (const meta of [{ window: 'settings' }, { window: 'other' }, {}, null, undefined, 'main']) {
      const { app, log } = handoffApp(mode);
      const h = fakeHost();
      expect(await handOff(APPROVE, app, meta, h.host)).toBeNull();
      expect(await api.handOff(APPROVE, app, meta)).toBeNull();
      expect(h.ran).toEqual([]);
      expect(log).toEqual([]);
    }
  }
});

test('036: a second hand-off while one is running is dropped', async () => {
  const { app } = handoffApp('send');
  let release: () => void = () => undefined;
  const ran: string[][] = [];
  const host: HandoffHost = {
    ...fakeHost().host,
    run: (argv) => {
      ran.push(argv);
      return new Promise((r) => (release = () => r({ ok: true, reason: '' })));
    },
  };
  const first = handOff(APPROVE, app, MAIN_META, host);
  await new Promise((r) => setTimeout(r, 1));
  expect(await handOff(APPROVE, app, MAIN_META, host)).toBeNull();
  release();
  expect(await first).toBe('sent');
  expect(ran).toHaveLength(1);
  // and the next one runs again
  const next = handOff(APPROVE, app, MAIN_META, host);
  await new Promise((r) => setTimeout(r, 1));
  release();
  expect(await next).toBe('sent');
});

test('036: with the app not following the service, the api lists no project, so nothing runs', async () => {
  const { app, log } = handoffApp('send');
  expect(await api.handOff(APPROVE, app, MAIN_META)).toBeNull();
  expect(log).toEqual([]);
});

// ---- a job's right-click menu (040) ----

const MENU_JOB = '040-job-context-menu';
const GOOD_SESSION = { app: 't3code', environment: 'env-1', thread: 'thread-A' };
const LINK = 't3code://threads/env-1/thread-A';

/** A context app that also records `shell.open`, which can fail by throwing or by not reporting true. */
function jobApp(opts: { open?: Error | 'false'; clipboard?: boolean | Error } = {}): ReturnType<typeof contextApp> {
  const c = contextApp({ clipboard: typeof opts.clipboard === 'boolean' ? opts.clipboard : true });
  const fail = opts.clipboard;
  if (fail instanceof Error) {
    c.app.clipboard = {
      write: () => {
        throw fail;
      },
    };
  }
  // Tiny types it Promise<true>; stand in a bridge that also reports failure by resolving false.
  Reflect.set(c.app.shell, 'open', async (target: string): Promise<boolean> => {
    c.log.push(['shell.open', target]);
    if (opts.open instanceof Error) throw opts.open;
    return opts.open !== 'false';
  });
  return c;
}

/** A fake job menu host: the listed projects, the boards the service gives (by project), and the `t3` found. */
function jobHost(opts: { board?: unknown; boardError?: Error; t3?: string | null } = {}): { host: JobMenuHost; fetched: string[] } {
  const fetched: string[] = [];
  const host: JobMenuHost = {
    projects: () => PROJECTS,
    board: async (pid) => {
      fetched.push(pid);
      if (opts.boardError !== undefined) throw opts.boardError;
      return opts.board === undefined ? { jobs: [{ id: '039-other', session: { app: 't3code', environment: 'env-9', thread: 'other' } }, { id: MENU_JOB, stage: 'build', session: GOOD_SESSION }] } : opts.board;
    },
    findT3: async () => (opts.t3 === undefined ? T3 : opts.t3),
  };
  return { host, fetched };
}

const opened = (log: unknown[][]): unknown[] => log.filter((e) => e[0] === 'shell.open').map((e) => e[1]);
const quietly = async (f: () => Promise<void>): Promise<string[]> => {
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (line: string) => void logged.push(line);
  try {
    await f();
  } finally {
    console.log = realLog;
  }
  return logged;
};

test('040 AC1: a job with a session and t3 found gets Open in T3 Code (enabled), a separator, and Copy Job ID', async () => {
  const { app, log } = jobApp();
  const h = jobHost();
  await showJobMenu({ project: PID, job: MENU_JOB }, app, h.host);
  expect(h.fetched).toEqual([PID]);
  expect(contexts(log).at(-1)).toEqual([
    { id: `job-menu:t3:${PID}:${MENU_JOB}`, label: 'Open in T3 Code', enabled: true },
    { separator: true },
    { id: `job-menu:copy:${PID}:${MENU_JOB}`, label: 'Copy Job ID' },
  ]);
});

test('040 AC1: Open in T3 Code opens the link from the fetched board, and Copy Job ID copies the job id', async () => {
  const { app, log } = jobApp();
  const h = jobHost();
  await runJobItem(jobItemId('t3', PID, MENU_JOB), app, h.host);
  await runJobItem(jobItemId('copy', PID, MENU_JOB), app, h.host);
  expect(log).toEqual([
    ['shell.open', LINK],
    ['clipboard.write', { text: MENU_JOB }],
  ]);
  expect(h.fetched).toEqual([PID]); // the click fetched the board again; the copy needs none
});

test('040 AC1: the same job asked again (the opening press) keeps its menu, set again only when the answer changes', async () => {
  const { app, log } = jobApp();
  let t3: string | null = T3;
  const h: JobMenuHost = { ...jobHost().host, findT3: async () => t3 };
  await showJobMenu({ project: PID, job: MENU_JOB }, app, h);
  log.length = 0;
  await showJobMenu({ project: PID, job: MENU_JOB }, app, h);
  expect(contexts(log)).toEqual([]);
  t3 = null; // t3 removed since
  await showJobMenu({ project: PID, job: MENU_JOB }, app, h);
  expect(contexts(log)).toEqual([jobMenuItems(PID, MENU_JOB, false)]);
  const hh = jobHost();
  // a different job is armed at once (grayed), then answered
  log.length = 0;
  await showJobMenu({ project: PID, job: '039-other' }, app, hh.host);
  expect(contexts(log)).toEqual([jobMenuItems(PID, '039-other', false), jobMenuItems(PID, '039-other', true)]);
});

test('040 AC2: no session, a null or malformed one, or no t3 grays Open in T3 Code out; Copy Job ID stays; the grayed item opens nothing', async () => {
  const sessions: unknown[] = [
    undefined,
    null,
    { ...GOOD_SESSION, app: 'codex' },
    { app: 't3code', environment: 'env-1' },
    { ...GOOD_SESSION, thread: '' },
    { ...GOOD_SESSION, thread: 'a'.repeat(65) },
    { ...GOOD_SESSION, thread: 'thread/A' },
    { ...GOOD_SESSION, environment: 'env:1' },
    't3code:env-1/thread-A',
  ];
  const cases: { label: string; h: ReturnType<typeof jobHost> }[] = sessions.map((session) => ({
    label: JSON.stringify(session) ?? 'undefined',
    h: jobHost({ board: { jobs: [session === undefined ? { id: MENU_JOB } : { id: MENU_JOB, session }] } }),
  }));
  cases.push({ label: 'no t3', h: jobHost({ t3: null }) });
  for (const c of cases) {
    const { app, log } = jobApp();
    await quietly(async () => {
      await showJobMenu(null, app, c.h.host); // disarm: the last case armed this same job
      log.length = 0;
      await showJobMenu({ project: PID, job: MENU_JOB }, app, c.h.host);
      expect({ c: c.label, menu: contexts(log).at(-1) }).toEqual({ c: c.label, menu: jobMenuItems(PID, MENU_JOB, false) });
      await runJobItem(jobItemId('t3', PID, MENU_JOB), app, c.h.host);
      expect({ c: c.label, opened: opened(log) }).toEqual({ c: c.label, opened: [] });
      await runJobItem(jobItemId('copy', PID, MENU_JOB), app, c.h.host);
    });
    expect(log.filter((e) => e[0] === 'clipboard.write')).toEqual([['clipboard.write', { text: MENU_JOB }]]);
  }
});

test('040 AC3: an unknown project, a malformed job id, or extra page fields restore WebKit\'s menu and fetch nothing', async () => {
  for (const params of [
    { project: 'zzzzzzzzzzzz', job: MENU_JOB },
    { project: PID, job: 'job-context-menu' },
    { project: PID, job: '040-Bad' },
    { project: PID, job: MENU_JOB, thread: 'thread-B' },
    { project: PID, job: MENU_JOB, url: 't3code://threads/evil/x' },
    { project: PID },
    null,
    'x',
  ]) {
    const { app, log } = jobApp();
    const h = jobHost();
    await showJobMenu(params, app, h.host);
    expect({ params, log }).toEqual({ params, log: [['menu.setContext', null]] });
    expect(h.fetched).toEqual([]);
  }
});

test("040 AC3: a job missing from the board restores WebKit's menu; a failed fetch keeps it grayed", async () => {
  const a = jobApp();
  await showJobMenu({ project: PID, job: '041-missing' }, a.app, jobHost().host);
  expect(contexts(a.log)).toEqual([jobMenuItems(PID, '041-missing', false), null]);
  const b = jobApp();
  const logged = await quietly(() => showJobMenu({ project: PID, job: MENU_JOB }, b.app, jobHost({ boardError: new Error('connection refused') }).host));
  expect(contexts(b.log)).toEqual([jobMenuItems(PID, MENU_JOB, false)]);
  expect(logged).toEqual([`andon: could not fetch the board for the job menu of ${MENU_JOB} (connection refused)`]);
});

test('040 AC3: a forged or unresolvable item id opens nothing; a job missing or a failed fetch on click notifies and opens nothing', async () => {
  for (const id of [jobItemId('t3', 'zzzzzzzzzzzz', MENU_JOB), `job-menu:t3:${PID}:Bad`, `job-menu:t3:${PID}:${MENU_JOB}:${LINK}`, `job-menu:open:${PID}:${MENU_JOB}`, null, 7]) {
    const { app, log } = jobApp();
    const h = jobHost();
    await runJobItem(id, app, h.host);
    expect({ id, log }).toEqual({ id, log: [] });
    expect(h.fetched).toEqual([]);
  }
  const cases: { h: ReturnType<typeof jobHost>; job: string; text: string }[] = [
    { h: jobHost(), job: '041-missing', text: "Couldn't open 041-missing in T3 Code: the job is not on its board" },
    { h: jobHost({ board: { jobs: [{ id: MENU_JOB }] } }), job: MENU_JOB, text: `Couldn't open ${MENU_JOB} in T3 Code: the job has no T3 Code thread recorded` },
    { h: jobHost({ boardError: new Error('HTTP 500') }), job: MENU_JOB, text: `Couldn't open ${MENU_JOB} in T3 Code: HTTP 500` },
  ];
  for (const c of cases) {
    const { app, log } = jobApp();
    const logged = await quietly(() => runJobItem(jobItemId('t3', PID, c.job), app, c.h.host));
    expect(log).toEqual([['notify', 'Andon', c.text]]);
    expect(logged).toEqual([`andon: ${c.text}`]);
  }
});

test('040 AC3: page-supplied values never reach shell.open: the link is only the fresh board\'s session', async () => {
  const { app, log } = jobApp();
  // the board changed between the menu and the click: the click uses the fresh one
  let board: unknown = { jobs: [{ id: MENU_JOB, session: GOOD_SESSION }] };
  const host: JobMenuHost = { projects: () => PROJECTS, board: async () => board, findT3: async () => T3 };
  await showJobMenu({ project: PID, job: MENU_JOB, thread: 'evil', url: 'https://evil.example' }, app, host);
  await api.jobMenu({ project: PID, job: MENU_JOB, thread: 'evil' }, app);
  board = { jobs: [{ id: MENU_JOB, session: { app: 't3code', environment: 'env-2', thread: 'thread-B' } }] };
  await runJobItem(jobItemId('t3', PID, MENU_JOB), app, host);
  expect(opened(log)).toEqual(['t3code://threads/env-2/thread-B']);
  // a forged t3 item id for a job without a valid session opens nothing
  board = { jobs: [{ id: MENU_JOB, session: { app: 't3code', environment: 'env-1', thread: '../../evil' } }] };
  log.length = 0;
  await quietly(() => runJobItem(jobItemId('t3', PID, MENU_JOB), app, host));
  expect(opened(log)).toEqual([]);
});

test('040 AC4: a throwing or failing shell.open notifies once and logs; so does a failed clipboard write', async () => {
  const cases: { c: ReturnType<typeof jobApp>; item: 't3' | 'copy'; text: string }[] = [
    { c: jobApp({ open: new Error('no application knows t3code:') }), item: 't3', text: `Couldn't open ${MENU_JOB} in T3 Code: no application knows t3code:` },
    { c: jobApp({ open: 'false' }), item: 't3', text: `Couldn't open ${MENU_JOB} in T3 Code: T3 Code did not open the link` },
    { c: jobApp({ clipboard: false }), item: 'copy', text: `Couldn't copy the job ID ${MENU_JOB}: the clipboard refused the write` },
    { c: jobApp({ clipboard: new Error('pasteboard busy') }), item: 'copy', text: `Couldn't copy the job ID ${MENU_JOB}: pasteboard busy` },
  ];
  for (const { c, item, text } of cases) {
    const logged = await quietly(() => runJobItem(jobItemId(item, PID, MENU_JOB), c.app, jobHost().host));
    expect(c.log.filter((e) => e[0] === 'notify')).toEqual([['notify', 'Andon', text]]);
    expect(logged).toEqual([`andon: ${text}`]);
  }
});

test('040 AC5: onContextMenu sends job-menu ids to the job menu and project-menu ids to the project menu', async () => {
  // with the app not following the service, no project is listed: neither menu runs anything
  fakeMachine([], []);
  const { app, log } = jobApp();
  await onContextMenu(jobItemId('copy', PID, MENU_JOB), app);
  await onContextMenu(itemId('copy', PID), app);
  expect(log).toEqual([]);
  // the real host fetches no board without a listed project, and refuses one with no service
  await api.jobMenu({ project: PID, job: MENU_JOB }, app);
  expect(log).toEqual([['menu.setContext', null]]);
  await expect(hostJobMenu.board(PID)).rejects.toThrow();
});

test('040: a newer ask of either menu wins over a slower board fetch', async () => {
  const { app, log } = jobApp();
  let release: () => void = () => undefined;
  const host: JobMenuHost = {
    projects: () => PROJECTS,
    board: () => new Promise((r) => (release = () => r({ jobs: [{ id: MENU_JOB, session: GOOD_SESSION }] }))),
    findT3: async () => T3,
  };
  fakeMachine([], []);
  const slow = showJobMenu({ project: PID, job: MENU_JOB }, app, host);
  await showProjectMenu({ project: null }, app, PROJECTS);
  release();
  await slow;
  expect(contexts(log)).toEqual([jobMenuItems(PID, MENU_JOB, false), null]);
});
