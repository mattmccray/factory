// The Tiny JS backend adapter: the only file that touches Tiny or txiki.js. It wires the shell's
// runtime-neutral logic (shell.ts, autostart.ts) to Tiny's `app.tray`, `app.icon`, `app.badge`,
// `app.notify`, and `onTray`, and to txiki's `tjs.spawn` (for the agent, and for curl: see curl.ts). `bun run
// andon:shell:build` bundles it into build/backend.js, the plain-JS entry tinyjs.json names.
// The window's page (the agent-served UI) gets no Tiny API: tinyjs.json's `api` gate denies it all.
import { QUIT_ID, SHOW_ID, trayNotice } from './badge';
import type { TraySpec } from './badge';
import { agentCommand, agentUrl, DEFAULT_PORT, ensureAgent, probeAgent, resolvePort } from './autostart';
import type { Agent, Child } from './autostart';
import { curlArgv, responseFromCurl } from './curl';
import type { Http } from './http';
import type { DockLook } from './lantern';
import { startShell } from './shell';
import type { Shell } from './shell';
import { oneAtATime, trayClickAction } from './trayclick';

// ---- the little of txiki.js and Tiny this adapter uses (no `any`; see ~/.tinyjs/template/types) ----

interface TjsProcess {
  readonly stdout: ReadableStream<Uint8Array> | null;
  kill(signal?: string): void;
  wait(): Promise<{ exit_status: number; term_signal: string | null }>;
}
interface Tjs {
  readonly env: Record<string, string>;
  spawn(args: string[], opts?: { env?: Record<string, string>; stdin?: 'ignore' | 'inherit' | 'pipe'; stdout?: 'ignore' | 'inherit' | 'pipe'; stderr?: 'ignore' | 'inherit' | 'pipe' }): TjsProcess;
}
declare const tjs: Tjs;

export interface TinyTraySpec extends TraySpec {
  /** A png path (absolute or project-relative). */
  icon?: string;
  /** On: a one-color image that adapts to light and dark menu bars. */
  template?: boolean;
}
/** The fields of Tiny's window state this adapter reads. */
export interface TinyWinState {
  minimized: boolean;
  fullscreen: boolean;
  allSpaces: boolean;
}
interface TinyWindow {
  show(): void;
  restore(): void;
  /** On: the window joins every Space (and floats over fullscreen apps); off: back to one Space. */
  setAllSpaces(on: boolean): void;
  /** Resolves null when there is no state to give. */
  getState(): Promise<TinyWinState | null>;
  eval(js: string): void;
}
/** The backend `app` object Tiny passes to `init` and the hooks. */
export interface TinyApp {
  tray: { set(spec: TinyTraySpec): void };
  /** Replaces the Dock icon from a png; '' resets it to the bundle icon (tinyjs.json's `icon`). */
  icon(path: string): boolean;
  /** The Dock badge; '' clears it. */
  badge(text: string): boolean;
  notify(title: string, body?: string, opts?: { subtitle?: string }): Promise<boolean>;
  window(id: string): TinyWindow;
  /** Main-window op: the close button hides the window instead of quitting. */
  setHideOnClose(on: boolean): void;
  quit(): void;
  /** Settles when the launcher closes (⌘Q, or the app menu's Quit); Tiny exits right after. */
  done?: Promise<unknown>;
}

// Fixed at build time by build.ts (`Bun.build` `define`).
declare const __ANDON_REPO__: string;
declare const __ANDON_BUN__: string;

// ---- the lantern images ----
// By absolute path under the repo: Tiny doesn't ship `assets/` as runtime data, and the repo path
// is fixed at build time (the same one the agent is started from), so it works in `tinyjs dev`
// and in a built app alike.

export const assetPath = (repo: string, file: string): string => `${repo.replace(/\/+$/, '')}/apps/andon-shell/assets/${file}`;

/** The Dock icon for a look: '' (the bundle's unlit icon.png) for idle, else the lit lantern. */
export const dockIcon = (repo: string, look: DockLook): string =>
  look === 'idle' ? '' : assetPath(repo, look === 'running' ? 'dock-running.png' : 'dock-escalated.png');

/** The tray lantern: outlined when no jobs are running, filled when they are. */
export const trayIcon = (repo: string, running: boolean): string => assetPath(repo, running ? 'tray-running.png' : 'tray-idle.png');

export function setDock(app: TinyApp, repo: string, look: DockLook): void {
  if (!app.icon(dockIcon(repo, look))) console.log(`andon-shell: could not set the ${look} Dock icon`);
}

export const setTray = (app: TinyApp, repo: string, spec: TraySpec, running: boolean): void =>
  app.tray.set({ ...spec, icon: trayIcon(repo, running), template: true });

/** No board to show (the agent hasn't answered, or never will): the idle look, no badge, and the notice. */
function showNotice(app: TinyApp, repo: string, text: string): void {
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
        p.kill('SIGTERM'); // the agent's own handler stops its watchers and exits
      } catch {
        // already gone
      }
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- lifecycle ----

let shell: Shell | null = null;
let agent: Agent | null = null;
let quitting = false;

function stopAll(): void {
  quitting = true;
  shell?.stop();
  shell = null;
  agent?.stop(); // a no-op for an agent the shell found already running
  agent = null;
}

export function init(app: TinyApp): void {
  quitting = false; // a fresh lifecycle (Tiny calls init once; tests call it after a Quit)
  const port = resolvePort(tjs.env);
  const url = agentUrl(port);
  const http = curlHttp(url);
  const repo = __ANDON_REPO__;
  showNotice(app, repo, 'starting the agent');
  app.setHideOnClose(true);
  // ⌘Q skips onTray: stop our agent before Tiny exits (kill is synchronous).
  void app.done?.then(stopAll, stopAll);

  void (async () => {
    agent = await ensureAgent({
      probe: () => probeAgent(http),
      spawn: spawnChild,
      sleep,
      command: agentCommand(__ANDON_REPO__, __ANDON_BUN__),
      port,
    });
    if (quitting) return stopAll();
    if (!agent.ok) {
      console.log(`andon-shell: ${agent.reason}`);
      showNotice(app, repo, agent.reason);
      return;
    }
    // The window loaded tinyjs.json's URL before the agent answered (or on another port): load it now.
    if (agent.started || port !== DEFAULT_PORT) app.window('main').eval(`location.replace(${JSON.stringify(`${url}/`)})`);
    shell = startShell({
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
const showMain = oneAtATime(async (app: TinyApp): Promise<void> => {
  const main = app.window('main');
  let state: TinyWinState | null;
  try {
    state = await main.getState();
  } catch (err) {
    // No state to decide on: still show the window, just without the Space move.
    console.log(`andon-shell: window state unavailable (${String(err)}); showing the window as is`);
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
export async function onTray(id: string | null, app: TinyApp): Promise<void> {
  if (id === null) return showMain(app);
  if (id === SHOW_ID) app.window('main').show();
  if (id === QUIT_ID) {
    stopAll();
    app.quit();
  }
}
