// The Tiny JS backend adapter: the only file that touches Tiny or txiki.js. It wires the Mac app's
// runtime-neutral logic (app.ts, autostart.ts, appmenu.ts) to Tiny's `app.tray`, `app.icon`,
// `app.badge`, `app.notify`, `app.menu`, `app.store`, `app.push`, `app.shell`, and the `onTray`,
// `onMenu`, and `onNavigate` hooks, and to txiki's `tjs.spawn` (for the service, and for curl: see curl.ts). `bun run
// andon:build` bundles it into build/backend.js, the plain-JS entry tinyjs.json names.
// The window's page (the service-served UI) gets no Tiny API but the two calls its drag regions make
// (`win.startDrag`, `win.zoom`) and the status bar event this adapter pushes (`event.statusbar`):
// tinyjs.json's `api` gate denies the rest.
/// <reference path="../types/tiny.d.ts" />
/// <reference path="../types/tjs.d.ts" />
import { QUIT_ID, SHOW_ID, trayNotice } from './badge';
import type { TraySpec } from './badge';
import { serviceCommand, serviceUrl, DEFAULT_PORT, ensureService, pageUrl, probeService, resolvePort } from './autostart';
import type { Service, Child } from './autostart';
import { curlArgv, responseFromCurl } from './curl';
import type { Http } from './http';
import type { DockLook } from './lantern';
import { startApp } from './app';
import type { App } from './app';
import { oneAtATime, trayClickAction } from './trayclick';
import { STATUS_BAR_EVENT, STATUS_BAR_ID, STATUS_BAR_KEY, appMenu, menuAction, statusBarLabel, statusBarPayload, storedHidden } from './appmenu';

// ---- the Tiny this adapter uses ----
// Tiny's and txiki's own declarations (vendored unedited from Tiny's template; `tinyjs
// update-project` refreshes them) type the `tjs` global and the `app` Tiny passes in. MacApp
// picks the members the Mac app calls, so its whole dependence on Tiny is listed here, in one place,
// and the test fakes stay small.

/** The fields of the main window's state the tray click reads. */
export type MacWinState = Pick<TinyWinState, 'minimized' | 'fullscreen' | 'allSpaces'>;
/** The window ops the adapter calls. `getState` resolves null when there is no state to give. */
export type MacWindow = Pick<TinyWindowHandle, 'show' | 'restore' | 'setAllSpaces' | 'eval' | 'minimize' | 'zoom'> & {
  getState(): Promise<MacWinState | null>;
};
/** The backend `app` object Tiny passes to `init` and the hooks, narrowed to what the Mac app uses.
 *  `icon('')` resets the Dock icon to the bundle icon, `badge('')` clears the badge, and `done`
 *  settles when the launcher closes (⌘Q, or the app menu's Quit). */
export type MacApp = Pick<TinyApp, 'icon' | 'badge' | 'notify' | 'setHideOnClose' | 'quit' | 'push'> &
  Partial<Pick<TinyApp, 'done'>> & {
    tray: Pick<TinyApp['tray'], 'set'>;
    menu: Pick<TinyApp['menu'], 'set' | 'update'>;
    store: Pick<TinyApp['store'], 'get' | 'set'>;
    shell: Pick<TinyApp['shell'], 'open'>;
    window(id: string): MacWindow;
  };
/** The fields of a navigation event `onNavigate` reads. */
export type MacNavEvent = Pick<TinyNavEvent, 'window' | 'kind' | 'isMainFrame'>;
/** What the adapter hands `app.tray.set`. */
export type MacTraySpec = Parameters<MacApp['tray']['set']>[0];

/** Compile-time proof that the app Tiny passes in is a MacApp. */
type Holds<T extends true> = T;
type TinyAppIsMacApp = Holds<TinyApp extends MacApp ? true : false>;

// Fixed at build time by build.ts (`Bun.build` `define`).
declare const __ANDON_REPO__: string;
declare const __ANDON_BUN__: string;

// ---- the lantern images ----
// By absolute path under the repo: Tiny doesn't ship `assets/` as runtime data, and the repo path
// is fixed at build time (the same one the service is started from), so it works in `tinyjs dev`
// and in a built app alike.

export const assetPath = (repo: string, file: string): string => `${repo.replace(/\/+$/, '')}/apps/andon/assets/${file}`;

/** The Dock icon for a look: '' (the bundle's unlit icon.png) for idle, else the lit lantern. */
export const dockIcon = (repo: string, look: DockLook): string =>
  look === 'idle' ? '' : assetPath(repo, look === 'running' ? 'dock-running.png' : 'dock-escalated.png');

/** The tray lantern: outlined when no jobs are running, filled when they are. */
export const trayIcon = (repo: string, running: boolean): string => assetPath(repo, running ? 'tray-running.png' : 'tray-idle.png');

export function setDock(app: MacApp, repo: string, look: DockLook): void {
  if (!app.icon(dockIcon(repo, look))) console.log(`andon: could not set the ${look} Dock icon`);
}

export const setTray = (app: MacApp, repo: string, spec: TraySpec, running: boolean): void =>
  app.tray.set({ ...spec, icon: trayIcon(repo, running), template: true });

/** No board to show (the service hasn't answered, or never will): the idle look, no badge, and the notice. */
function showNotice(app: MacApp, repo: string, text: string): void {
  setTray(app, repo, trayNotice(text), false);
  setDock(app, repo, 'idle');
  app.badge('');
}

// ---- host pieces ----

function curlHttp(base: string): Http {
  return async (path) => {
    const p = tjs.spawn(curlArgv(base + path), { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    const stdout = p.stdout;
    let done = false;
    const kill = (): void => {
      if (done) return;
      done = true;
      try {
        p.kill('SIGTERM');
      } catch {
        // already gone
      }
    };
    void p.wait().then(() => {
      done = true;
    });
    if (stdout === null) {
      kill();
      throw new Error('curl gave no output stream');
    }
    return responseFromCurl(stdout, kill);
  };
}

function spawnChild(argv: string[], env: Record<string, string>): Child {
  const p = tjs.spawn(argv, { env: { ...tjs.env, ...env }, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  let exited = false;
  void p.wait().then(() => {
    exited = true;
  });
  return {
    stop() {
      if (exited) return;
      try {
        p.kill('SIGTERM'); // the service's own handler stops its watchers and exits
      } catch {
        // already gone
      }
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The script that reloads the main window onto the service's page, in Mac-app mode. */
export const reloadScript = (port: number): string => `location.replace(${JSON.stringify(pageUrl(port))})`;

// ---- lifecycle ----

let andon: App | null = null;
let service: Service | null = null;
let quitting = false;

// ---- the status bar choice ----
// Read from the store once at init; every toggle writes it back. The page hears it through the
// pushed status bar event, after its main frame loads and after every toggle; it never asks.

let statusBarHidden = false;
/** Settles once init has read the stored choice and set the menu bar. */
let statusBarRead: Promise<void> = Promise.resolve();

async function readStatusBar(app: MacApp): Promise<void> {
  let stored: unknown = null;
  try {
    stored = await app.store.get(STATUS_BAR_KEY);
  } catch (err) {
    console.log(`andon: could not read the status bar choice (${String(err)}); showing it`);
  }
  statusBarHidden = storedHidden(stored);
  app.menu.set(appMenu(statusBarHidden));
}

const pushStatusBar = (app: MacApp): void => app.push(STATUS_BAR_EVENT, statusBarPayload(statusBarHidden));

async function toggleStatusBar(app: MacApp): Promise<void> {
  await statusBarRead;
  statusBarHidden = !statusBarHidden;
  app.menu.update(STATUS_BAR_ID, { label: statusBarLabel(statusBarHidden) });
  pushStatusBar(app);
  if (!(await app.store.set(STATUS_BAR_KEY, statusBarHidden))) console.log('andon: could not save the status bar choice');
}

function stopAll(): void {
  quitting = true;
  andon?.stop();
  andon = null;
  service?.stop(); // a no-op for a service the Mac app found already running
  service = null;
}

export function init(app: MacApp): void {
  quitting = false; // a fresh lifecycle (Tiny calls init once; tests call it after a Quit)
  const port = resolvePort(tjs.env);
  const url = serviceUrl(port);
  const http = curlHttp(url);
  const repo = __ANDON_REPO__;
  statusBarRead = readStatusBar(app);
  showNotice(app, repo, 'starting the service');
  app.setHideOnClose(true);
  // ⌘Q skips onTray: stop our service before Tiny exits (kill is synchronous).
  void app.done?.then(stopAll, stopAll);

  void (async () => {
    service = await ensureService({
      probe: () => probeService(http),
      spawn: spawnChild,
      sleep,
      command: serviceCommand(__ANDON_REPO__, __ANDON_BUN__),
      port,
    });
    if (quitting) return stopAll();
    if (!service.ok) {
      console.log(`andon: ${service.reason}`);
      showNotice(app, repo, service.reason);
      return;
    }
    // The window loaded tinyjs.json's URL before the service answered (or on another port): load it
    // now, keeping `?shell=mac` so the page keeps its Mac frame.
    if (service.started || port !== DEFAULT_PORT) app.window('main').eval(reloadScript(port));
    andon = startApp({
      http,
      tray: (spec, running) => setTray(app, repo, spec, running),
      dock: (look) => setDock(app, repo, look),
      badge: (text) => void app.badge(text),
      notify: (n) => void app.notify(n.title, n.body, { subtitle: n.subtitle }),
      log: (line) => console.log(line),
    });
  })();
}

/** How long a shown window stays on every Space before it is pinned back to one: long enough for
 *  the show to land on the Space the user is on, not on the window's old one. */
const SPACE_SETTLE_MS = 150;

/** A left click on the icon: show the main window in front, on this Space. It never hides it:
 *  Tiny's `focused` isn't reliable at click time (rework 2); the close button hides the window. */
const showMain = oneAtATime(async (app: MacApp): Promise<void> => {
  const main = app.window('main');
  let state: MacWinState | null;
  try {
    state = await main.getState();
  } catch (err) {
    // No state to decide on: still show the window, just without the Space move.
    console.log(`andon: window state unavailable (${String(err)}); showing the window as is`);
    main.show();
    return;
  }
  const action = trayClickAction(state);
  if (!action.moveHere) {
    if (action.restore) main.restore();
    main.show(); // brings it to the front
    return;
  }
  main.setAllSpaces(true);
  try {
    if (action.restore) main.restore();
    main.show(); // brings it to the front
    await sleep(SPACE_SETTLE_MS);
  } finally {
    main.setAllSpaces(false); // never leave the window on every Space, even when a step threw
  }
});

/** A menu item's id, or null for a left click on the icon (the tray spec sets `primaryAction`). */
export async function onTray(id: string | null, app: MacApp): Promise<void> {
  if (id === null) return showMain(app);
  if (id === SHOW_ID) app.window('main').show();
  if (id === QUIT_ID) {
    stopAll();
    app.quit();
  }
}

/** A click in the menu bar. Settings… is a placeholder, so it (like any id that isn't ours) does nothing. */
export async function onMenu(id: string, app: MacApp): Promise<void> {
  const action = menuAction(id);
  if (action === null) return;
  switch (action.kind) {
    case 'toggle-status-bar':
      return toggleStatusBar(app);
    case 'minimize':
      return app.window('main').minimize();
    case 'zoom':
      return app.window('main').zoom();
    case 'show-main':
      return showMain(app); // the tray's left click: show the window in front, on this Space
    case 'open':
      await app.shell.open(action.url);
      return;
  }
}

/** A navigation event. When the main window's page finishes loading, tell it the status bar state.
 *  It answers no policy ask (so every navigation is allowed, as before). */
export async function onNavigate(info: MacNavEvent, app: MacApp): Promise<void> {
  if (info.window !== 'main' || info.kind !== 'finish' || info.isMainFrame === false) return;
  await statusBarRead;
  pushStatusBar(app);
}
