// The adapter against a fake Tiny app. onTray and the lantern hooks touch no Tiny or txiki
// globals; the init tests stand in fake `tjs` and `__ANDON_REPO__` globals.
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { closeAbout, getAbout, api, startWork, assetPath, checkApps, checkFound, dockIcon, findAppBundle, findT3, lookupIcon, getSettings, handOff, hostHandoff, hostJobMenu, init, onContextMenu, runEpicItem, runJobItem, showEpicMenu, showJobMenu, onMenu, onNavigate, onTray, reloadScript, runProjectItem, setDock, setSetting, setTray, setViewState, showProjectMenu, trayIcon } from './backend';
import type { HandoffHost, JobMenuHost, StartWorkHost, MacApp, MacNavEvent, MacTraySpec, MacWinState, RunResult } from './backend';
import { itemId, projectMenuItems } from './projectmenu';
import { epicItemId, epicMenuItems } from './epicmenu';
import { jobItemId, jobMenuItems, threadLink } from './jobmenu';
import type { Availability, MenuProject } from './projectmenu';
import type { HandoffMode, Settings } from './settings';
import { ABOUT_ID, ABOUT_SIZE, CLOSE_WINDOW_ID, NEW_EXPLORATION_ID, GITHUB_URL, aboutWindow, DEFAULT_VIEW, GITHUB_ID, INSPECTOR_ID, MERGED_ID, MINIMIZE_ID, NEEDS_ME_ID, SETTINGS_ID, SETTINGS_SIZE, SETTLED_ID, SHOW_MAIN_ID, SIDEBAR_ID, STATUS_BAR_ID, WHATS_NEW_ID, ZOOM_ID, appMenu, settingsWindow } from './appmenu';
import type { MenuState } from './appmenu';
import { QUIT_ID, trayNotice, traySpec } from './badge';
import { INSTALL_NOTICE, PROBE_MS } from './autostart';
import { noServicePage } from './noservice';

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
      setSize: (w, h) => calls.push(`${id}.setSize(${w}x${h})`),
      close: () => calls.push(`${id}.close`),
      hide: (opts) => calls.push(`${id}.hide(${JSON.stringify(opts)})`),
    }),
    windows: async () => ['main'],
    win: { open: (id) => calls.push(`win.open(${id})`) },
    setHideOnClose: () => calls.push('setHideOnClose'),
    quit: () => calls.push('quit'),
    reload: async () => void calls.push('reload'),
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
    thumbnail: async (path) => {
      calls.push(`thumbnail(${path})`);
      throw new Error('no thumbnails here');
    },
  };
  return { app, calls };
}

// The tray click reads only `minimized`, `fullscreen`, and `allSpaces`; Tiny's `visible` and `focused`
// play no part in it (rework 2), so a window in front and one hidden look the same to it. Settings…'s
// bring-back step also reads `visible` (037). Close Window reads `focused` (073), set per window by menuApp's `focus`.
const st = (minimized: boolean, fullscreen = false, visible = true): MacWinState => ({ minimized, fullscreen, allSpaces: false, visible, focused: false, ...FRAME });
/** The main window's frame in every `st` state (077): a 1280x820 window at (200, 100) on a 1728x1117 screen at the origin. */
const FRAME = { x: 200, y: 100, width: 1280, height: 820, outer: { width: 1280, height: 820 }, screen: { width: 1728, height: 1117, scale: 2 }, local: { x: 200, y: 100 } };
/** Where Settings (480x360) and About (440x400) open, centered on FRAME (077 AC3). */
const SETTINGS_AT = { x: 200 + 400, y: 100 + 230 };
const ABOUT_AT = { x: 200 + 420, y: 100 + 210 };
/** After a child window opens: its fixed size set (over any size Tiny remembered), then not resizable. */
const settingsFixed: unknown[][] = [['settings.setSize', 480, 360], ['settings.resizable', false]];
const aboutFixed: unknown[][] = [['about.setSize', 440, 400], ['about.resizable', false]];
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

// ---- init: the idle look before the service answers, and the install notice when none does ----

interface FakeProcess {
  stdout: ReadableStream<Uint8Array> | null;
  kill(): void;
  wait(): Promise<{ exit_status: number; term_signal: string | null }>;
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** Stand in txiki's `tjs` and the build-time repo path. Every spawn is recorded; `curl` runs `curl`, and any other spawn (the app checks) throws. */
function fakeGlobals(curl: () => FakeProcess, spawned: string[][] = []): void {
  Reflect.set(globalThis, '__ANDON_REPO__', REPO);
  Reflect.set(globalThis, 'tjs', {
    env: {},
    spawn: (argv: string[]) => {
      spawned.push(argv);
      if (argv[0] !== 'curl') throw new Error(`unexpected spawn: ${argv.join(' ')}`);
      return curl();
    },
  });
}

afterEach(() => {
  for (const k of ['__ANDON_REPO__', '__ANDON_VERSION__', 'tjs']) Reflect.deleteProperty(globalThis, k);
});

/** The Dock is idle (never set, or reset with '') and the badge is clear (never set, or ''). */
function expectIdle(l: ReturnType<typeof lanternApp>): void {
  expect(l.icons.every((p) => p === '')).toBe(true);
  expect(l.badges.every((t) => t === '')).toBe(true);
}

test('AC5: before the service answers, the tray shows the notice with the outlined lantern, and the Dock is idle', () => {
  const hung: FakeProcess = { stdout: new ReadableStream<Uint8Array>(), kill: () => undefined, wait: never };
  fakeGlobals(() => hung);
  const l = lanternApp();
  init(l.app);
  expect(l.trays).toEqual([{ ...trayNotice('connecting to the Andon service'), icon: join(ASSETS, 'tray-idle.png'), template: true }]);
  expectIdle(l);
});

test('062 AC8: with no service answering, the tray names factory service install, the Dock is idle, nothing but curl is spawned, and Quit stops nothing', async () => {
  const unreachable = (): FakeProcess => ({
    stdout: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    kill: () => undefined,
    wait: async () => ({ exit_status: 7, term_signal: null }),
  });
  const spawned: string[][] = [];
  fakeGlobals(unreachable, spawned);
  const l = lanternApp();
  init(l.app);
  for (let i = 0; i < 50 && l.trays.length < 2; i++) await new Promise((r) => setTimeout(r, 2));
  expect(l.trays).toHaveLength(2);
  expect(l.trays.at(-1)).toMatchObject({ ...trayNotice(INSTALL_NOTICE), icon: join(ASSETS, 'tray-idle.png'), template: true });
  expect(String(l.trays.at(-1)?.tooltip)).toContain('factory service install');
  expectIdle(l);
  // curl probes the service, and `open`/`mdfind` check the Open in apps: nothing else runs (no bun, no service)
  const notOurs = (a: string[]): boolean => !['curl', 'open', 'mdfind'].includes(a[0] ?? '');
  expect(spawned.some((a) => a[0] === 'curl')).toBe(true);
  expect(spawned.filter(notOurs)).toEqual([]);
  expect(spawned.some((a) => a.some((x) => x.includes('andon-service') || x === 'service'))).toBe(false);
  const before = spawned.length;
  await onTray(QUIT_ID, l.app);
  expect(spawned.slice(before).filter(notOurs)).toEqual([]);
});

test('062 AC8: backend.ts starts and stops no service: no spawn command for it, no child handling', async () => {
  const src = await Bun.file(join(import.meta.dir, 'backend.ts')).text();
  for (const gone of ['serviceCommand', 'ensureService', 'spawnChild', 'Child', '__ANDON_BUN__', 'andon-service']) expect({ gone, found: src.includes(gone) }).toEqual({ gone, found: false });
  expect(src).toContain('waitForService');
});

test('the reload after starting the service (or on another port) keeps ?shell=mac', () => {
  expect(reloadScript(8766)).toBe('location.replace("http://127.0.0.1:8766/?shell=mac")');
  expect(reloadScript(9123)).toBe('location.replace("http://127.0.0.1:9123/?shell=mac")');
});

// ---- 071: the no-service page in the main window, and the switch to the board ----

/** A curl that answers `GET /projects` with 200 `[]` while `up.on`, and is refused while not.
 *  `GET /events` answers one `projects` event with no projects and stays open, so the started app shows its
 *  tray and idles; anything else hangs. */
function serviceCurl(up: { on: boolean }, spawned: string[][]): void {
  Reflect.set(globalThis, '__ANDON_REPO__', REPO);
  Reflect.set(globalThis, 'tjs', {
    env: {},
    spawn: (argv: string[]): FakeProcess => {
      spawned.push(argv);
      if (argv[0] !== 'curl') throw new Error(`unexpected spawn: ${argv.join(' ')}`);
      const url = argv.at(-1) ?? '';
      if (url.endsWith('/events') && up.on) {
        const head = new TextEncoder().encode('HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\nevent: projects\ndata: {"projects":[]}\n\n');
        return { stdout: new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(head) }), kill: () => undefined, wait: never };
      }
      if (!url.endsWith('/projects')) return { stdout: new ReadableStream<Uint8Array>(), kill: () => undefined, wait: never };
      if (!up.on) return { stdout: new ReadableStream<Uint8Array>({ start: (c) => c.close() }), kill: () => undefined, wait: async () => ({ exit_status: 7, term_signal: null }) };
      const bytes = new TextEncoder().encode('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n[]');
      return {
        stdout: new ReadableStream<Uint8Array>({ start: (c) => (c.enqueue(bytes), c.close()) }),
        kill: () => undefined,
        wait: async () => ({ exit_status: 0, term_signal: null }),
      };
    },
  });
}

/** A fake app that records the main window's loads: `reload(html)` and `eval(js)`, plus the trays,
 *  the Dock, and anything that would relaunch or reopen a window. */
function windowApp(): { app: MacApp; reloads: (string | undefined)[]; evals: string[]; trays: MacTraySpec[]; icons: string[]; reopened: string[] } {
  const reloads: (string | undefined)[] = [];
  const evals: string[] = [];
  const reopened: string[] = [];
  const l = lanternApp();
  const base = l.app.window;
  l.app.window = (id) => ({ ...base(id), eval: (js) => void evals.push(`${id}:${js}`) });
  l.app.reload = async (html) => void reloads.push(html);
  l.app.quit = () => void reopened.push('quit');
  l.app.win = { open: (id) => void reopened.push(`win.open(${id})`) };
  return { app: l.app, reloads, evals, trays: l.trays, icons: l.icons, reopened };
}

/** Runs `fn` with the probe loop's PROBE_MS sleeps cut to 1ms (every other timer unchanged). */
async function fastProbes<T>(fn: () => Promise<T>): Promise<T> {
  const real = globalThis.setTimeout;
  Reflect.set(globalThis, 'setTimeout', (cb: () => void, ms?: number) => real(cb, ms === PROBE_MS ? 1 : ms));
  try {
    return await fn();
  } finally {
    Reflect.set(globalThis, 'setTimeout', real);
  }
}

const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 1));
};

const idleNotice = { ...trayNotice(INSTALL_NOTICE), icon: join(ASSETS, 'tray-idle.png'), template: true };

test('071 AC3, AC4: the first miss loads the no-service page once; once the service answers, the board loads once and the app starts, with no relaunch', async () => {
  const up = { on: false };
  const spawned: string[][] = [];
  serviceCurl(up, spawned);
  const w = windowApp();
  await fastProbes(async () => {
    await logging(async () => {
      init(w.app);
      await until(() => w.reloads.length > 0);
      // several probes miss: the page is still loaded only once
      const probes = (): number => spawned.filter((a) => a.at(-1)?.endsWith('/projects') === true).length;
      await until(() => probes() >= 4);
      expect(probes()).toBeGreaterThanOrEqual(4);
      // AC3
      expect(w.reloads).toEqual([noServicePage()]);
      expect(w.trays.at(-1)).toEqual(idleNotice);
      expect(w.icons.every((p) => p === '')).toBe(true);
      expect(w.evals).toEqual([]);
      // AC4
      up.on = true;
      await until(() => w.evals.length > 0 && JSON.stringify(w.trays.at(-1)) !== JSON.stringify(idleNotice));
      await settle();
    });
  });
  expect(w.evals).toEqual([`main:${reloadScript(8766)}`]);
  expect(w.reloads).toEqual([noServicePage()]);
  expect(w.trays.at(-1)).not.toEqual(idleNotice); // startApp ran: the tray left the notice
  expect(w.reopened).toEqual([]);
  await onTray(QUIT_ID, w.app);
});

test('071 AC5: a service answering at the default port on the first probe loads neither the page nor the board', async () => {
  const up = { on: true };
  serviceCurl(up, []);
  const w = windowApp();
  await logging(async () => {
    init(w.app);
    await until(() => w.trays.length > 1);
    await settle();
  });
  expect(w.trays.length).toBeGreaterThan(1); // the app started
  expect(w.reloads).toEqual([]);
  expect(w.evals).toEqual([]);
  await onTray(QUIT_ID, w.app);
});

test('071 AC5: after Quit, or a newer init, while waiting, neither the board nor a later page loads', async () => {
  for (const end of ['quit', 'init'] as const) {
    const up = { on: false };
    serviceCurl(up, []);
    const first = windowApp();
    const second = windowApp();
    await fastProbes(async () => {
      await logging(async () => {
        init(first.app);
        await until(() => first.reloads.length > 0);
        if (end === 'quit') await onTray(QUIT_ID, first.app);
        up.on = true; // the service answers: only a current lifecycle may act on it
        if (end === 'init') init(second.app);
        await settle();
        await settle();
      });
    });
    expect({ end, reloads: first.reloads.length, evals: first.evals }).toEqual({ end, reloads: 1, evals: [] });
    if (end === 'init') {
      // the newer lifecycle's probe answered at once, at the default port: no page, no board reload
      expect(second.reloads).toEqual([]);
      expect(second.evals).toEqual([]);
      await onTray(QUIT_ID, second.app);
    }
  }
});

test('071 AC5: a Quit before the first miss loads no page', async () => {
  const up = { on: false };
  serviceCurl(up, []);
  const w = windowApp();
  await logging(async () => {
    init(w.app);
    await onTray(QUIT_ID, w.app); // before the first probe settles
    await settle();
  });
  expect(w.reloads).toEqual([]);
  expect(w.evals).toEqual([]);
});

// ---- the app menu ----

/** The main window's state as the menu fake reports it: a state, null, or `'fail'` (`getState` rejects). */
type MainState = { current: MacWinState | null | 'fail' };
/** Which windows report `focused: true` (073): every window reads main's state, with its own focus. */
type FocusState = { ids: Set<string> };

/** A fake app that records the menu bar, the store, the pushes, and the shell, with `stored` as the
 *  status bar choice in the store, and `main.current` as the main window's state. */
function menuApp(stored: unknown): { app: MacApp; log: unknown[][]; store: Map<string, unknown>; open: Set<string>; main: MainState; focus: FocusState } {
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
  app.quit = () => void log.push(['quit']);
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
  const focus: FocusState = { ids: new Set() };
  app.window = (id) => ({
    getState: async () => {
      const state = main.current;
      if (state === 'fail') throw new Error(`${id}.getState failed`);
      return state === null ? null : { ...state, focused: focus.ids.has(id) };
    },
    restore: () => log.push([`${id}.restore`]),
    setAllSpaces: (on) => log.push([`${id}.allSpaces`, on]),
    show: () => log.push([`${id}.show`]),
    eval: () => log.push([`${id}.eval`]),
    minimize: () => log.push([`${id}.minimize`]),
    zoom: () => log.push([`${id}.zoom`]),
    setResizable: (on) => log.push([`${id}.resizable`, on]),
    setSize: (w, h) => log.push([`${id}.setSize`, w, h]),
    close: () => {
      open.delete(id);
      log.push([`${id}.close`]);
    },
    hide: (opts) => log.push([`${id}.hide`, opts]),
  });
  const open = new Set<string>(['main']);
  app.windows = async () => [...open];
  app.win = {
    open: (id, opts) => {
      open.add(id);
      log.push(['win.open', id, opts]);
    },
  };
  return { app, log, store, open, main, focus };
}

/** init, with the service never answering, then let the stored choice be read. */
async function initMenu(stored: unknown): Promise<ReturnType<typeof menuApp>> {
  const hung: FakeProcess = { stdout: new ReadableStream<Uint8Array>(), kill: () => undefined, wait: never };
  fakeGlobals(() => hung);
  const m = menuApp(stored);
  init(m.app);
  for (let i = 0; i < 50 && !m.log.some((e) => e[0] === 'menu.set'); i++) await new Promise((r) => setTimeout(r, 1));
  return m;
}

const menuSet = (log: unknown[][]): unknown[][] => log.filter((e) => e[0] === 'menu.set');
/** The menu bar for a status bar and Merged column state, with the page's default view. */
const bar = (statusBarHidden: boolean, mergedHidden = false): ReturnType<typeof appMenu> => appMenu({ statusBarHidden, mergedHidden, view: { ...DEFAULT_VIEW } } satisfies MenuState);

test('AC3: init sets the menu bar with the label for the stored state', async () => {
  const shown = await initMenu(null);
  expect(menuSet(shown.log)).toEqual([['menu.set', bar(false)]]);
  const hidden = await initMenu(true);
  expect(menuSet(hidden.log)).toEqual([['menu.set', bar(true)]]);
  const malformed = await initMenu('yes');
  expect(menuSet(malformed.log)).toEqual([['menu.set', bar(false)]]);
});

test('AC3: init still sets the menu bar (status bar shown) when the store cannot be read', async () => {
  const hung: FakeProcess = { stdout: new ReadableStream<Uint8Array>(), kill: () => undefined, wait: never };
  fakeGlobals(() => hung);
  const m = menuApp(true);
  m.app.store.get = async () => {
    throw new Error('no store');
  };
  init(m.app);
  for (let i = 0; i < 50 && menuSet(m.log).length === 0; i++) await new Promise((r) => setTimeout(r, 1));
  expect(menuSet(m.log)).toEqual([['menu.set', bar(false)]]);
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

test("059 AC8: Help → What's New shows the main window as the tray click does, then pushes the whatsnew event, and nothing else", async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  await onMenu(WHATS_NEW_ID, m.app);
  expect(m.log).toEqual([['main.allSpaces', true], ['main.show'], ['main.allSpaces', false], ['push', 'whatsnew', {}]]);
});

test('075 AC1: File → New Exploration… shows the main window as the tray click does, then pushes startwork { new-exploration, null }, and nothing else', async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  await onMenu(NEW_EXPLORATION_ID, m.app);
  expect(m.log).toEqual([['main.allSpaces', true], ['main.show'], ['main.allSpaces', false], ['push', 'startwork', { action: 'new-exploration', project: null }]]);
});

test('075 AC1: with the main window minimized, New Exploration… restores it before the push', async () => {
  const m = await initMenu(null);
  m.main.current = st(true, false, false);
  m.log.length = 0;
  await onMenu(NEW_EXPLORATION_ID, m.app);
  expect(m.log).toEqual([['main.allSpaces', true], ['main.restore'], ['main.show'], ['main.allSpaces', false], ['push', 'startwork', { action: 'new-exploration', project: null }]]);
});

test('AC3: unknown ids do nothing', async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  for (const id of ['ABOUT', 'nope', 'SETTINGS']) await onMenu(id, m.app);
  expect(m.log).toEqual([]);
});

// ---- the Settings window (035) ----

test('035 AC1: Settings… opens the settings window on the service port, not resizable; a second click shows and focuses it', async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  await onMenu(SETTINGS_ID, m.app);
  expect(m.log).toEqual([
    ['win.open', 'settings', { page: 'http://127.0.0.1:8766/?shell=mac&view=settings', title: 'Settings', size: SETTINGS_SIZE, minSize: SETTINGS_SIZE, chrome: { frame: true, windowControls: ['close'] }, parent: 'main', ...SETTINGS_AT }],
    ...settingsFixed,
  ]);
  m.log.length = 0;
  await onMenu(SETTINGS_ID, m.app);
  expect(m.log).toEqual([['settings.show']]);
});

test('035 AC1: the settings window loads from the port init resolved', async () => {
  const hung: FakeProcess = { stdout: new ReadableStream<Uint8Array>(), kill: () => undefined, wait: never };
  Reflect.set(globalThis, '__ANDON_REPO__', REPO);
  Reflect.set(globalThis, 'tjs', { env: { ANDON_PORT: '9123' }, spawn: () => hung });
  const m = menuApp(null);
  init(m.app);
  m.log.length = 0;
  await onMenu(SETTINGS_ID, m.app);
  expect(m.log.filter((e) => e[0] === 'win.open')).toEqual([['win.open', 'settings', settingsWindow(9123, SETTINGS_AT)]]);
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
  expect(m.log.map((e) => e[0])).toEqual(['win.open', 'settings.setSize', 'settings.resizable']);
});

// ---- the About window (065) ----

test('065 AC2: About Andon opens the About window on the service port, not resizable; a second click only shows it', async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  await onMenu(ABOUT_ID, m.app);
  expect(m.log).toEqual([
    ['win.open', 'about', { page: 'http://127.0.0.1:8766/?shell=mac&view=about', title: 'About Andon', size: ABOUT_SIZE, minSize: ABOUT_SIZE, chrome: { frame: false, windowControls: ['close'] }, parent: 'main', ...ABOUT_AT }],
    ...aboutFixed,
  ]);
  m.log.length = 0;
  await onMenu(ABOUT_ID, m.app);
  expect(m.log).toEqual([['about.show']]);
});

test('065 AC2: the About window loads from the port init resolved, and two quick clicks open one window', async () => {
  const hung: FakeProcess = { stdout: new ReadableStream<Uint8Array>(), kill: () => undefined, wait: never };
  Reflect.set(globalThis, '__ANDON_REPO__', REPO);
  Reflect.set(globalThis, 'tjs', { env: { ANDON_PORT: '9123' }, spawn: () => hung });
  const m = menuApp(null);
  init(m.app);
  m.log.length = 0;
  await Promise.all([onMenu(ABOUT_ID, m.app), onMenu(ABOUT_ID, m.app)]);
  expect(m.log.filter((e) => e[0] === 'win.open')).toEqual([['win.open', 'about', aboutWindow(9123, ABOUT_AT)]]);
});

// ---- About Andon brings the main window back first (073) ----

const aboutOpen = (port = 8766): unknown[] => ['win.open', 'about', aboutWindow(port, ABOUT_AT)];

test('073 AC2: with the main window up, About Andon opens About and leaves main alone; it opens again once closed', async () => {
  const m = await initMenu(null);
  m.main.current = st(false, false, true);
  m.log.length = 0;
  await onMenu(ABOUT_ID, m.app);
  expect(m.log).toEqual([aboutOpen(), ...aboutFixed]);
  m.open.delete('about');
  m.log.length = 0;
  await onMenu(ABOUT_ID, m.app);
  expect(m.log).toEqual([aboutOpen(), ...aboutFixed]);
});

test('073 AC2: with the main window hidden, About Andon shows it, then opens About; once open, shows main, then About', async () => {
  const m = await initMenu(null);
  m.main.current = st(false, false, false);
  m.log.length = 0;
  await onMenu(ABOUT_ID, m.app);
  expect(m.log).toEqual([['main.show'], aboutOpen(), ...aboutFixed]);
  m.log.length = 0;
  await onMenu(ABOUT_ID, m.app);
  expect(m.log).toEqual([['main.show'], ['about.show']]);
});

test('073 AC2: with the main window minimized, About Andon restores and shows it, then opens About; once open, then shows About', async () => {
  const m = await initMenu(null);
  m.main.current = st(true, false, false);
  m.log.length = 0;
  await onMenu(ABOUT_ID, m.app);
  expect(m.log).toEqual([['main.restore'], ['main.show'], aboutOpen(), ...aboutFixed]);
  m.log.length = 0;
  await onMenu(ABOUT_ID, m.app);
  expect(m.log).toEqual([['main.restore'], ['main.show'], ['about.show']]);
});

test('073 AC2: with About open, About Andon never opens a second window: main is brought back, then About shown and focused', async () => {
  const m = await initMenu(null);
  await onMenu(ABOUT_ID, m.app);
  for (const state of [st(false, false, false), st(true, false, false), st(false, false, true)]) {
    m.main.current = state;
    m.log.length = 0;
    await onMenu(ABOUT_ID, m.app);
    expect(m.log.filter((e) => e[0] === 'win.open')).toEqual([]);
    expect(m.log.at(-1)).toEqual(['about.show']);
    expect(m.log.filter((e) => e[0] === 'about.show')).toHaveLength(1);
  }
});

test('073 AC2: when the main window state cannot be read (rejects or null), About Andon shows main, no restore, and still opens or shows About', async () => {
  for (const current of ['fail', null] as const) {
    const m = await initMenu(null);
    m.main.current = current;
    m.log.length = 0;
    await onMenu(ABOUT_ID, m.app);
    expect(m.log).toEqual([['main.show'], ['win.open', 'about', aboutWindow(8766)], ...aboutFixed]); // 077 AC5: no x/y
    m.log.length = 0;
    await onMenu(ABOUT_ID, m.app);
    expect(m.log).toEqual([['main.show'], ['about.show']]);
  }
});

test('073 AC2: two quick clicks with the main window minimized open one About window and bring main back once', async () => {
  const m = await initMenu(null);
  m.main.current = st(true, false, false);
  m.log.length = 0;
  await Promise.all([onMenu(ABOUT_ID, m.app), onMenu(ABOUT_ID, m.app)]);
  expect(m.log).toEqual([['main.restore'], ['main.show'], aboutOpen(), ...aboutFixed]);
});

// ---- File → Close Window (073) ----

/** The menu app with main, Settings, and About open, the main window up, and `focused` the windows reporting focus. */
async function closeApp(focused: string[]): Promise<ReturnType<typeof menuApp>> {
  const m = await initMenu(null);
  m.open.add('settings');
  m.open.add('about');
  for (const id of focused) m.focus.ids.add(id);
  m.log.length = 0;
  return m;
}
const closes = (log: unknown[][]): unknown[][] => log.filter((e) => typeof e[0] === 'string' && /\.(close|hide|show|restore|minimize)$|^quit$/.test(e[0]));

test('073 AC4: with Settings focused, Close Window closes only Settings', async () => {
  const m = await closeApp(['settings']);
  await onMenu(CLOSE_WINDOW_ID, m.app);
  expect(closes(m.log)).toEqual([['settings.close']]);
  expect([...m.open].sort()).toEqual(['about', 'main']);
});

test('073 AC4: with About focused, Close Window closes only About', async () => {
  const m = await closeApp(['about']);
  await onMenu(CLOSE_WINDOW_ID, m.app);
  expect(closes(m.log)).toEqual([['about.close']]);
  expect([...m.open].sort()).toEqual(['main', 'settings']);
});

test('073 AC4: with main focused, Close Window hides main alone (as its close button does), never closing or quitting it', async () => {
  const m = await closeApp(['main']);
  await onMenu(CLOSE_WINDOW_ID, m.app);
  expect(closes(m.log)).toEqual([['main.hide', { app: false }]]);
  expect(m.log.some((e) => e[0] === 'main.close' || e[0] === 'quit')).toBe(false);
  expect(m.open.has('main')).toBe(true);
  // with only main open, too
  const only = await initMenu(null);
  only.focus.ids.add('main');
  only.log.length = 0;
  await onMenu(CLOSE_WINDOW_ID, only.app);
  expect(closes(only.log)).toEqual([['main.hide', { app: false }]]);
});

test('073 AC4: with no Andon window focused, Close Window does nothing', async () => {
  const m = await closeApp([]);
  await onMenu(CLOSE_WINDOW_ID, m.app);
  expect(closes(m.log)).toEqual([]);
  expect([...m.open].sort()).toEqual(['about', 'main', 'settings']);
});

test('073 AC4: with the window state unreadable (rejects or null), or the windows unlisted, Close Window does nothing', async () => {
  for (const current of ['fail', null] as const) {
    const m = await closeApp(['settings', 'about', 'main']);
    m.main.current = current;
    await onMenu(CLOSE_WINDOW_ID, m.app);
    expect({ current, log: closes(m.log) }).toEqual({ current, log: [] });
  }
  const m = await closeApp(['about']);
  m.app.windows = async () => {
    throw new Error('no windows');
  };
  await onMenu(CLOSE_WINDOW_ID, m.app);
  expect(closes(m.log)).toEqual([]);
});

test('073 AC4: a window not open, or not an Andon window, is never read or closed', async () => {
  const m = await initMenu(null);
  m.open.add('other');
  m.focus.ids.add('other');
  m.focus.ids.add('about'); // reports focus, but it isn't open
  m.log.length = 0;
  await onMenu(CLOSE_WINDOW_ID, m.app);
  expect(closes(m.log)).toEqual([]);
});

const ABOUT_META = { window: 'about', origin: 'http://127.0.0.1:8766' };
/** apps/andon/package.json's version: what build.ts fixes into the bundle as __ANDON_VERSION__. */
const pkgVersion = async (): Promise<string> => {
  const pkg: unknown = await Bun.file(join(import.meta.dir, '..', 'package.json')).json();
  const v = typeof pkg === 'object' && pkg !== null && 'version' in pkg ? pkg.version : null;
  if (typeof v !== 'string') throw new Error('no version');
  return v;
};

test("065 AC3: getAbout answers the About window with the app's version and the GitHub URL", async () => {
  const version = await pkgVersion();
  Reflect.set(globalThis, '__ANDON_VERSION__', version);
  const m = menuApp(null);
  expect(await getAbout(ABOUT_META)).toEqual({ version, github: GITHUB_URL });
  expect(await api.getAbout(null, m.app, ABOUT_META)).toEqual({ version, github: 'https://github.com/mattmccray/factory' });
  expect(m.log).toEqual([]);
});

test('065 AC3: from any window but About (main, Settings, none), getAbout answers nothing', async () => {
  Reflect.set(globalThis, '__ANDON_VERSION__', '9.9.9');
  const m = menuApp(null);
  for (const meta of [{ window: 'main' }, { window: 'settings' }, { window: 'other' }, { window: 'About' }, {}, null, undefined, 'about']) {
    expect({ meta, r: await getAbout(meta) }).toEqual({ meta, r: null });
    expect({ meta, r: await api.getAbout({ window: 'about' }, m.app, meta) }).toEqual({ meta, r: null });
  }
  expect(m.log).toEqual([]);
});

test('073 AC5: closeAbout from the About window, with no params, closes only the About window', async () => {
  for (const params of [null, undefined]) {
    const m = menuApp(null);
    m.open.add('about');
    m.open.add('settings');
    expect(await closeAbout(params, m.app, ABOUT_META)).toBe(true);
    expect(m.log).toEqual([['about.close']]);
    m.open.add('about');
    m.log.length = 0;
    expect(await api.closeAbout(params, m.app, ABOUT_META)).toBe(true);
    expect(m.log).toEqual([['about.close']]);
  }
});

test('073 AC5: closeAbout from any window but About, with malformed meta, or with params supplied, closes nothing', async () => {
  const m = menuApp(null);
  m.open.add('about');
  for (const meta of [{ window: 'main' }, { window: 'settings' }, { window: 'other' }, { window: 'About' }, {}, null, undefined, 'about', ['about']]) {
    expect({ meta, r: await closeAbout(null, m.app, meta) }).toEqual({ meta, r: false });
    expect({ meta, r: await api.closeAbout({ window: 'about' }, m.app, meta) }).toEqual({ meta, r: false });
  }
  for (const params of [{}, { window: 'about' }, 'about', 0, false, [], ['main']]) {
    expect({ params, r: await closeAbout(params, m.app, ABOUT_META) }).toEqual({ params, r: false });
  }
  expect(m.log).toEqual([]);
});

// ---- Settings… brings the main window back first (037) ----

const openCall = (port = 8766): unknown[] => ['win.open', 'settings', settingsWindow(port, SETTINGS_AT)];

test('037 AC2: with the main window up, Settings… opens the close-only child window, not resizable, and leaves main alone', async () => {
  const m = await initMenu(null);
  m.main.current = st(false, false, true);
  m.log.length = 0;
  await onMenu(SETTINGS_ID, m.app);
  expect(m.log).toEqual([openCall(), ...settingsFixed]);
  expect(m.log.some((e) => e[0] === 'main.restore' || e[0] === 'main.show')).toBe(false);
});

test('037 AC3: with the main window hidden, Settings… shows it, then opens Settings; once open, shows main, then Settings', async () => {
  const m = await initMenu(null);
  m.main.current = st(false, false, false);
  m.log.length = 0;
  await onMenu(SETTINGS_ID, m.app);
  expect(m.log).toEqual([['main.show'], openCall(), ...settingsFixed]);
  m.log.length = 0;
  await onMenu(SETTINGS_ID, m.app);
  expect(m.log).toEqual([['main.show'], ['settings.show']]);
});

test('037 AC4: with the main window minimized, Settings… restores and shows it, then opens Settings; once open, then shows Settings', async () => {
  const m = await initMenu(null);
  m.main.current = st(true, false, false);
  m.log.length = 0;
  await onMenu(SETTINGS_ID, m.app);
  expect(m.log).toEqual([['main.restore'], ['main.show'], openCall(), ...settingsFixed]);
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
  expect(m.log).toEqual([['main.restore'], ['main.show'], openCall(), ...settingsFixed]);
});

test('037 AC6: when the main window state cannot be read (rejects or null), Settings… shows main, no restore, and still opens or shows Settings', async () => {
  for (const current of ['fail', null] as const) {
    const m = await initMenu(null);
    m.main.current = current;
    m.log.length = 0;
    await onMenu(SETTINGS_ID, m.app);
    expect(m.log).toEqual([['main.show'], ['win.open', 'settings', settingsWindow(8766)], ...settingsFixed]); // 077 AC5: no x/y
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
  expect(m.log).toEqual([['main.show'], openCall(), ...settingsFixed]);
});

// ---- About and Settings open centered on the main window (077) ----

/** The main window moved: a frame at (x, y), 1280x820 (outer 1280x848), on a screen at `origin`, 1728x1117. */
const movedTo = (x: number, y: number, origin = { x: 0, y: 0 }): MacWinState => ({
  ...st(false),
  x,
  y,
  outer: { width: 1280, height: 848 },
  local: { x: x - origin.x, y: y - origin.y },
});
/** Each child window: its menu id, window id, options builder, and fixed size. */
const CHILDREN = [
  { menu: SETTINGS_ID, id: 'settings', options: settingsWindow, size: [480, 360] },
  { menu: ABOUT_ID, id: 'about', options: aboutWindow, size: [440, 400] },
] as const;

test("077 AC3: About and Settings open with today's options plus the x/y that centers them on the main window's current frame", async () => {
  for (const c of CHILDREN) {
    const m = await initMenu(null);
    const [w, h] = c.size;
    m.main.current = movedTo(300, 150);
    m.log.length = 0;
    await onMenu(c.menu, m.app);
    const at = { x: 300 + (1280 - w) / 2, y: 150 + (848 - h) / 2 };
    expect(m.log).toEqual([['win.open', c.id, { ...c.options(8766), ...at }], [`${c.id}.setSize`, w, h], [`${c.id}.resizable`, false]]);
    // closed, the main window moved again: the next open follows it, not the last place
    m.open.delete(c.id);
    m.main.current = movedTo(10, 40);
    m.log.length = 0;
    await onMenu(c.menu, m.app);
    expect(m.log[0]).toEqual(['win.open', c.id, { ...c.options(8766), x: 10 + (1280 - w) / 2, y: 40 + (848 - h) / 2 }]);
  }
});

test('077 AC3: against a screen edge, the position keeps the child on the main window\'s screen, a second screen included', async () => {
  for (const c of CHILDREN) {
    const [w, h] = c.size;
    const m = await initMenu(null);
    m.main.current = movedTo(-1100, 900); // mostly off the left and bottom edges
    m.log.length = 0;
    await onMenu(c.menu, m.app);
    expect(m.log[0]).toEqual(['win.open', c.id, { ...c.options(8766), x: 0, y: 1117 - h }]);
    const left = await initMenu(null);
    left.main.current = movedTo(-1728 + 1000, -500, { x: -1728, y: 0 }); // a screen to the left of the primary one, past its top
    left.log.length = 0;
    await onMenu(c.menu, left.app);
    expect(left.log[0]).toEqual(['win.open', c.id, { ...c.options(8766), x: -728 + (1728 - 1000 - w), y: 0 }]);
  }
});

test('077 AC3: a minimized main window is brought back first, and the child is placed on its frame', async () => {
  for (const c of CHILDREN) {
    const m = await initMenu(null);
    m.main.current = { ...movedTo(300, 150), minimized: true, visible: false };
    m.log.length = 0;
    await onMenu(c.menu, m.app);
    const [w, h] = c.size;
    expect(m.log.slice(0, 3)).toEqual([['main.restore'], ['main.show'], ['win.open', c.id, { ...c.options(8766), x: 300 + (1280 - w) / 2, y: 150 + (848 - h) / 2 }]]);
  }
});

test('077 AC4: an open About or Settings is shown and focused where it is: no open, no position, no size', async () => {
  for (const c of CHILDREN) {
    const m = await initMenu(null);
    await onMenu(c.menu, m.app);
    m.main.current = movedTo(900, 600);
    m.log.length = 0;
    await onMenu(c.menu, m.app);
    expect(m.log).toEqual([[`${c.id}.show`]]);
  }
});

test('077 AC5: with the main window state null or failing, the child opens with no x/y, and a log line says why', async () => {
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (line: string) => void logged.push(line);
  try {
    for (const c of CHILDREN) {
      for (const current of ['fail', null] as const) {
        const m = await initMenu(null);
        m.main.current = current;
        m.log.length = 0;
        logged.length = 0;
        await onMenu(c.menu, m.app);
        const opened = m.log.find((e) => e[0] === 'win.open');
        expect(opened).toEqual(['win.open', c.id, c.options(8766)]);
        const opts = opened?.[2];
        expect(typeof opts === 'object' && opts !== null && ('x' in opts || 'y' in opts)).toBe(false);
        const why = logged.filter((l) => l.includes('without a position'));
        expect({ c: c.id, current, why: why.length }).toEqual({ c: c.id, current, why: 1 });
        expect(why[0]).toContain(current === 'fail' ? 'main.getState failed' : 'no state');
      }
    }
  } finally {
    console.log = realLog;
  }
});

const SETTINGS_META = { window: 'settings', origin: 'http://127.0.0.1:8766' };
/** The settings with the status bar choice, the default T3 Code choice, and no `t3` (the fake `tjs` has no files). */
const snap = (hidden: boolean, t3Handoff: HandoffMode = 'draft', t3Found = false, mergedHidden = false): Settings => ({ statusBarHidden: hidden, t3Handoff, mergedHidden, t3Found });

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
  expect(menuSet(again.log)).toEqual([['menu.set', bar(true)]]);
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
    ['push', 'merged', { hidden: false }],
    ['push', 'statusbar', { hidden: true }],
    ['push', 'merged', { hidden: false }],
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
  fakeGlobals(() => hung);
  const m = menuApp(true);
  init(m.app);
  await onNavigate({ window: 'main', kind: 'finish', isMainFrame: true }, m.app);
  expect(m.log.filter((e) => e[0] === 'push')).toEqual([
    ['push', 'statusbar', { hidden: true }],
    ['push', 'merged', { hidden: false }],
  ]);
});

// ---- the View menu (063) ----

test('063 AC3: init reads the stored Merged choice into the menu bar: exactly true is hidden', async () => {
  for (const [stored, hidden] of [[true, true], [false, false], [null, false], ['true', false], [1, false]] as const) {
    const hung: FakeProcess = { stdout: new ReadableStream<Uint8Array>(), kill: () => undefined, wait: never };
    fakeGlobals(() => hung);
    const m = menuApp(null);
    m.store.set('mergedHidden', stored);
    init(m.app);
    for (let i = 0; i < 50 && menuSet(m.log).length === 0; i++) await new Promise((r) => setTimeout(r, 1));
    expect({ stored, set: menuSet(m.log) }).toEqual({ stored, set: [['menu.set', bar(false, hidden)]] });
    expect({ stored, s: await getSettings(m.app, SETTINGS_META) }).toEqual({ stored, s: snap(false, 'draft', false, hidden) });
  }
});

test('063 AC3: the View menu item and the Settings checkbox share one path: store, relabel, push merged, and Settings reads it', async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  await onMenu(MERGED_ID, m.app);
  expect(m.log).toEqual([
    ['store.set', 'mergedHidden', true],
    ['menu.update', MERGED_ID, { label: 'Show Merged Column' }],
    ['push', 'merged', { hidden: true }],
  ]);
  expect(await getSettings(m.app, SETTINGS_META)).toEqual(snap(false, 'draft', false, true));
  m.log.length = 0;
  expect(await api.setSetting({ key: 'mergedHidden', value: false }, m.app, SETTINGS_META)).toEqual(snap(false, 'draft', false, false));
  expect(m.log).toEqual([
    ['store.set', 'mergedHidden', false],
    ['menu.update', MERGED_ID, { label: 'Hide Merged Column' }],
    ['push', 'merged', { hidden: false }],
  ]);
  // the value it already holds flips nothing
  m.log.length = 0;
  expect(await setSetting({ key: 'mergedHidden', value: false }, m.app, SETTINGS_META)).toEqual(snap(false));
  expect(m.log).toEqual([]);
  // the menu toggle starts from the Settings change
  expect(await setSetting({ key: 'mergedHidden', value: true }, m.app, SETTINGS_META)).toEqual(snap(false, 'draft', false, true));
  m.log.length = 0;
  await onMenu(MERGED_ID, m.app);
  expect(m.log[0]).toEqual(['store.set', 'mergedHidden', false]);
  // the status bar is untouched throughout
  expect(m.store.get('statusBarHidden')).toBeNull();
});

test('063 AC3: a malformed Merged change, or one from another window, changes nothing', async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  for (const params of [{ key: 'mergedHidden', value: 'yes' }, { key: 'mergedHidden', value: 1 }, { key: 'mergedHidden', value: true, extra: 1 }, { key: 'mergedHidden' }]) {
    expect({ params, r: await setSetting(params, m.app, SETTINGS_META) }).toEqual({ params, r: null });
  }
  for (const meta of [MAIN_META, { window: 'other' }, null]) expect(await setSetting({ key: 'mergedHidden', value: true }, m.app, meta)).toBeNull();
  expect(m.log).toEqual([]);
  expect(m.store.has('mergedHidden')).toBe(false);
});

test('063 AC3: the Merged choice survives a relaunch', async () => {
  const m = await initMenu(null);
  await setSetting({ key: 'mergedHidden', value: true }, m.app, SETTINGS_META);
  const hung: FakeProcess = { stdout: new ReadableStream<Uint8Array>(), kill: () => undefined, wait: never };
  fakeGlobals(() => hung);
  const again = menuApp(null);
  again.store.set('mergedHidden', m.store.get('mergedHidden'));
  init(again.app);
  for (let i = 0; i < 50 && menuSet(again.log).length === 0; i++) await new Promise((r) => setTimeout(r, 1));
  expect(menuSet(again.log)).toEqual([['menu.set', bar(false, true)]]);
  again.log.length = 0;
  await onNavigate({ window: 'main', kind: 'finish', isMainFrame: true }, again.app);
  expect(again.log).toEqual([
    ['push', 'statusbar', { hidden: false }],
    ['push', 'merged', { hidden: true }],
  ]);
});

test('063 AC4: Needs Me, the sidebar, and the inspector push their event to the page; Show Settled… shows the board first', async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  await onMenu(NEEDS_ME_ID, m.app);
  await onMenu(SIDEBAR_ID, m.app);
  await onMenu(INSPECTOR_ID, m.app);
  expect(m.log).toEqual([
    ['push', 'needsme', {}],
    ['push', 'sidebar', {}],
    ['push', 'inspector', {}],
  ]);
  m.log.length = 0;
  await onMenu(SETTLED_ID, m.app);
  expect(m.log).toEqual([['main.allSpaces', true], ['main.show'], ['main.allSpaces', false], ['push', 'settled', {}]]);
  // the page actions store nothing and relabel nothing: the page reports its state back
  expect(m.store.has('needsMe')).toBe(false);
});

test('063 AC5: the main window reports its view state; the backend relabels only the items that changed and answers the state', async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  expect(await setViewState({ needsMe: false, sidebarShown: true, inspectorOpen: false }, m.app, MAIN_META)).toEqual({ needsMe: false, sidebarShown: true, inspectorOpen: false });
  expect(m.log).toEqual([]); // the default view: nothing to flip
  expect(await api.setViewState({ needsMe: true, sidebarShown: true, inspectorOpen: false }, m.app, MAIN_META)).toEqual({ needsMe: true, sidebarShown: true, inspectorOpen: false });
  expect(m.log).toEqual([['menu.update', NEEDS_ME_ID, { label: 'Show All Jobs' }]]);
  m.log.length = 0;
  // the inspector opens and the narrow-window rule hides the sidebar in the same change
  await api.setViewState({ needsMe: true, sidebarShown: false, inspectorOpen: true }, m.app, MAIN_META);
  expect(m.log).toEqual([
    ['menu.update', SIDEBAR_ID, { label: 'Show Sidebar' }],
    ['menu.update', INSPECTOR_ID, { label: 'Hide Inspector' }],
  ]);
  m.log.length = 0;
  await api.setViewState({ needsMe: false, sidebarShown: true, inspectorOpen: false }, m.app, MAIN_META);
  expect(m.log).toEqual([
    ['menu.update', NEEDS_ME_ID, { label: 'Show Only Needs Me' }],
    ['menu.update', SIDEBAR_ID, { label: 'Hide Sidebar' }],
    ['menu.update', INSPECTOR_ID, { label: 'Show Inspector' }],
  ]);
  expect([...m.store.keys()]).toEqual(['statusBarHidden']); // never stored
});

test('063 AC5: a relaunch starts the menu from the default view, whatever the page last reported', async () => {
  const m = await initMenu(null);
  await setViewState({ needsMe: true, sidebarShown: false, inspectorOpen: true }, m.app, MAIN_META);
  const again = await initMenu(null);
  expect(menuSet(again.log)).toEqual([['menu.set', bar(false)]]);
});

test('063 AC6: setViewState from any window but main, or with any params but the three booleans, answers null and relabels nothing', async () => {
  const m = await initMenu(null);
  m.log.length = 0;
  const ok = { needsMe: true, sidebarShown: false, inspectorOpen: true };
  for (const meta of [SETTINGS_META, { window: 'settings' }, { window: 'other' }, { window: 'Main' }, {}, null, undefined, 'main', { window: ['main'] }]) {
    expect({ meta, r: await setViewState(ok, m.app, meta) }).toEqual({ meta, r: null });
    expect({ meta, r: await api.setViewState(ok, m.app, meta) }).toEqual({ meta, r: null });
  }
  for (const params of [null, undefined, {}, [], 'x', { ...ok, extra: 1 }, { needsMe: true, sidebarShown: false }, { ...ok, needsMe: 'yes' }, { ...ok, inspectorOpen: 1 }]) {
    expect({ params, r: await api.setViewState(params, m.app, MAIN_META) }).toEqual({ params, r: null });
  }
  expect(m.log).toEqual([]);
  // still the default view: the next good report flips all three
  await setViewState(ok, m.app, MAIN_META);
  expect(m.log.map((e) => e[1])).toEqual([NEEDS_ME_ID, SIDEBAR_ID, INSPECTOR_ID]);
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
  expect(Object.keys(api)).toEqual(['projectMenu', 'getSettings', 'setSetting', 'handOff', 'jobMenu', 'setViewState', 'getAbout', 'startWork', 'closeAbout', 'epicMenu']);
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

test('075 AC3: New Exploration… shows the main window, then pushes startwork for the project; Run Next only pushes; nothing runs or notifies', async () => {
  const m = menuApp(null);
  const ran: string[][] = [];
  const runner = async (argv: string[]): Promise<RunResult> => {
    ran.push(argv);
    return ok();
  };
  await runProjectItem(itemId('explore', PID), m.app, PROJECTS, '/x/t3', runner);
  expect(m.log).toEqual([['main.allSpaces', true], ['main.show'], ['main.allSpaces', false], ['push', 'startwork', { action: 'new-exploration', project: PID }]]);
  m.log.length = 0;
  m.main.current = st(true, false, false); // minimized: brought back before the push
  await runProjectItem(itemId('explore', PID), m.app, PROJECTS, null, runner);
  expect(m.log).toEqual([['main.allSpaces', true], ['main.restore'], ['main.show'], ['main.allSpaces', false], ['push', 'startwork', { action: 'new-exploration', project: PID }]]);
  m.log.length = 0;
  await runProjectItem(itemId('next', PID), m.app, PROJECTS, null, runner);
  expect(m.log).toEqual([['push', 'startwork', { action: 'next', project: PID }]]);
  expect(ran).toEqual([]);
});

test('075 AC3: New Exploration… or Run Next on an unlisted or rootless project does nothing', async () => {
  const m = menuApp(null);
  for (const item of ['explore', 'next'] satisfies Parameters<typeof itemId>[0][]) {
    for (const pid of ['zzzzzzzzzzzz', 'bbbbbbbbbbbb']) await runProjectItem(itemId(item, pid), m.app, PROJECTS, '/x/t3');
  }
  expect(m.log).toEqual([]);
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

// ---- starting work in T3 Code (068) ----

const sItem = (kind: string, slug: string | null, title: string): Record<string, unknown> => ({ kind, slug, title, done: null, status: null, members: kind === 'epic' ? 1 : null, abandoned: [] });
const START_BACKLOG = {
  queued: [sItem('brief', 'notes-search', 'Full-text search'), sItem('epic', 'auth', 'Sign-in'), sItem('text', null, 'Tidy the README')],
  exploring: [sItem('brief', 'tag-cloud', 'A tag cloud')],
};

/** A fake start host: the hand-off's fake, plus a backlog fetch that records each pid (or rejects). */
function fakeStartHost(opts: { t3?: string | null; origin?: string | null; run?: RunResult; backlog?: unknown; fail?: boolean } = {}): { host: StartWorkHost; ran: string[][]; origins: string[]; fetched: string[] } {
  const h = fakeHost(opts);
  const fetched: string[] = [];
  const host: StartWorkHost = {
    ...h.host,
    backlog: async (pid) => {
      fetched.push(pid);
      if (opts.fail === true) throw new Error('HTTP 500');
      return opts.backlog === undefined ? START_BACKLOG : opts.backlog;
    },
  };
  return { host, ran: h.ran, origins: h.origins, fetched };
}

const START_CASES: Array<{ req: Record<string, unknown>; command: string; title: string }> = [
  { req: { project: PID, action: 'run', slug: 'notes-search' }, command: '/factory next Full-text search', title: 'next notes-search' },
  { req: { project: PID, action: 'run', title: 'Tidy the README' }, command: '/factory next Tidy the README', title: 'next Tidy the README' },
  { req: { project: PID, action: 'epic', slug: 'auth' }, command: '/factory epic auth', title: 'epic auth' },
  { req: { project: PID, action: 'next' }, command: '/factory next', title: 'next' },
  { req: { project: PID, action: 'explore', slug: 'tag-cloud' }, command: '/factory explore tag-cloud', title: 'explore tag-cloud' },
  { req: { project: PID, action: 'new-exploration', idea: 'a "tag" cloud' }, command: '/factory explore "a \\"tag\\" cloud"', title: 'explore' },
];

test('068 AC3: draft mode with a GitHub origin opens exactly the prompt link for each action, and answers drafted', async () => {
  for (const c of START_CASES) {
    const { app, log } = handoffApp('draft');
    const h = fakeStartHost();
    expect(await startWork(c.req, app, MAIN_META, h.host)).toBe('drafted');
    expect(h.origins).toEqual([ROOT]);
    expect(h.ran).toEqual([['open', `t3code://new?prompt=${encodeURIComponent(c.command)}&repo=mattmccray/factory`]]);
    expect(log).toEqual([]);
  }
});

test('068 AC3: only the item actions read the backlog, from the named project', async () => {
  for (const c of START_CASES) {
    const { app } = handoffApp('copy');
    const h = fakeStartHost();
    expect(await startWork(c.req, app, MAIN_META, h.host)).toBe('copy-only');
    const item = c.req.action === 'run' || c.req.action === 'epic' || c.req.action === 'explore';
    expect({ req: c.req, fetched: h.fetched }).toEqual({ req: c.req, fetched: item ? [PID] : [] });
  }
});

test('068 AC3: draft mode with no GitHub origin opens nothing and answers no-github-remote', async () => {
  for (const origin of [null, '', 'https://gitlab.com/a/b.git\n']) {
    const { app, log } = handoffApp('draft');
    const h = fakeStartHost({ origin });
    expect(await startWork({ project: PID, action: 'next' }, app, MAIN_META, h.host)).toBe('no-github-remote');
    expect(h.ran).toEqual([]);
    expect(log).toEqual([]);
  }
});

test('068 AC3: send mode runs exactly `<t3> thread start --title <title> <root> <command>`, and answers sent', async () => {
  const { app, log } = handoffApp('send');
  const h = fakeStartHost();
  for (const c of START_CASES) expect(await startWork(c.req, app, MAIN_META, h.host)).toBe('sent');
  expect(h.ran).toEqual(START_CASES.map((c) => [T3, 'thread', 'start', '--title', c.title, ROOT, c.command]));
  expect(h.origins).toEqual([]);
  expect(log).toEqual([]);
});

test('068 AC3: copy mode, or no t3, runs and opens nothing and answers copy-only', async () => {
  for (const [mode, t3] of [['copy', T3], ['draft', null], ['send', null]] as const) {
    const { app, log } = handoffApp(mode);
    const h = fakeStartHost({ t3 });
    expect(await startWork({ project: PID, action: 'epic', slug: 'auth' }, app, MAIN_META, h.host)).toBe('copy-only');
    expect(h.ran).toEqual([]);
    expect(h.origins).toEqual([]);
    expect(log).toEqual([]);
  }
});

test("068 AC3: a failed open or send notifies with the hand-off's failure text and answers copy-only", async () => {
  const realLog = console.log;
  console.log = () => undefined;
  try {
    const a = handoffApp('draft');
    expect(await startWork({ project: PID, action: 'next' }, a.app, MAIN_META, fakeStartHost({ run: { ok: false, reason: 'no application knows t3code:' } }).host)).toBe('copy-only');
    expect(a.log).toEqual([['notify', 'Andon', "Couldn't open a draft in T3 Code: no application knows t3code:"]]);
    const b = handoffApp('send');
    expect(await startWork({ project: PID, action: 'next' }, b.app, MAIN_META, fakeStartHost({ run: { ok: false, reason: 'Error: T3 Code is not running' } }).host)).toBe('copy-only');
    expect(b.log).toEqual([['notify', 'Andon', "Couldn't send to T3 Code: Error: T3 Code is not running"]]);
  } finally {
    console.log = realLog;
  }
});

test('068 AC3: another window, a refused request, or a failed backlog fetch runs, opens, and notifies nothing', async () => {
  const requests: unknown[] = [
    null,
    { project: 'zzzzzzzzzzzz', action: 'next' },
    { project: PID, action: 'next', slug: 'auth' },
    { project: PID, action: 'epic', slug: 'notes-search' },
    { project: PID, action: 'explore', slug: 'notes-search' },
    { project: PID, action: 'run', title: 'Full-text search' },
    { project: PID, action: 'new-exploration', idea: ' \n ' },
    { project: PID, action: 'new-exploration', idea: 'x'.repeat(8000) },
    { project: PID, action: 'next', command: 'rm -rf /' },
  ];
  const realLog = console.log;
  console.log = () => undefined;
  try {
    for (const mode of ['draft', 'send']) {
      for (const params of requests) {
        const { app, log } = handoffApp(mode);
        const h = fakeStartHost();
        expect({ mode, params, r: await startWork(params, app, MAIN_META, h.host) }).toEqual({ mode, params, r: null });
        expect(h.ran).toEqual([]);
        expect(h.origins).toEqual([]);
        expect(log).toEqual([]);
      }
      for (const [fail, backlog] of [[true, undefined], [false, 'junk'], [false, { queued: [] }]] as const) {
        const { app, log } = handoffApp(mode);
        const h = fakeStartHost({ fail, backlog });
        expect(await startWork({ project: PID, action: 'epic', slug: 'auth' }, app, MAIN_META, h.host)).toBeNull();
        expect(h.ran).toEqual([]);
        expect(log).toEqual([]);
      }
      for (const meta of [{ window: 'settings' }, { window: 'about' }, {}, null, undefined, 'main']) {
        const { app, log } = handoffApp(mode);
        const h = fakeStartHost();
        expect(await startWork({ project: PID, action: 'next' }, app, meta, h.host)).toBeNull();
        expect(await api.startWork({ project: PID, action: 'next' }, app, meta)).toBeNull();
        expect(h.ran).toEqual([]);
        expect(h.fetched).toEqual([]);
        expect(log).toEqual([]);
      }
    }
  } finally {
    console.log = realLog;
  }
});

test('068 AC3: a second start while one is running is dropped and answers null', async () => {
  const { app } = handoffApp('send');
  let release: () => void = () => undefined;
  const ran: string[][] = [];
  const host: StartWorkHost = {
    ...fakeStartHost().host,
    run: (argv) => {
      ran.push(argv);
      return new Promise((r) => (release = () => r({ ok: true, reason: '' })));
    },
  };
  const first = startWork({ project: PID, action: 'next' }, app, MAIN_META, host);
  await new Promise((r) => setTimeout(r, 1));
  expect(await startWork({ project: PID, action: 'next' }, app, MAIN_META, host)).toBeNull();
  release();
  expect(await first).toBe('sent');
  expect(ran).toHaveLength(1);
  const next = startWork({ project: PID, action: 'next' }, app, MAIN_META, host);
  await new Promise((r) => setTimeout(r, 1));
  release();
  expect(await next).toBe('sent');
});

test('068: with the app not following the service, the api lists no project, so nothing runs', async () => {
  const { app, log } = handoffApp('send');
  expect(await api.startWork({ project: PID, action: 'next' }, app, MAIN_META)).toBeNull();
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

// ---- an epic's right-click menu (076) ----

const MENU_EPIC = 'andon-window-polish';
const EPIC_SESSION = { app: 't3code', environment: 'env-1', thread: 'thread-E' };
const EPIC_LINK = 't3code://threads/env-1/thread-E';
const MAIN = { window: 'main' };

/** A fake epic menu host (the job menu's host shape): a board whose `epics` hold the epic's `epic.json`. */
function epicHost(opts: { board?: unknown; boardError?: Error; t3?: string | null } = {}): { host: JobMenuHost; fetched: string[] } {
  const fetched: string[] = [];
  const host: JobMenuHost = {
    projects: () => PROJECTS,
    board: async (pid) => {
      fetched.push(pid);
      if (opts.boardError !== undefined) throw opts.boardError;
      return opts.board === undefined
        ? { jobs: [{ id: '076-epic-context-menu', epic: MENU_EPIC, session: GOOD_SESSION }], epics: [{ slug: 'other-epic', session: { app: 't3code', environment: 'env-9', thread: 'other' } }, { slug: MENU_EPIC, state: 'running', session: EPIC_SESSION }] }
        : opts.board;
    },
    findT3: async () => (opts.t3 === undefined ? T3 : opts.t3),
  };
  return { host, fetched };
}

test('076 AC1: an epic with a session and t3 found gets Open in T3 Code (enabled), a separator, and Copy Epic Name', async () => {
  const { app, log } = jobApp();
  const h = epicHost();
  await showEpicMenu({ project: PID, epic: MENU_EPIC }, app, MAIN, h.host);
  expect(h.fetched).toEqual([PID]);
  expect(contexts(log)).toEqual([epicMenuItems(PID, MENU_EPIC, false), epicMenuItems(PID, MENU_EPIC, true)]);
  expect(contexts(log).at(-1)).toEqual([
    { id: `epic-menu:t3:${PID}:${MENU_EPIC}`, label: 'Open in T3 Code', enabled: true },
    { separator: true },
    { id: `epic-menu:copy:${PID}:${MENU_EPIC}`, label: 'Copy Epic Name' },
  ]);
  // the opening press asks again: the menu stays as it is
  log.length = 0;
  await showEpicMenu({ project: PID, epic: MENU_EPIC }, app, MAIN, h.host);
  expect(contexts(log)).toEqual([]);
});

test('076 AC1: a null, missing, or malformed session, or no t3, grays Open in T3 Code out; Copy Epic Name stays; the grayed item opens nothing', async () => {
  const sessions: unknown[] = [undefined, null, { ...EPIC_SESSION, app: 'codex' }, { ...EPIC_SESSION, extra: 'x' }, { ...EPIC_SESSION, thread: 'thread/E' }, { ...EPIC_SESSION, environment: '' }, { app: 't3code', environment: 'env-1' }, 't3code:env-1/thread-E'];
  const cases: { label: string; h: ReturnType<typeof epicHost> }[] = sessions.map((session) => ({
    label: JSON.stringify(session) ?? 'undefined',
    h: epicHost({ board: { jobs: [], epics: [session === undefined ? { slug: MENU_EPIC } : { slug: MENU_EPIC, session }] } }),
  }));
  cases.push({ label: 'no t3', h: epicHost({ t3: null }) });
  for (const c of cases) {
    const { app, log } = jobApp();
    await quietly(async () => {
      await showEpicMenu(null, app, MAIN, c.h.host); // disarm: the last case armed this same epic
      log.length = 0;
      await showEpicMenu({ project: PID, epic: MENU_EPIC }, app, MAIN, c.h.host);
      expect({ c: c.label, menu: contexts(log).at(-1) }).toEqual({ c: c.label, menu: epicMenuItems(PID, MENU_EPIC, false) });
      await runEpicItem(epicItemId('t3', PID, MENU_EPIC), app, c.h.host);
      expect({ c: c.label, opened: opened(log) }).toEqual({ c: c.label, opened: [] });
      await runEpicItem(epicItemId('copy', PID, MENU_EPIC), app, c.h.host);
    });
    expect(log.filter((e) => e[0] === 'clipboard.write')).toEqual([['clipboard.write', { text: MENU_EPIC }]]);
  }
});

test("076 AC1: a failed board fetch keeps the menu with Open grayed out", async () => {
  const { app, log } = jobApp();
  await showEpicMenu(null, app, MAIN, epicHost().host); // disarm: an earlier test armed this same epic
  log.length = 0;
  const logged = await quietly(() => showEpicMenu({ project: PID, epic: MENU_EPIC }, app, MAIN, epicHost({ boardError: new Error('connection refused') }).host));
  expect(contexts(log)).toEqual([epicMenuItems(PID, MENU_EPIC, false)]);
  expect(logged).toEqual([`andon: could not fetch the board for the epic menu of ${MENU_EPIC} (connection refused)`]);
});

test('076 AC2: Open in T3 Code opens the link from a fresh board, built by threadLink; Copy Epic Name copies the slug', async () => {
  const { app, log } = jobApp();
  let board: unknown = { epics: [{ slug: MENU_EPIC, session: EPIC_SESSION }] };
  const fetched: string[] = [];
  const host: JobMenuHost = { projects: () => PROJECTS, board: async (pid) => (fetched.push(pid), board), findT3: async () => T3 };
  await showEpicMenu({ project: PID, epic: MENU_EPIC }, app, MAIN, host);
  log.length = 0;
  fetched.length = 0;
  await runEpicItem(epicItemId('t3', PID, MENU_EPIC), app, host);
  await runEpicItem(epicItemId('copy', PID, MENU_EPIC), app, host);
  expect(log).toEqual([
    ['shell.open', EPIC_LINK],
    ['clipboard.write', { text: MENU_EPIC }],
  ]);
  expect(EPIC_LINK).toBe(threadLink({ app: 't3code', environment: 'env-1', thread: 'thread-E' }));
  expect(fetched).toEqual([PID]); // the click fetched the board again; the copy needs none
  // the board changed since the menu: the click uses the fresh one
  board = { epics: [{ slug: MENU_EPIC, session: { app: 't3code', environment: 'env-2', thread: 'thread-F' } }] };
  log.length = 0;
  await runEpicItem(epicItemId('t3', PID, MENU_EPIC), app, host);
  expect(opened(log)).toEqual(['t3code://threads/env-2/thread-F']);
});

test('076 AC2: a missing epic, a missing or malformed session, a failed fetch, a failed open, or a refused copy each notifies once with its reason', async () => {
  const cases: { c: ReturnType<typeof jobApp>; h: ReturnType<typeof epicHost>; item: 't3' | 'copy'; text: string }[] = [
    { c: jobApp(), h: epicHost({ board: { epics: [] } }), item: 't3', text: `Couldn't open the epic ${MENU_EPIC} in T3 Code: the epic is not on its board` },
    { c: jobApp(), h: epicHost({ board: { epics: [{ slug: MENU_EPIC, session: null }] } }), item: 't3', text: `Couldn't open the epic ${MENU_EPIC} in T3 Code: the epic has no T3 Code thread recorded` },
    { c: jobApp(), h: epicHost({ board: { epics: [{ slug: MENU_EPIC }] } }), item: 't3', text: `Couldn't open the epic ${MENU_EPIC} in T3 Code: the epic has no T3 Code thread recorded` },
    { c: jobApp(), h: epicHost({ board: { epics: [{ slug: MENU_EPIC, session: { ...EPIC_SESSION, thread: '../../evil' } }] } }), item: 't3', text: `Couldn't open the epic ${MENU_EPIC} in T3 Code: the epic has no T3 Code thread recorded` },
    { c: jobApp(), h: epicHost({ boardError: new Error('HTTP 500') }), item: 't3', text: `Couldn't open the epic ${MENU_EPIC} in T3 Code: HTTP 500` },
    { c: jobApp({ open: new Error('no application knows t3code:') }), h: epicHost(), item: 't3', text: `Couldn't open the epic ${MENU_EPIC} in T3 Code: no application knows t3code:` },
    { c: jobApp({ open: 'false' }), h: epicHost(), item: 't3', text: `Couldn't open the epic ${MENU_EPIC} in T3 Code: T3 Code did not open the link` },
    { c: jobApp({ clipboard: false }), h: epicHost(), item: 'copy', text: `Couldn't copy the epic name ${MENU_EPIC}: the clipboard refused the write` },
    { c: jobApp({ clipboard: new Error('pasteboard busy') }), h: epicHost(), item: 'copy', text: `Couldn't copy the epic name ${MENU_EPIC}: pasteboard busy` },
  ];
  for (const { c, h, item, text } of cases) {
    const logged = await quietly(() => runEpicItem(epicItemId(item, PID, MENU_EPIC), c.app, h.host));
    expect({ text, notified: c.log.filter((e) => e[0] === 'notify') }).toEqual({ text, notified: [['notify', 'Andon', text]] });
    expect(logged).toEqual([`andon: ${text}`]);
    if (item === 't3' && !text.endsWith('did not open the link') && !text.includes('no application')) expect(opened(c.log)).toEqual([]);
  }
});

test('076 AC3: another window, or no meta, is not answered: no menu set, nothing fetched', async () => {
  for (const meta of [undefined, null, {}, { window: 'settings' }, { window: 'about' }, 'main', { window: 'Main' }]) {
    const { app, log } = jobApp();
    const h = epicHost();
    await showEpicMenu({ project: PID, epic: MENU_EPIC }, app, meta, h.host);
    expect({ meta, log }).toEqual({ meta, log: [] });
    expect(h.fetched).toEqual([]);
  }
});

test("076 AC3: extra fields, an unlisted project, or a malformed or over-long slug restore WebKit's menu and fetch nothing", async () => {
  for (const params of [
    { project: 'zzzzzzzzzzzz', epic: MENU_EPIC },
    { project: PID, epic: 'Bad_Slug' },
    { project: PID, epic: 'a'.repeat(41) },
    { project: PID, epic: '../x' },
    { project: PID, epic: '076-epic-context-menu' },
    { project: PID, epic: MENU_EPIC, thread: 'thread-B' },
    { project: PID, epic: MENU_EPIC, url: 't3code://threads/evil/x' },
    { project: PID, epic: MENU_EPIC, session: EPIC_SESSION },
    { project: PID },
    { project: PID, job: '076-epic-context-menu' },
    null,
    'x',
  ]) {
    const { app, log } = jobApp();
    const h = epicHost();
    await showEpicMenu(params, app, MAIN, h.host);
    expect({ params, log }).toEqual({ params, log: [['menu.setContext', null]] });
    expect(h.fetched).toEqual([]);
  }
});

test("076 AC3: a slug not in the board's epics restores WebKit's menu", async () => {
  const { app, log } = jobApp();
  // a job with that name on the board is not an epic
  await showEpicMenu({ project: PID, epic: 'missing-epic' }, app, MAIN, epicHost({ board: { jobs: [{ id: 'missing-epic' }], epics: [{ slug: MENU_EPIC, session: EPIC_SESSION }] } }).host);
  expect(contexts(log)).toEqual([epicMenuItems(PID, 'missing-epic', false), null]);
});

test('076 AC3: a forged or unresolvable item id does nothing', async () => {
  for (const id of [epicItemId('t3', 'zzzzzzzzzzzz', MENU_EPIC), epicItemId('copy', 'zzzzzzzzzzzz', MENU_EPIC), `epic-menu:t3:${PID}:Bad`, `epic-menu:t3:${PID}:${MENU_EPIC}:${EPIC_LINK}`, `epic-menu:open:${PID}:${MENU_EPIC}`, `epic-menu:copy:${PID}:${'a'.repeat(41)}`, null, 7]) {
    const { app, log } = jobApp();
    const h = epicHost();
    await runEpicItem(id, app, h.host);
    expect({ id, log }).toEqual({ id, log: [] });
    expect(h.fetched).toEqual([]);
  }
  // no t3 found: Open in T3 Code does nothing
  const { app, log } = jobApp();
  await runEpicItem(epicItemId('t3', PID, MENU_EPIC), app, epicHost({ t3: null }).host);
  expect(log).toEqual([]);
});

test('076 AC4: onContextMenu sends epic-menu ids to the epic menu, job-menu ids to the job menu, and every other id to the project menu', async () => {
  fakeMachine([], []);
  const { app, log } = jobApp();
  // with the app not following the service, no project is listed: no menu runs anything
  await onContextMenu(epicItemId('copy', PID, MENU_EPIC), app);
  await onContextMenu(jobItemId('copy', PID, MENU_JOB), app);
  await onContextMenu(itemId('copy', PID), app);
  expect(log).toEqual([]);
  // the real api answers only the main window, and with no listed project sets WebKit's menu
  await api.epicMenu({ project: PID, epic: MENU_EPIC }, app, { window: 'settings' });
  expect(log).toEqual([]);
  await api.epicMenu({ project: PID, epic: MENU_EPIC }, app, MAIN);
  expect(log).toEqual([['menu.setContext', null]]);
  const src = await Bun.file(join(import.meta.dir, 'backend.ts')).text();
  const body = /export async function onContextMenu\([^)]*\)[^{]*\{\n([\s\S]*?)\n\}/.exec(src)?.[1]?.split('\n').map((l) => l.trim());
  expect(body).toEqual(['if (isEpicItemId(id)) return runEpicItem(id, app);', 'if (isJobItemId(id)) return runJobItem(id, app);', 'await runProjectItem(id, app, listedProjects(), apps?.t3 ?? null);']);
});

test('076: a newer ask of any menu wins over a slower epic board fetch, and an epic ask wins over a slower job fetch', async () => {
  const { app, log } = jobApp();
  let release: () => void = () => undefined;
  const host: JobMenuHost = {
    projects: () => PROJECTS,
    board: () => new Promise((r) => (release = () => r({ jobs: [{ id: MENU_JOB, session: GOOD_SESSION }], epics: [{ slug: MENU_EPIC, session: EPIC_SESSION }] }))),
    findT3: async () => T3,
  };
  fakeMachine([], []);
  const slow = showEpicMenu({ project: PID, epic: MENU_EPIC }, app, MAIN, host);
  await showProjectMenu({ project: null }, app, PROJECTS);
  release();
  await slow;
  expect(contexts(log)).toEqual([epicMenuItems(PID, MENU_EPIC, false), null]);
  log.length = 0;
  const slowJob = showJobMenu({ project: PID, job: MENU_JOB }, app, host);
  const releaseJob = release;
  const epicAsk = showEpicMenu({ project: PID, epic: MENU_EPIC }, app, MAIN, host);
  const releaseEpic = release;
  releaseJob();
  releaseEpic();
  await slowJob;
  await epicAsk;
  expect(contexts(log)).toEqual([jobMenuItems(PID, MENU_JOB, false), epicMenuItems(PID, MENU_EPIC, false), epicMenuItems(PID, MENU_EPIC, true)]);
});

// ---- the Open in apps' own icons (043) ----

const VSCODE_HOME = '/Users/me/Applications/Visual Studio Code.app';
const T3_BETA = '/Applications/T3 Code (Beta).app';
const GHOSTTY = '/Applications/Ghostty.app';

/** The machine the icon lookups see. Mutable, so a test can install or remove an app between checks. */
interface IconWorld {
  /** Names `open -Ra` finds. */
  installed: string[];
  /** Bundle ids `open -Rb` finds. */
  bundles: string[];
  /** `mdfind`'s stdout per bundle id ('' when absent), 'fail' (exits 1), or 'throw' (can't start). */
  mdfind: Record<string, string>;
  /** Folders present (the fallback `.app`s). */
  dirs: string[];
  /** Executables present (`t3`). */
  files: string[];
  /** What `tjs.remove` was called with. */
  removed: string[];
  /** Every spawned argv. */
  spawned: string[][];
  /** `tjs.remove` rejects. */
  removeFails?: boolean;
}

function iconWorld(over: Partial<IconWorld> = {}): IconWorld {
  return { installed: [], bundles: [], mdfind: {}, dirs: [], files: [], removed: [], spawned: [], ...over };
}

const hungProcess = (): FakeProcess & { stderr: null } => ({ stdout: new ReadableStream<Uint8Array>(), stderr: null, kill: () => undefined, wait: never });

/** Stand in `tjs` (and the build-time globals) for the app check, the icon lookups, and the service (which never answers). */
function fakeIconMachine(w: IconWorld): void {
  Reflect.set(globalThis, '__ANDON_REPO__', REPO);
  Reflect.set(globalThis, 'tjs', {
    env: { HOME: '/Users/me' },
    spawn: (argv: string[]) => {
      w.spawned.push(argv);
      const [cmd, flag, arg] = argv;
      if (cmd === 'mdfind') {
        const id = Object.keys(w.mdfind).find((k) => (flag ?? '').includes(`"${k}"`));
        const out = id === undefined ? '' : (w.mdfind[id] ?? '');
        if (out === 'throw') throw new Error('no mdfind');
        return { stdout: { text: async () => out }, stderr: null, kill: () => undefined, wait: async () => ({ exit_status: out === 'fail' ? 1 : 0, term_signal: null }) };
      }
      if (cmd === 'open' && flag === '-Ra') return exited(w.installed.includes(arg ?? '') ? 0 : 1);
      if (cmd === 'open' && flag === '-Rb') return exited(w.bundles.includes(arg ?? '') ? 0 : 1);
      return hungProcess(); // curl and the service: never answer
    },
    stat: async (path: string) => {
      if (w.dirs.includes(path)) return { isFile: false, isDirectory: true, mode: 0o40755 };
      if (w.files.includes(path)) return { isFile: true, isDirectory: false, mode: 0o100755 };
      throw new Error('ENOENT');
    },
    remove: async (path: string) => {
      w.removed.push(path);
      if (w.removeFails === true) throw new Error('EPERM');
    },
  });
}

/** A fake `app.thumbnail`: a fresh temp png per call for a `.app` in `ok` (`/tmp/<app name>-<nth>.png`), a rejection otherwise. `hold`
 *  keeps every call pending until `release()`. */
function thumbnails(ok: string[], hold = false): { calls: [string, number | undefined][]; thumbnail: MacApp['thumbnail']; release: () => void } {
  const calls: [string, number | undefined][] = [];
  const waiting: (() => void)[] = [];
  let held = hold;
  const made = new Map<string, number>();
  const thumbnail: MacApp['thumbnail'] = async (path, size) => {
    calls.push([path, size]);
    if (held) await new Promise<void>((r) => waiting.push(r));
    if (!ok.includes(path)) throw new Error(`no such file ${path}`);
    const n = (made.get(path) ?? 0) + 1;
    made.set(path, n);
    return { path: png(path, n), width: 64, height: 64 };
  };
  return {
    calls,
    thumbnail,
    release: () => {
      held = false;
      for (const r of waiting.splice(0)) r();
    },
  };
}

/** The temp png the fake thumbnail makes for a `.app` the nth time. */
const png = (app: string, n = 1): string => `/tmp/${(app.split('/').at(-1) ?? '').replace(/\.app$/, '')}-${n}.png`;
const LAUNCH_ICONS = { vscode: png(VSCODE_HOME), t3: png(T3_BETA), ghostty: png(GHOSTTY) };

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1));
};

/** Runs `fn` with console.log captured. */
async function logging<T>(fn: () => Promise<T>): Promise<{ value: T; logged: string[] }> {
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (line: string) => void logged.push(line);
  try {
    return { value: await fn(), logged };
  } finally {
    console.log = realLog;
  }
}

const mdfinds = (w: IconWorld): string[][] => w.spawned.filter((a) => a[0] === 'mdfind');

test("043 AC3: an icon comes from mdfind's hit for the bundle id, thumbnailed at 32", async () => {
  const w = iconWorld({ mdfind: { 'com.microsoft.VSCode': `${VSCODE_HOME}\n/Volumes/old/Visual Studio Code.app\n` }, dirs: ['/Applications/Visual Studio Code.app'] });
  fakeIconMachine(w);
  const { app } = contextApp();
  const t = thumbnails([VSCODE_HOME]);
  app.thumbnail = t.thumbnail;
  expect(await lookupIcon(app, 'vscode')).toBe(png(VSCODE_HOME));
  expect(mdfinds(w)).toEqual([['mdfind', 'kMDItemCFBundleIdentifier == "com.microsoft.VSCode"']]);
  expect(t.calls).toEqual([[VSCODE_HOME, 32]]);
});

test('043 AC3: with no mdfind hit, or mdfind failing, the fixed locations are tried in order', async () => {
  const w = iconWorld({ mdfind: { 'com.t3tools.t3code': '', 'com.mitchellh.ghostty': 'fail' }, dirs: [T3_BETA, '/Users/me/Applications/T3 Code (Beta).app', GHOSTTY] });
  fakeIconMachine(w);
  expect(await findAppBundle('t3')).toBe(T3_BETA);
  const { value, logged } = await logging(() => findAppBundle('ghostty'));
  expect(value).toBe(GHOSTTY);
  expect(logged.some((l) => l.includes('mdfind failed for Ghostty'))).toBe(true);
  w.mdfind['com.mitchellh.ghostty'] = 'throw';
  expect(await logging(() => findAppBundle('ghostty')).then((r) => r.value)).toBe(GHOSTTY);
  expect(mdfinds(w).map((a) => a[1])).toEqual(['kMDItemCFBundleIdentifier == "com.t3tools.t3code"', 'kMDItemCFBundleIdentifier == "com.mitchellh.ghostty"', 'kMDItemCFBundleIdentifier == "com.mitchellh.ghostty"']);
});

test('043 AC3: no .app found, or thumbnail() rejecting, gives no icon, logs a line, and never throws', async () => {
  const w = iconWorld({ mdfind: { 'com.microsoft.VSCode': 'fail', 'com.mitchellh.ghostty': `${GHOSTTY}\n` } });
  fakeIconMachine(w);
  const { app } = contextApp();
  const t = thumbnails([]);
  app.thumbnail = t.thumbnail;
  const missing = await logging(() => lookupIcon(app, 'vscode'));
  expect(missing.value).toBeNull();
  expect(missing.logged.some((l) => l.includes('no VS Code app found'))).toBe(true);
  expect(t.calls).toEqual([]);
  const rejected = await logging(() => lookupIcon(app, 'ghostty'));
  expect(rejected.value).toBeNull();
  expect(rejected.logged.some((l) => l.includes('could not make the Ghostty icon'))).toBe(true);
  expect(t.calls).toEqual([[GHOSTTY, 32]]);
  app.thumbnail = () => {
    throw new Error('thumbnail threw');
  };
  expect((await logging(() => lookupIcon(app, 'ghostty'))).value).toBeNull();
  w.mdfind['com.t3tools.t3code'] = 'throw';
  const unstartable = await logging(() => lookupIcon(app, 't3'));
  expect(unstartable.value).toBeNull();
  expect(unstartable.logged.length).toBeGreaterThan(0);
});

test('043: the found/missing check asks LaunchServices by bundle id, with no mdfind or thumbnail', async () => {
  const w = iconWorld({ bundles: ['com.t3tools.t3code'] });
  fakeIconMachine(w);
  expect(await checkFound()).toEqual({ vscode: false, t3: true, ghostty: false });
  expect(w.spawned).toEqual([
    ['open', '-Rb', 'com.microsoft.VSCode'],
    ['open', '-Rb', 'com.t3tools.t3code'],
    ['open', '-Rb', 'com.mitchellh.ghostty'],
  ]);
});

/** Everything installed and found: VS Code in ~/Applications by Spotlight, T3 Code (Beta) and Ghostty in /Applications by fallback. */
function allFound(): IconWorld {
  return iconWorld({
    installed: ['Visual Studio Code', 'Ghostty'],
    bundles: ['com.microsoft.VSCode', 'com.t3tools.t3code', 'com.mitchellh.ghostty'],
    mdfind: { 'com.microsoft.VSCode': `${VSCODE_HOME}\n` },
    dirs: [T3_BETA, GHOSTTY],
  });
}
const NO_T3: Availability = { vscode: true, ghostty: true, t3: null };

test('043 AC4: a right-click before the launch lookup lands sets the menu at once with no icons; the lookup then sets it again with them', async () => {
  const w = allFound();
  fakeIconMachine(w);
  const { app, log } = contextApp();
  const t = thumbnails([VSCODE_HOME, T3_BETA, GHOSTTY], true);
  app.thumbnail = t.thumbnail;
  await logging(async () => {
    init(app);
    await showProjectMenu({ project: PID }, app, PROJECTS);
    await settle();
  });
  expect(new Set(t.calls.map(([p, size]) => `${p}@${size}`))).toEqual(new Set([`${VSCODE_HOME}@32`, `${T3_BETA}@32`, `${GHOSTTY}@32`]));
  // Set at once (from the last app check, then the fresh one), while every icon lookup still waits.
  const before = contexts(log);
  expect(before.length).toBeGreaterThan(0);
  expect(before.at(-1)).toEqual(projectMenuItems(PID, NO_T3));
  expect(JSON.stringify(before)).not.toContain('icon');
  t.release();
  await settle();
  // T3 Code is grayed (no t3) and still carries its icon.
  expect(contexts(log).at(-1)).toEqual(projectMenuItems(PID, NO_T3, LAUNCH_ICONS));
  log.length = 0;
  await showProjectMenu({ project: PID }, app, PROJECTS);
  expect(contexts(log)).toEqual([projectMenuItems(PID, NO_T3, LAUNCH_ICONS)]);
});

test('043 AC4: a lookup that lands after the menu was disarmed, or after a job menu, sets nothing', async () => {
  for (const after of ['disarm', 'job'] as const) {
    const w = allFound();
    fakeIconMachine(w);
    const { app, log } = contextApp();
    const t = thumbnails([VSCODE_HOME, T3_BETA, GHOSTTY], true);
    app.thumbnail = t.thumbnail;
    await logging(async () => {
      init(app);
      await showProjectMenu({ project: PID }, app, PROJECTS);
      if (after === 'disarm') await showProjectMenu({ project: null }, app, PROJECTS);
      else await showJobMenu({ project: PID, job: 'bad id' }, app, { projects: () => PROJECTS, board: async () => ({}), findT3: async () => null });
      await settle();
    });
    log.length = 0;
    t.release();
    await settle();
    expect({ after, contexts: contexts(log) }).toEqual({ after, contexts: [] });
  }
});

test('043 AC5: an app check with no change looks nothing up; an app that goes has its icon dropped and deleted; one that comes back is looked up alone', async () => {
  const w = allFound();
  fakeIconMachine(w);
  const { app, log } = contextApp();
  const t = thumbnails([VSCODE_HOME, T3_BETA, GHOSTTY]);
  app.thumbnail = t.thumbnail;
  await logging(async () => {
    init(app);
    await settle();
  });
  const launch = LAUNCH_ICONS;
  w.removed.length = 0; // the previous lifecycle's icons, deleted by init
  await showProjectMenu({ project: PID }, app, PROJECTS);
  await settle();
  expect(contexts(log).at(-1)).toEqual(projectMenuItems(PID, NO_T3, launch));

  // no change: no mdfind, no thumbnail
  w.spawned.length = 0;
  t.calls.length = 0;
  await showProjectMenu({ project: PID }, app, PROJECTS);
  await settle();
  expect(mdfinds(w)).toEqual([]);
  expect(t.calls).toEqual([]);
  expect(w.removed).toEqual([]);

  // Ghostty goes: its icon is dropped (no lookup), its png deleted, and the armed menu set again
  w.bundles = w.bundles.filter((b) => b !== 'com.mitchellh.ghostty');
  w.installed = ['Visual Studio Code'];
  w.dirs = [T3_BETA];
  log.length = 0;
  await showProjectMenu({ project: PID }, app, PROJECTS);
  await settle();
  expect(mdfinds(w)).toEqual([]);
  expect(t.calls).toEqual([]);
  expect(w.removed).toEqual([png(GHOSTTY)]);
  const noGhostty = { vscode: launch.vscode, t3: launch.t3 };
  expect(contexts(log).at(-1)).toEqual(projectMenuItems(PID, { vscode: true, ghostty: false, t3: null }, noGhostty));

  // Ghostty comes back: only Ghostty is looked up
  w.bundles.push('com.mitchellh.ghostty');
  w.installed.push('Ghostty');
  w.dirs.push(GHOSTTY);
  log.length = 0;
  await showProjectMenu({ project: PID }, app, PROJECTS);
  await settle();
  expect(mdfinds(w)).toEqual([['mdfind', 'kMDItemCFBundleIdentifier == "com.mitchellh.ghostty"']]);
  expect(t.calls).toEqual([[GHOSTTY, 32]]);
  expect(contexts(log).at(-1)).toEqual(projectMenuItems(PID, NO_T3, { ...noGhostty, ghostty: png(GHOSTTY, 2) }));
});

test('043 AC5: a re-lookup that replaces an icon deletes the old png; a failed delete is logged and stops nothing', async () => {
  // Ghostty's icon is found at launch (by fallback) though the first check says its bundle id is missing.
  const w = allFound();
  w.bundles = ['com.microsoft.VSCode', 'com.t3tools.t3code'];
  w.removeFails = true;
  fakeIconMachine(w);
  const { app, log } = contextApp();
  const t = thumbnails([VSCODE_HOME, T3_BETA, GHOSTTY]);
  app.thumbnail = t.thumbnail;
  await logging(async () => {
    init(app);
    await settle();
  });
  w.bundles.push('com.mitchellh.ghostty');
  w.removed.length = 0; // the previous lifecycle's icons, deleted by init
  w.spawned.length = 0;
  t.calls.length = 0;
  const { logged } = await logging(async () => {
    await showProjectMenu({ project: PID }, app, PROJECTS);
    await settle();
  });
  expect(mdfinds(w)).toEqual([['mdfind', 'kMDItemCFBundleIdentifier == "com.mitchellh.ghostty"']]);
  expect(t.calls).toEqual([[GHOSTTY, 32]]);
  expect(w.removed).toEqual([png(GHOSTTY)]);
  expect(logged.some((l) => l.includes(`could not delete the old icon ${png(GHOSTTY)}`))).toBe(true);
  expect(contexts(log).at(-1)).toEqual(projectMenuItems(PID, NO_T3, { ...LAUNCH_ICONS, ghostty: png(GHOSTTY, 2) }));
});
