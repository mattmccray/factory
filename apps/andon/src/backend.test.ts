// The adapter against a fake Tiny app. onTray and the lantern hooks touch no Tiny or txiki
// globals; the init tests stand in fake `tjs` and `__ANDON_REPO__` globals.
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { assetPath, dockIcon, init, onTray, reloadScript, setDock, setTray, trayIcon } from './backend';
import type { MacApp, MacTraySpec, MacWinState } from './backend';
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
    }),
    setHideOnClose: () => calls.push('setHideOnClose'),
    quit: () => calls.push('quit'),
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
