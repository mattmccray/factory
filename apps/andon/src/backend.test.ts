// The adapter against a fake Tiny app. onTray and the lantern hooks touch no Tiny or txiki
// globals; the init tests stand in fake `tjs` and `__ANDON_REPO__` globals.
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { assetPath, dockIcon, init, onMenu, onNavigate, onTray, reloadScript, setDock, setTray, trayIcon } from './backend';
import type { MacApp, MacNavEvent, MacTraySpec, MacWinState } from './backend';
import { GITHUB_ID, MINIMIZE_ID, SETTINGS_ID, SHOW_MAIN_ID, STATUS_BAR_ID, ZOOM_ID, appMenu } from './appmenu';
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
    }),
    setHideOnClose: () => calls.push('setHideOnClose'),
    quit: () => calls.push('quit'),
    push: () => calls.push('push'),
    menu: { set: () => calls.push('menu.set'), update: () => calls.push('menu.update') },
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
    },
  };
  return { app, calls };
}

// The adapter reads only `minimized`, `fullscreen`, and `allSpaces`; Tiny's `visible` and `focused`
// play no part (rework 2), so a window in front and one hidden look the same to it.
const st = (minimized: boolean, fullscreen = false): MacWinState => ({ minimized, fullscreen, allSpaces: false });
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

/** A fake app that records the menu bar, the store, the pushes, and the shell, with `stored` as the
 *  status bar choice in the store. */
function menuApp(stored: unknown): { app: MacApp; log: unknown[][]; store: Map<string, unknown> } {
  const log: unknown[][] = [];
  const store = new Map<string, unknown>([['statusBarHidden', stored]]);
  const { app } = fakeApp(st(false));
  app.menu = { set: (menus) => void log.push(['menu.set', menus]), update: (id, patch) => void log.push(['menu.update', id, patch]) };
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
  };
  app.window = (id) => ({
    getState: async () => st(false),
    restore: () => log.push([`${id}.restore`]),
    setAllSpaces: (on) => log.push([`${id}.allSpaces`, on]),
    show: () => log.push([`${id}.show`]),
    eval: () => log.push([`${id}.eval`]),
    minimize: () => log.push([`${id}.minimize`]),
    zoom: () => log.push([`${id}.zoom`]),
  });
  return { app, log, store };
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
    ['menu.update', STATUS_BAR_ID, { label: 'Show Status Bar' }],
    ['push', 'statusbar', { hidden: true }],
    ['store.set', 'statusBarHidden', true],
  ]);
  m.log.length = 0;
  await onMenu(STATUS_BAR_ID, m.app);
  expect(m.log).toEqual([
    ['menu.update', STATUS_BAR_ID, { label: 'Hide Status Bar' }],
    ['push', 'statusbar', { hidden: false }],
    ['store.set', 'statusBarHidden', false],
  ]);
  expect(m.store.get('statusBarHidden')).toBe(false);
});

test('AC3: a toggle after a relaunch starts from the stored state', async () => {
  const m = await initMenu(true);
  m.log.length = 0;
  await onMenu(STATUS_BAR_ID, m.app);
  expect(m.log[0]).toEqual(['menu.update', STATUS_BAR_ID, { label: 'Hide Status Bar' }]);
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

test('AC3: Settings… and unknown ids do nothing', async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  for (const id of [SETTINGS_ID, 'about', 'nope']) await onMenu(id, m.app);
  expect(m.log).toEqual([]);
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
