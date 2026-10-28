// The Tiny JS backend adapter: the only file that touches Tiny or txiki.js. It wires the Mac app's
// runtime-neutral logic (app.ts, autostart.ts, appmenu.ts) to Tiny's `app.tray`, `app.icon`,
// `app.badge`, `app.notify`, `app.menu`, `app.store`, `app.push`, `app.shell`, `app.clipboard`, the
// `onTray`, `onMenu`, `onNavigate`, and `onContextMenu` hooks, and the one custom `api` method, and to
// txiki's `tjs.spawn` and `tjs.stat` (for the service, for curl: see curl.ts, and for a project's
// right-click menu: see projectmenu.ts). `bun run andon:build` bundles it into build/backend.js, the
// plain-JS entry tinyjs.json names.
// The window's page (the service-served UI) gets no Tiny API but the two calls its drag regions make
// (`win.startDrag`, `win.zoom`), the status bar event this adapter pushes (`event.statusbar`), and
// `projectMenu`, which takes a project id (or null) and nothing else: tinyjs.json's `api` gate
// denies the rest.
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
import { GHOSTTY_APP, VSCODE_APP, exitReason, failureText, menuProject, menuRequest, projectMenuItems, resolveAction, t3Candidates } from './projectmenu';
import type { Availability, MenuProject, ProjectAction } from './projectmenu';

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
    menu: Pick<TinyApp['menu'], 'set' | 'update' | 'setContext'>;
    store: Pick<TinyApp['store'], 'get' | 'set'>;
    shell: Pick<TinyApp['shell'], 'open' | 'reveal'>;
    clipboard: Pick<TinyApp['clipboard'], 'write'>;
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
  void refreshApps(); // warm the menu's app check, so the first right-click has it
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

// ---- a project's right-click menu ----
// Tiny's context menu is one setting for the window, not a popup at a point, so the page arms it for
// the project under the pointer (`projectMenu({ project })`) and disarms it elsewhere
// (`{ project: null }`, WebKit's own menu). The page names a project id and nothing else: the root
// comes from the backend's own `/projects` feed, and a click looks it up again.

/** The projects the menu can act on: the ones the backend follows. */
const listedProjects = (): readonly MenuProject[] => andon?.state().projects ?? [];

/** The last app check; null until the first one finishes. */
let apps: Availability | null = null;
/** Bumped by every request, so a slower app check can't set an older project's menu. */
let menuSeq = 0;

export interface RunResult {
  ok: boolean;
  reason: string;
}

/** Runs an argv to its end; ok when it exits 0, else the reason (its last stderr line, or its status). */
async function run(argv: string[]): Promise<RunResult> {
  try {
    const p = tjs.spawn(argv, { env: tjs.env, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
    const [status, stderr] = await Promise.all([p.wait(), p.stderr === null ? Promise.resolve('') : p.stderr.text().catch(() => '')]);
    return status.exit_status === 0 && status.term_signal === null ? { ok: true, reason: '' } : { ok: false, reason: exitReason(status.exit_status, stderr) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** An executable file at this path. */
async function executable(path: string): Promise<boolean> {
  try {
    const s = await tjs.stat(path);
    return s.isFile && (s.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Which apps are there now: `open -Ra` finds VS Code and Ghostty, and `t3` is the first candidate present. */
export async function checkApps(): Promise<Availability> {
  const [vscode, ghostty, present] = await Promise.all([
    run(['open', '-Ra', VSCODE_APP]).then((r) => r.ok),
    run(['open', '-Ra', GHOSTTY_APP]).then((r) => r.ok),
    Promise.all(t3Candidates(tjs.env.HOME).map(async (p) => ((await executable(p)) ? p : null))),
  ]);
  return { vscode, ghostty, t3: present.find((p) => p !== null) ?? null };
}

async function refreshApps(): Promise<Availability> {
  try {
    apps = await checkApps();
  } catch (err) {
    console.log(`andon: could not check the apps for the project menu (${String(err)})`);
  }
  return apps ?? { vscode: false, ghostty: false, t3: null };
}

const sameApps = (a: Availability, b: Availability): boolean => a.vscode === b.vscode && a.ghostty === b.ghostty && a.t3 === b.t3;

/**
 * The page's one call: arm the window's right-click menu for a listed project with a root, or
 * restore WebKit's default menu (for null, an unknown id, or a rootless project). A malformed request
 * does nothing. The menu is set at once from the last app check, then again if a fresh check differs
 * and no newer request came in.
 */
export async function showProjectMenu(params: unknown, app: MacApp, projects: readonly MenuProject[]): Promise<void> {
  const req = menuRequest(params);
  if (req === null) return;
  const seq = ++menuSeq;
  const p = req.project === null ? null : menuProject(projects, req.project);
  if (p === null) {
    app.menu.setContext(null);
    return;
  }
  const known = apps;
  if (known !== null) app.menu.setContext(projectMenuItems(p.id, known));
  const fresh = await refreshApps();
  if (seq !== menuSeq) return;
  if (known === null || !sameApps(known, fresh)) app.menu.setContext(projectMenuItems(p.id, fresh));
}

/** The failure reason of an action, or null when it worked. */
async function perform(app: MacApp, action: ProjectAction, runner: (argv: string[]) => Promise<RunResult>): Promise<string | null> {
  switch (action.kind) {
    case 'copy':
      try {
        return app.clipboard.write({ text: action.root }) ? null : 'the clipboard refused the write';
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    case 'reveal':
      try {
        await app.shell.reveal(action.root);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    case 'spawn': {
      const r = await runner(action.argv);
      return r.ok ? null : r.reason;
    }
  }
}

/** A clicked project menu item: its project looked up again, then the action run. A failure shows one
 *  notification and logs a line; a success shows nothing. An id that resolves to nothing does nothing. */
export async function runProjectItem(id: unknown, app: MacApp, projects: readonly MenuProject[], t3: string | null, runner: (argv: string[]) => Promise<RunResult> = run): Promise<void> {
  const action = resolveAction(id, projects, t3);
  if (action === null) return;
  const reason = await perform(app, action, runner);
  if (reason === null) return;
  const text = failureText(action, reason);
  console.log(`andon: ${text}`);
  await app.notify('Andon', text);
}

/** The page's api: `projectMenu` alone (tinyjs.json's gate enables it by name). */
export const api = {
  projectMenu: (params: unknown, app: MacApp): Promise<void> => showProjectMenu(params, app, listedProjects()),
};

/** A click in the right-click menu. */
export async function onContextMenu(id: string, app: MacApp): Promise<void> {
  await runProjectItem(id, app, listedProjects(), apps?.t3 ?? null);
}
