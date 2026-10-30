// The Tiny JS backend adapter: the only file that touches Tiny or txiki.js. It wires the Mac app's
// runtime-neutral logic (app.ts, autostart.ts, appmenu.ts) to Tiny's `app.tray`, `app.icon`,
// `app.badge`, `app.notify`, `app.menu`, `app.store`, `app.push`, `app.shell`, `app.clipboard`,
// `app.thumbnail` (the Open in apps' icons), the
// `app.win.open` and `app.windows` (the Settings window), the `onTray`, `onMenu`, `onNavigate`, and
// `onContextMenu` hooks, and the five custom `api` methods, and to
// txiki's `tjs.spawn`, `tjs.stat`, and `tjs.remove` (for the service, for curl: see curl.ts, for a project's
// right-click menu: see projectmenu.ts, for a job's: see jobmenu.ts, and for the T3 Code hand-off:
// see handoff.ts). `bun run
// andon:build` bundles it into build/backend.js, the plain-JS entry tinyjs.json names.
// The windows' pages (the service-served UI) get no Tiny API but the two calls the drag regions make
// (`win.startDrag`, `win.zoom`), the two events this adapter pushes (`event.statusbar`, and
// `event.whatsnew` for Help → What's New),
// `projectMenu`, which takes a project id (or null) and nothing else, the Settings window's
// `getSettings` and `setSetting` (see settings.ts), which answer only when Tiny's api meta names the
// Settings window, and `handOff` (see handoff.ts), which takes a project id, a job id, an action, and
// a note, and answers only when the meta names the main window, and `jobMenu` (see jobmenu.ts),
// which takes a project id and a job id and nothing else: tinyjs.json's `api` gate denies the rest.
/// <reference path="../types/tiny.d.ts" />
/// <reference path="../types/tjs.d.ts" />
import { QUIT_ID, SHOW_ID, trayNotice } from './badge';
import type { TraySpec } from './badge';
import { serviceCommand, serviceUrl, DEFAULT_PORT, ensureService, pageUrl, probeService, resolvePort } from './autostart';
import type { Service, Child } from './autostart';
import { curlArgv, responseFromCurl } from './curl';
import { getJson, reason as errorReason } from './http';
import type { Http } from './http';
import { boardPath } from './follow';
import { NOT_ON_BOARD, NO_SESSION, boardJob, copyFailureText, isJobItemId, jobMenuItems, jobMenuRequest, jobSession, openFailureText, parseJobItemId, threadLink } from './jobmenu';
import type { DockLook } from './lantern';
import { startApp } from './app';
import type { App } from './app';
import { bringBackAction, oneAtATime, trayClickAction } from './trayclick';
import { SETTINGS_WINDOW_ID, STATUS_BAR_EVENT, STATUS_BAR_ID, STATUS_BAR_KEY, WHATS_NEW_EVENT, appMenu, menuAction, settingsWindow, statusBarLabel, statusBarPayload, storedHidden, whatsNewPayload } from './appmenu';
import type { SettingsWindowOptions } from './appmenu';
import { DEFAULT_HANDOFF_MODE, T3_HANDOFF_KEY, fromSettingsWindow, settingChange, settingsSnapshot, storedMode } from './settings';
import type { HandoffMode, Settings } from './settings';
import { draftFailureText, draftLink, fromMainWindow, githubRepo, handoffRequest, originArgv, sendArgv, sendFailureText } from './handoff';
import type { HandoffOutcome } from './handoff';
import { APP_NAMES, BUNDLE_IDS, GHOSTTY_APP, OPEN_IN_APPS, VSCODE_APP, appFallbacks, exitReason, failureText, mdfindHit, mdfindQuery, menuProject, menuRequest, projectMenuItems, resolveAction, t3Candidates } from './projectmenu';
import type { AppIcons, Availability, MenuProject, OpenInApp, ProjectAction } from './projectmenu';

// ---- the Tiny this adapter uses ----
// Tiny's and txiki's own declarations (vendored unedited from Tiny's template; `tinyjs
// update-project` refreshes them) type the `tjs` global and the `app` Tiny passes in. MacApp
// picks the members the Mac app calls, so its whole dependence on Tiny is listed here, in one place,
// and the test fakes stay small.

/** The fields of the main window's state the tray click and Settings…'s bring-back step read. */
export type MacWinState = Pick<TinyWinState, 'minimized' | 'fullscreen' | 'allSpaces' | 'visible'>;
/** The window ops the adapter calls. `getState` resolves null when there is no state to give. */
export type MacWindow = Pick<TinyWindowHandle, 'show' | 'restore' | 'setAllSpaces' | 'eval' | 'minimize' | 'zoom' | 'setResizable'> & {
  getState(): Promise<MacWinState | null>;
};
/** The backend `app` object Tiny passes to `init` and the hooks, narrowed to what the Mac app uses.
 *  `icon('')` resets the Dock icon to the bundle icon, `badge('')` clears the badge, and `done`
 *  settles when the launcher closes (⌘Q, or the app menu's Quit). */
export type MacApp = Pick<TinyApp, 'icon' | 'badge' | 'notify' | 'setHideOnClose' | 'quit' | 'push' | 'windows' | 'thumbnail'> &
  Partial<Pick<TinyApp, 'done'>> & {
    tray: Pick<TinyApp['tray'], 'set'>;
    menu: Pick<TinyApp['menu'], 'set' | 'update' | 'setContext'>;
    store: Pick<TinyApp['store'], 'get' | 'set'>;
    shell: Pick<TinyApp['shell'], 'open' | 'reveal'>;
    clipboard: Pick<TinyApp['clipboard'], 'write'>;
    win: Pick<TinyApp['win'], 'open'>;
    window(id: string): MacWindow;
  };
/** The fields of a navigation event `onNavigate` reads. */
export type MacNavEvent = Pick<TinyNavEvent, 'window' | 'kind' | 'isMainFrame'>;
/** What the adapter hands `app.tray.set`. */
export type MacTraySpec = Parameters<MacApp['tray']['set']>[0];

/** Compile-time proof that the app Tiny passes in is a MacApp. */
type Holds<T extends true> = T;
type TinyAppIsMacApp = Holds<TinyApp extends MacApp ? true : false>;
/** Compile-time proof that the Settings window's options are options Tiny's `win.open` takes. */
type SettingsOptionsOpen = Holds<SettingsWindowOptions extends TinyOpenWindowOptions ? true : false>;

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
/** The service's port, as init resolved it: the Settings window loads its page from there. */
let servicePort = DEFAULT_PORT;
/** The service's GET, as init built it: the job menu fetches a project's board through it. */
let serviceHttp: Http | null = null;

// ---- the status bar choice ----
// Read from the store once at init; every change (the View menu toggle, ⌘/, or the Settings window)
// goes through setStatusBar, which writes it back, relabels the View menu, and pushes the status bar
// event to every window. The main window's page only listens (after its main frame loads and after
// every change); the Settings window also asks for it (getSettings).

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

/** The one path for a status bar change: the state, the store, the View menu label, and the push to
 *  every window. Setting the value it already holds changes nothing. */
async function setStatusBar(app: MacApp, hidden: boolean): Promise<void> {
  await statusBarRead;
  if (hidden === statusBarHidden) return;
  statusBarHidden = hidden;
  const saved = app.store.set(STATUS_BAR_KEY, hidden);
  app.menu.update(STATUS_BAR_ID, { label: statusBarLabel(hidden) });
  pushStatusBar(app);
  if (!(await saved)) console.log('andon: could not save the status bar choice');
}

async function toggleStatusBar(app: MacApp): Promise<void> {
  await statusBarRead;
  return setStatusBar(app, !statusBarHidden);
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
  servicePort = port;
  const url = serviceUrl(port);
  const http = curlHttp(url);
  serviceHttp = http;
  const repo = __ANDON_REPO__;
  statusBarRead = readStatusBar(app);
  void refreshApps(app); // warm the menu's app check, so the first right-click has it
  resetIcons();
  void lookupIcons(app, OPEN_IN_APPS); // the Open in icons, in the background: the menu never waits on them
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

/** Settings…'s first step: bring the main window back, restoring it if minimized and showing it if
 *  hidden, so its child, the Settings window, is visible too. No state: show it as is. A step that
 *  throws is logged, and Settings… still goes on. */
async function bringBackMain(app: MacApp): Promise<void> {
  const main = app.window('main');
  let state: MacWinState | null;
  try {
    state = await main.getState();
  } catch (err) {
    console.log(`andon: window state unavailable (${String(err)}); showing the window as is`);
    state = null;
  }
  const action = bringBackAction(state);
  try {
    if (action.restore) main.restore();
    if (action.show) main.show();
  } catch (err) {
    console.log(`andon: could not bring the main window back (${String(err)})`);
  }
}

/** Settings…: bring the main window back, then open the Settings window (a child of it), or, when it
 *  is already open, show and focus it. One click at a time, so a quick second click can't open a
 *  second window while the first is still opening. */
const openSettings = oneAtATime(async (app: MacApp): Promise<void> => {
  await bringBackMain(app);
  let open: string[];
  try {
    open = await app.windows();
  } catch (err) {
    console.log(`andon: could not list the windows (${String(err)})`);
    open = [];
  }
  if (open.includes(SETTINGS_WINDOW_ID)) {
    app.window(SETTINGS_WINDOW_ID).show(); // brings it to the front, above the main window, and focuses it
    return;
  }
  app.win.open(SETTINGS_WINDOW_ID, settingsWindow(servicePort));
  app.window(SETTINGS_WINDOW_ID).setResizable(false);
});

/** A click in the menu bar. An id that isn't ours does nothing. */
export async function onMenu(id: string, app: MacApp): Promise<void> {
  const action = menuAction(id);
  if (action === null) return;
  switch (action.kind) {
    case 'open-settings':
      return openSettings(app);
    case 'toggle-status-bar':
      return toggleStatusBar(app);
    case 'minimize':
      return app.window('main').minimize();
    case 'zoom':
      return app.window('main').zoom();
    case 'show-main':
      return showMain(app); // the tray's left click: show the window in front, on this Space
    case 'whats-new':
      // Show the board as the tray click does, then ask its page to open What's New; the page routes
      // itself (its hash and history) and keeps its focused project. Nothing else is sent.
      await showMain(app);
      app.push(WHATS_NEW_EVENT, whatsNewPayload());
      return;
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
/** The project menu set now (its project id and the request that set it), or null when another menu (or none) is. */
let armedProject: { pid: string; seq: number } | null = null;
/** Bumped by every request (project or job), so a slower app check or board fetch can't set an older menu. */
let menuSeq = 0;
/** The job menu set now (its `<pid>/<job id>` and whether Open in T3 Code is enabled), or null when
 *  another menu (or none) is. */
let armedJob: { key: string; canOpen: boolean } | null = null;

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

/** Runs an argv to its end and gives its stdout when it exits 0; null when it fails or can't start. */
async function output(argv: string[]): Promise<string | null> {
  try {
    const p = tjs.spawn(argv, { env: tjs.env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
    const [status, stdout] = await Promise.all([p.wait(), p.stdout === null ? Promise.resolve(null) : p.stdout.text().catch(() => null)]);
    return status.exit_status === 0 && status.term_signal === null ? stdout : null;
  } catch {
    return null;
  }
}

/** The first `t3` candidate that is an executable file now, or null. */
export async function findT3(): Promise<string | null> {
  const present = await Promise.all(t3Candidates(tjs.env.HOME).map(async (p) => ((await executable(p)) ? p : null)));
  return present.find((p) => p !== null) ?? null;
}

/** Which apps are there now: `open -Ra` finds VS Code and Ghostty, and `t3` is the first candidate present. */
export async function checkApps(): Promise<Availability> {
  const [vscode, ghostty, t3] = await Promise.all([run(['open', '-Ra', VSCODE_APP]).then((r) => r.ok), run(['open', '-Ra', GHOSTTY_APP]).then((r) => r.ok), findT3()]);
  return { vscode, ghostty, t3 };
}

async function refreshApps(app: MacApp): Promise<Availability> {
  try {
    const [checked, found] = await Promise.all([checkApps(), checkFound()]);
    apps = checked;
    noteFound(app, found);
  } catch (err) {
    console.log(`andon: could not check the apps for the project menu (${String(err)})`);
  }
  return apps ?? NO_APPS;
}

const NO_APPS: Availability = { vscode: false, ghostty: false, t3: null };

// ---- the Open in apps' own icons (043) ----
// Each app's `.app` is found by bundle id (Spotlight, then /Applications and ~/Applications), and
// Tiny's `thumbnail()` renders its icon to a temp png the backend owns for the session. All three are
// looked up once at launch, in the background; after that an app is looked up again only when the
// app check sees its `.app` appear (`open -Rb <bundle id>`), and its icon is dropped when it goes.
// A replaced or dropped png is deleted (best effort). The menu never waits on an icon: when a lookup
// lands, the armed project menu is set again.

/** The icon png of each app found so far. */
let icons: AppIcons = {};
/** Whether each app's `.app` was found on the last app check; null before the first. */
let found: Record<OpenInApp, boolean> | null = null;
/** Bumped per app by every lookup or drop, so a slower lookup can't land over a newer one. */
const iconSeq: Record<OpenInApp, number> = { vscode: 0, t3: 0, ghostty: 0 };

/** A fresh lifecycle: no icons (their pngs deleted), no found state, and any lookup still running ignored. */
function resetIcons(): void {
  for (const a of OPEN_IN_APPS) ++iconSeq[a];
  for (const path of Object.values(icons)) if (path !== undefined) void removePng(path);
  icons = {};
  found = null;
}

/** Whether each app's `.app` is there now, by bundle id (LaunchServices: no Spotlight, no thumbnail). */
export async function checkFound(): Promise<Record<OpenInApp, boolean>> {
  const [vscode, t3, ghostty] = await Promise.all(OPEN_IN_APPS.map((a) => run(['open', '-Rb', BUNDLE_IDS[a]]).then((r) => r.ok)));
  return { vscode: vscode === true, t3: t3 === true, ghostty: ghostty === true };
}

/** A directory at this path (a `.app` is one). */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await tjs.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

/** An app's `.app`: Spotlight's first hit for its bundle id, else the first fallback present, else null. */
export async function findAppBundle(which: OpenInApp): Promise<string | null> {
  const out = await output(['mdfind', mdfindQuery(which)]);
  if (out === null) console.log(`andon: mdfind failed for ${APP_NAMES[which]}; trying the Applications folders`);
  const hit = mdfindHit(out);
  if (hit !== null) return hit;
  for (const p of appFallbacks(which, tjs.env.HOME)) if (await isDirectory(p)) return p;
  return null;
}

/** An app's icon png: its `.app` found, then `app.thumbnail(<.app>, 32)`. Null, with a line logged,
 *  when there is no `.app` or the thumbnail fails. Never throws. */
export async function lookupIcon(app: MacApp, which: OpenInApp): Promise<string | null> {
  const name = APP_NAMES[which];
  let bundle: string | null;
  try {
    bundle = await findAppBundle(which);
  } catch (err) {
    console.log(`andon: could not look for ${name} (${errorReason(err)}); no icon`);
    return null;
  }
  if (bundle === null) {
    console.log(`andon: no ${name} app found; no icon`);
    return null;
  }
  try {
    const thumb = await app.thumbnail(bundle, 32);
    if (typeof thumb.path === 'string' && thumb.path !== '') return thumb.path;
    console.log(`andon: the ${name} thumbnail gave no png; no icon`);
  } catch (err) {
    console.log(`andon: could not make the ${name} icon (${errorReason(err)}); no icon`);
  }
  return null;
}

/** Deletes a temp png the backend owns; a failure is logged and nothing else. */
async function removePng(path: string): Promise<void> {
  try {
    await tjs.remove(path);
  } catch (err) {
    console.log(`andon: could not delete the old icon ${path} (${errorReason(err)})`);
  }
}

/** Puts an app's icon in place (or drops it, for null), deleting the png it replaces, and sets the
 *  armed project menu again when the icon changed. */
function setIcon(app: MacApp, which: OpenInApp, path: string | null): void {
  const old = icons[which];
  if (old === (path ?? undefined)) return;
  const next: AppIcons = { ...icons };
  if (path === null) delete next[which];
  else next[which] = path;
  icons = next;
  if (old !== undefined) void removePng(old);
  rearmProjectMenu(app);
}

/** Looks up these apps' icons, each on its own; each lands when it is done. */
async function lookupIcons(app: MacApp, which: readonly OpenInApp[]): Promise<void> {
  await Promise.all(
    which.map(async (a) => {
      const seq = ++iconSeq[a];
      const path = await lookupIcon(app, a);
      if (seq !== iconSeq[a]) {
        if (path !== null && path !== icons[a]) void removePng(path); // a newer lookup or drop won
        return;
      }
      setIcon(app, a, path);
    }),
  );
}

/** One app check's found/missing state: an app that appeared is looked up again, one that went has
 *  its icon dropped; an app that didn't change runs nothing. The first check only records it (the
 *  launch lookup covers it). */
function noteFound(app: MacApp, now: Record<OpenInApp, boolean>): void {
  const before = found;
  found = now;
  if (before === null) return;
  const appeared = OPEN_IN_APPS.filter((a) => now[a] && !before[a]);
  for (const a of OPEN_IN_APPS.filter((x) => !now[x] && before[x])) {
    ++iconSeq[a];
    setIcon(app, a, null);
  }
  if (appeared.length > 0) void lookupIcons(app, appeared);
}

/** Sets the armed project menu again with the icons now known, if it is still armed and no newer request came in. */
function rearmProjectMenu(app: MacApp): void {
  const armed = armedProject;
  if (armed === null || armed.seq !== menuSeq) return;
  app.menu.setContext(projectMenuItems(armed.pid, apps ?? NO_APPS, icons));
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
  armedJob = null;
  armedProject = null;
  const p = req.project === null ? null : menuProject(projects, req.project);
  if (p === null) {
    app.menu.setContext(null);
    return;
  }
  armedProject = { pid: p.id, seq };
  const known = apps;
  if (known !== null) app.menu.setContext(projectMenuItems(p.id, known, icons));
  const fresh = await refreshApps(app);
  if (seq !== menuSeq) return;
  if (known === null || !sameApps(known, fresh)) app.menu.setContext(projectMenuItems(p.id, fresh, icons));
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

// ---- the Settings window's two methods ----
// Answered only when Tiny's api meta names the Settings window (settings.ts `fromSettingsWindow`):
// from any other window they return null and change nothing.

/** The stored T3 Code hand-off mode; the default (draft) when nothing valid is stored or the store fails. */
async function readHandoffMode(app: MacApp): Promise<HandoffMode> {
  try {
    return storedMode(await app.store.get(T3_HANDOFF_KEY));
  } catch (err) {
    console.log(`andon: could not read the T3 Code choice (${String(err)}); using ${DEFAULT_HANDOFF_MODE}`);
    return DEFAULT_HANDOFF_MODE;
  }
}

/** The settings: the stored choices (the status bar once init has read it), and whether `t3` is there now. */
async function snapshot(app: MacApp): Promise<Settings> {
  await statusBarRead;
  const [t3Handoff, t3] = await Promise.all([readHandoffMode(app), findT3()]);
  return settingsSnapshot({ statusBarHidden, t3Handoff }, t3 !== null);
}

/** The settings, from the stored choices (once init has read them); null for any other window. */
export async function getSettings(app: MacApp, meta: unknown): Promise<Settings | null> {
  if (!fromSettingsWindow(meta)) return null;
  return snapshot(app);
}

/** One validated change from the Settings window, applied on the shared path; then the settings.
 *  Null, with nothing changed, for any other window or a malformed change. */
export async function setSetting(params: unknown, app: MacApp, meta: unknown): Promise<Settings | null> {
  if (!fromSettingsWindow(meta)) return null;
  const change = settingChange(params);
  if (change === null) return null;
  switch (change.key) {
    case 'statusBarHidden':
      await setStatusBar(app, change.value);
      break;
    case 't3Handoff':
      if (!(await app.store.set(T3_HANDOFF_KEY, change.value))) console.log('andon: could not save the T3 Code choice');
      break;
  }
  return snapshot(app);
}

// ---- handing a needs-human command to T3 Code (036) ----
// Answered only when Tiny's api meta names the main window (handoff.ts `fromMainWindow`). The page
// has already copied its own command; this builds the command again from the checked request, and,
// as the T3 Code setting says, opens it as a draft (by the project's GitHub origin) or sends it to a
// new thread (in the project folder), each as an argv with no shell. A request that fails a check
// does nothing and answers null.

/** What the hand-off needs from the host; tests pass fakes. */
export interface HandoffHost {
  projects(): readonly MenuProject[];
  findT3(): Promise<string | null>;
  /** A project root's `origin` URL (git's output), or null when git fails. */
  origin(root: string): Promise<string | null>;
  run(argv: string[]): Promise<RunResult>;
}

/** The real host: the listed projects, the `t3` lookup, git, and the runner. */
export const hostHandoff: HandoffHost = {
  projects: () => listedProjects(),
  findT3: () => findT3(),
  origin: (root) => output(originArgv(root)),
  run: (argv) => run(argv),
};

/** One failure: logged, and one notification. */
async function notifyFailure(app: MacApp, text: string): Promise<void> {
  console.log(`andon: ${text}`);
  await app.notify('Andon', text);
}

/** The hand-off running now, if any: a second click while one runs is dropped (answers null). */
let handing = false;

/**
 * The main window's hand-off: the request checked (handoff.ts `handoffRequest`), then, by the T3 Code
 * setting, a draft opened (`open <prompt link>`, only with a GitHub `repo`) or the command sent
 * (`<t3> thread start --title "<action> <job>" <root> <command>`). Copy mode or no `t3`: nothing
 * runs, "copy-only". A failed open or send notifies, and answers "copy-only" (the page copied).
 * Null, with nothing run, opened, or notified, for any other window, a request that fails a check,
 * or a hand-off already running.
 */
export async function handOff(params: unknown, app: MacApp, meta: unknown, host: HandoffHost = hostHandoff): Promise<HandoffOutcome | null> {
  if (!fromMainWindow(meta)) return null;
  const h = handoffRequest(params, host.projects());
  if (h === null || handing) return null;
  handing = true;
  try {
    const mode = await readHandoffMode(app);
    if (mode === 'copy') return 'copy-only';
    const t3 = await host.findT3();
    if (t3 === null) return 'copy-only';
    if (mode === 'draft') {
      const repo = githubRepo(await host.origin(h.project.root));
      if (repo === null) return 'no-github-remote';
      const r = await host.run(['open', draftLink(h.command, repo)]);
      if (r.ok) return 'drafted';
      await notifyFailure(app, draftFailureText(r.reason));
      return 'copy-only';
    }
    const r = await host.run(sendArgv(t3, h));
    if (r.ok) return 'sent';
    await notifyFailure(app, sendFailureText(r.reason));
    return 'copy-only';
  } finally {
    handing = false;
  }
}

// ---- a job's right-click menu (040) ----
// Armed like the project menu: the page names the job under the pointer by its project id and job id
// (`jobMenu({ project, job })`), and nothing else. The project must be in the backend's `/projects`
// list and the job id of the factory form; the job and its `session` come from the project's board,
// fetched from the service over its HTTP (never from files), and the link is built only from that
// `session`. A click fetches the board again and checks everything again.

/** What the job menu needs from the host; tests pass fakes. */
export interface JobMenuHost {
  projects(): readonly MenuProject[];
  /** The project's board payload from the service that listed it; rejects when it can't be read. */
  board(pid: string): Promise<unknown>;
  findT3(): Promise<string | null>;
}

/** The real host: the listed projects, the board from the local service, and the `t3` lookup. */
export const hostJobMenu: JobMenuHost = {
  projects: () => listedProjects(),
  board: async (pid) => {
    if (serviceHttp === null) throw new Error('the Andon service is not running');
    return getJson(serviceHttp, boardPath(pid));
  },
  findT3: () => findT3(),
};

const isListedProject = (projects: readonly MenuProject[], pid: string): boolean => projects.some((p) => p.id === pid);

/**
 * The page's job menu ask: for a listed project and a job id of the factory form, the menu (Open in
 * T3 Code grayed out until the board and the `t3` lookup say it can open), then, once the board is
 * fetched, Open in T3 Code enabled only when `t3` is found and the job's `session` passes the check.
 * A job missing from the board restores WebKit's menu. A malformed request, an unknown project, or a
 * bad job id restores WebKit's menu too. A newer ask (of either menu) wins over a slower fetch.
 */
export async function showJobMenu(params: unknown, app: MacApp, host: JobMenuHost = hostJobMenu): Promise<void> {
  const seq = ++menuSeq;
  armedProject = null;
  const req = jobMenuRequest(params);
  if (req === null || !isListedProject(host.projects(), req.project)) {
    armedJob = null;
    app.menu.setContext(null);
    return;
  }
  const key = `${req.project}/${req.job}`;
  // The same job asked again (the opening press): keep its menu as it is until the fresh answer.
  if (armedJob?.key !== key) setJobMenu(app, req.project, req.job, false);
  const [fetched, t3] = await Promise.all([
    host.board(req.project).then(
      (board): { ok: true; board: unknown } => ({ ok: true, board }),
      (err: unknown): { ok: false } => {
        console.log(`andon: could not fetch the board for the job menu of ${req.job} (${errorReason(err)})`);
        return { ok: false };
      },
    ),
    host.findT3().catch(() => null),
  ]);
  if (seq !== menuSeq) return;
  // A board that answered without the job: no such job to name, so WebKit's menu. A failed fetch keeps
  // the menu, grayed out (Copy Job ID still works).
  const job = fetched.ok ? boardJob(fetched.board, req.job) : null;
  if (fetched.ok && job === null) {
    armedJob = null;
    app.menu.setContext(null);
    return;
  }
  const canOpen = t3 !== null && job !== null && jobSession(job) !== null;
  if (armedJob?.key !== key || armedJob.canOpen !== canOpen) setJobMenu(app, req.project, req.job, canOpen);
}

function setJobMenu(app: MacApp, pid: string, job: string, canOpen: boolean): void {
  armedJob = { key: `${pid}/${job}`, canOpen };
  app.menu.setContext(jobMenuItems(pid, job, canOpen));
}

/** The thread link for a job, from a freshly fetched board, or the reason there is none. */
async function freshLink(host: JobMenuHost, pid: string, job: string): Promise<{ link: string } | { reason: string }> {
  let board: unknown;
  try {
    board = await host.board(pid);
  } catch (err) {
    return { reason: errorReason(err) };
  }
  const j = boardJob(board, job);
  if (j === null) return { reason: NOT_ON_BOARD };
  const session = jobSession(j);
  if (session === null) return { reason: NO_SESSION };
  return { link: threadLink(session) };
}

/**
 * A clicked job menu item. Its id is checked (ours, a listed project, a job id of the factory form),
 * then Copy Job ID writes that job id, and Open in T3 Code, with `t3` found, fetches the board again,
 * checks the job's `session` again, and opens the link built from it. A failure shows one
 * notification and logs a line; an id that resolves to nothing, or no `t3` found, does nothing.
 */
export async function runJobItem(id: unknown, app: MacApp, host: JobMenuHost = hostJobMenu): Promise<void> {
  const parsed = parseJobItemId(id);
  if (parsed === null || !isListedProject(host.projects(), parsed.pid)) return;
  const { item, pid, job } = parsed;
  if (item === 'copy') {
    let failed: string | null;
    try {
      failed = app.clipboard.write({ text: job }) ? null : 'the clipboard refused the write';
    } catch (err) {
      failed = errorReason(err);
    }
    if (failed !== null) await notifyFailure(app, copyFailureText(job, failed));
    return;
  }
  if ((await host.findT3().catch(() => null)) === null) return;
  const found = await freshLink(host, pid, job);
  if ('reason' in found) return notifyFailure(app, openFailureText(job, found.reason));
  let failed: string | null;
  try {
    failed = (await app.shell.open(found.link)) === true ? null : 'T3 Code did not open the link';
  } catch (err) {
    failed = errorReason(err);
  }
  if (failed !== null) await notifyFailure(app, openFailureText(job, failed));
}

/** The pages' api: `projectMenu`, `getSettings`, `setSetting`, `handOff`, and `jobMenu` (tinyjs.json's gate enables each by name). */
export const api = {
  projectMenu: (params: unknown, app: MacApp): Promise<void> => showProjectMenu(params, app, listedProjects()),
  getSettings: (_params: unknown, app: MacApp, meta: unknown): Promise<Settings | null> => getSettings(app, meta),
  setSetting: (params: unknown, app: MacApp, meta: unknown): Promise<Settings | null> => setSetting(params, app, meta),
  handOff: (params: unknown, app: MacApp, meta: unknown): Promise<HandoffOutcome | null> => handOff(params, app, meta),
  jobMenu: (params: unknown, app: MacApp): Promise<void> => showJobMenu(params, app),
};

/** A click in the right-click menu: a `job-menu:` id goes to the job menu, every other id to the project menu. */
export async function onContextMenu(id: string, app: MacApp): Promise<void> {
  if (isJobItemId(id)) return runJobItem(id, app);
  await runProjectItem(id, app, listedProjects(), apps?.t3 ?? null);
}
