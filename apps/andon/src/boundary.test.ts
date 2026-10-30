// The Mac app's boundaries: no contract, service, or UI code runs in it, its logic is runtime-neutral
// (AC5), only backend.ts names Tiny or txiki (through Tiny's own vendored types, narrowed to
// `MacApp`), the window loads the service on loopback with the page's Tiny API denied but for its
// drag regions, the status bar event the Mac app pushes (AC6), the one project menu method, the
// Settings window's two settings methods (035), the main window's hand-off method (036), and the
// job menu method (040), the
// Mac app pins the Tiny JS it was tested on, and the backend entry is the Bun bundle of backend.ts.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKEND_OUT, appVersion, bundleBackend } from '../build';
import { GET_ABOUT_METHOD } from './about';
import { BACKLOG_EVENT, INSPECTOR_EVENT, MERGED_EVENT, NEEDS_ME_EVENT, SETTLED_EVENT, SIDEBAR_EVENT, STATUS_BAR_EVENT, WHATS_NEW_EVENT } from './appmenu';
import { DEFAULT_PORT, pageUrl } from './autostart';
import { PROJECT_MENU_METHOD } from './projectmenu';
import { GET_SETTINGS_METHOD, SET_SETTING_METHOD, VIEW_STATE_METHOD } from './settings';
import { HAND_OFF_METHOD } from './handoff';
import { JOB_MENU_METHOD } from './jobmenu';
import { isRecord } from './state';

const appDir = join(import.meta.dir, '..');
const repoDir = join(appDir, '..', '..');
const ADAPTER = 'backend.ts';
const sources = readdirSync(import.meta.dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

/** Every module specifier a file names: `import ... from`, `export ... from`, a bare `import '...'`, and `import()`. */
function specifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)) if (m[1] !== undefined) out.push(m[1]);
  return out;
}

/** An import the Mac app may not make: any `@factory/*` package, the UI (`apps/andon-ui`), or the service (`andon-service`). */
const forbiddenImport = (s: string): boolean => s.startsWith('@factory/') || /(^|\/)andon-ui(\/|$)/.test(s) || s.includes('andon-service');

const readJson = (path: string): Record<string, unknown> => {
  const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(v)) throw new Error(`${path} is not an object`);
  return v;
};

describe('AC5: the Mac app runs no contract, service, or UI code', () => {
  test('the scan sees the logic modules and the adapter', () => {
    expect(sources).toContain(ADAPTER);
    for (const f of ['sse.ts', 'follow.ts', 'badge.ts', 'lantern.ts', 'notify.ts', 'autostart.ts', 'trayclick.ts', 'appmenu.ts', 'projectmenu.ts', 'settings.ts', 'handoff.ts', 'jobmenu.ts', 'about.ts']) expect(sources).toContain(f);
  });

  test('the import matcher flags @factory/*, the UI, and the service, not the Mac app itself', () => {
    for (const s of ['@factory/contract', '@factory/andon-service', '@factory/andon-ui', '@factory/andon', '../../andon-ui/src/api', 'apps/andon-ui/src/live', '../../../packages/andon-service/src/index', 'andon-service']) {
      expect({ s, bad: forbiddenImport(s) }).toEqual({ s, bad: true });
    }
    for (const s of ['./sse', './app', '../build', '../../andon/src/badge', 'apps/andon/src/state']) {
      expect({ s, bad: forbiddenImport(s) }).toEqual({ s, bad: false });
    }
  });

  test('no source imports an @factory/* package, apps/andon-ui, or andon-service', () => {
    for (const f of sources) {
      const text = readFileSync(join(import.meta.dir, f), 'utf8');
      for (const s of specifiers(text)) {
        expect({ file: f, specifier: s, bad: forbiddenImport(s) }).toEqual({ file: f, specifier: s, bad: false });
      }
      expect(text).not.toMatch(/@factory\/(contract|andon-service|andon-ui)/);
    }
  });

  test('the logic modules import only each other: no bun:*, node:*, or tjs', () => {
    for (const f of sources.filter((x) => x !== ADAPTER)) {
      for (const s of specifiers(readFileSync(join(import.meta.dir, f), 'utf8'))) {
        expect({ file: f, specifier: s, local: /^\.\/[a-z]+$/.test(s) }).toEqual({ file: f, specifier: s, local: true });
      }
    }
    // the adapter's imports are local too: Tiny and txiki are globals, typed by Tiny's vendored types/
    for (const s of specifiers(readFileSync(join(import.meta.dir, ADAPTER), 'utf8'))) expect(s).toMatch(/^\.\/[a-z]+$/);
  });

  test('package.json has no dependencies and never names @factory/contract', () => {
    const pkg = readJson(join(appDir, 'package.json'));
    expect(pkg.name).toBe('@factory/andon');
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies).toBeUndefined();
    expect(JSON.stringify(pkg)).not.toContain('@factory/contract');
  });
});

/** Names Tiny or txiki in code: the `tjs` or `tiny` global, or a `Tiny*` type. Not the prose word "Tiny". */
const NAMES_TINY = /\btjs\b|\btiny\b|\bTiny[A-Z]\w*/;
/** A triple-slash reference to a file under a `types/` directory. */
const TYPES_REFERENCE = /^\s*\/\/\/\s*<reference\s+path\s*=\s*["'][^"']*\btypes\//m;

describe('only backend.ts names Tiny or txiki', () => {
  test('the matcher flags the globals and Tiny types, not the prose word', () => {
    for (const code of ["tjs.spawn(['curl'], {})", 'const e = tjs.env;', 'tiny.api.call()', 'function f(app: TinyApp) {}', 'let s: TinyWinState | null', 'const t: TinyTraySpec = {}']) {
      expect({ code, flagged: NAMES_TINY.test(code) }).toEqual({ code, flagged: true });
    }
    for (const prose of ['// The Tiny JS app: the runtime-neutral part.', '/** Tiny calls init once. */', 'const tinyish = 1;', 'const myTjs = 2;', 'const Tiny = 3;']) {
      expect({ prose, flagged: NAMES_TINY.test(prose) }).toEqual({ prose, flagged: false });
    }
  });

  test('no source other than backend.ts names tjs, tiny, or a Tiny* type', () => {
    for (const f of sources.filter((x) => x !== ADAPTER)) {
      const hit = readFileSync(join(import.meta.dir, f), 'utf8').match(NAMES_TINY)?.[0] ?? null;
      expect({ file: f, names: hit }).toEqual({ file: f, names: null });
    }
  });
});

describe("backend.ts types the adapter with Tiny's vendored types, narrowed to MacApp", () => {
  const adapter = readFileSync(join(import.meta.dir, ADAPTER), 'utf8');

  test('the vendored types are present', () => {
    for (const f of ['tiny.d.ts', 'tjs.d.ts']) expect(existsSync(join(appDir, 'types', f))).toBe(true);
    expect(readdirSync(join(appDir, 'types')).sort()).toEqual(['tiny.d.ts', 'tjs.d.ts']);
  });

  test('it references both vendored files', () => {
    expect(adapter).toMatch(/^\/\/\/ <reference path="\.\.\/types\/tiny\.d\.ts" \/>$/m);
    expect(adapter).toMatch(/^\/\/\/ <reference path="\.\.\/types\/tjs\.d\.ts" \/>$/m);
  });

  test('it declares no Tiny or txiki interface or global of its own', () => {
    expect(adapter).not.toMatch(/\bdeclare\s+(const|let|var|namespace)\s+(tjs|tiny)\b/);
    for (const name of ['TjsProcess', 'Tjs', 'TinyApp', 'TinyWindow', 'TinyWinState', 'TinyTraySpec']) {
      const declared = new RegExp(`\\b(interface|type|class)\\s+${name}\\b`).test(adapter);
      expect({ name, declared }).toEqual({ name, declared: false });
    }
  });

  test("it exports MacApp, a Pick of Tiny's TinyApp, and the adapter's entry points take it", () => {
    expect(adapter).toMatch(/^export type MacApp = Pick<TinyApp, [^>]+>/m);
    expect(adapter).toMatch(/\bexport function init\(app: MacApp\)/);
    expect(adapter).toMatch(/\bexport async function onTray\(id: string \| null, app: MacApp\)/);
    expect(adapter).toMatch(/\bexport async function onMenu\(id: string, app: MacApp\)/);
    expect(adapter).toMatch(/\bexport async function onNavigate\(info: MacNavEvent, app: MacApp\)/);
    expect(adapter).toMatch(/\bexport async function onContextMenu\(id: string, app: MacApp\)/);
    expect(adapter).toMatch(/\bexport function setDock\(app: MacApp,/);
    expect(adapter).toMatch(/\bexport const setTray = \(app: MacApp,/);
    expect(adapter).toMatch(/\boneAtATime\(async \(app: MacApp\)/);
  });

  test('the reference matcher flags a types/ reference and nothing else', () => {
    expect(TYPES_REFERENCE.test('/// <reference path="../types/tiny.d.ts" />')).toBe(true);
    expect(TYPES_REFERENCE.test("x\n  /// <reference path='types/tjs.d.ts'/>")).toBe(true);
    expect(TYPES_REFERENCE.test('/// <reference types="bun" />')).toBe(false);
    expect(TYPES_REFERENCE.test('/// <reference lib="esnext.disposable" />')).toBe(false);
  });

  test('no other file in the repo references the vendored types', () => {
    const skip = new Set(['node_modules', '.git', 'jobs', '.worktrees', '.lock', 'build', 'dist', '.build']);
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (!skip.has(e.name)) walk(join(dir, e.name));
        } else if (/\.(ts|tsx|mts|cts|js|mjs|svelte)$/.test(e.name) && TYPES_REFERENCE.test(readFileSync(join(dir, e.name), 'utf8'))) {
          hits.push(join(dir, e.name).slice(repoDir.length + 1));
        }
      }
    };
    walk(repoDir);
    expect(hits).toEqual(['apps/andon/src/backend.ts']);
  });

  test("the root tsconfig doesn't include the vendored types", () => {
    const cfg = readJson(join(repoDir, 'tsconfig.json'));
    expect(cfg.include).toEqual(['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts', 'scripts/**/*.ts', 'factory/**/*.ts']);
  });
});

test("065 AC3: the version fixed into the bundle is apps/andon/package.json's, not tinyjs.json's", async () => {
  expect(await appVersion()).toBe(String(readJson(join(appDir, 'package.json')).version));
  expect(await appVersion()).toMatch(/^\d+\.\d+\.\d+/);
});

describe('AC6: tinyjs.json', () => {
  const cfg = readJson(join(appDir, 'tinyjs.json'));

  test('the Mac app pins Tiny JS 0.68.0, the version it was smoke-tested on, and nothing else moved', () => {
    expect(cfg.minTinyjsVersion).toBe('0.68.0');
    expect(cfg).toEqual({
      $schema: 'https://tinyjs.app/schema/tinyjs.schema.json',
      name: 'andon',
      title: 'Andon',
      size: '1280x820',
      minSize: '1100x700',
      id: 'dev.factory.andon',
      version: '0.1.0',
      minTinyjsVersion: '0.68.0',
      icon: 'assets/icon.png',
      url: 'http://127.0.0.1:8766/?shell=mac',
      chrome: { frame: false, windowControls: true, windowControlsPos: { x: 18, y: 20 }, vibrancy: 'sidebar' },
      api: {
        disable: ['*'],
        enable: [
          'win.startDrag',
          'win.zoom',
          'event.statusbar',
          'event.whatsnew',
          'event.merged',
          'event.needsme',
          'event.settled',
          'event.backlog',
          'event.sidebar',
          'event.inspector',
          'projectMenu',
          'getSettings',
          'setSetting',
          'handOff',
          'jobMenu',
          'setViewState',
          'getAbout',
        ],
      },
      about: 'menu',
      backend: 'build/backend.js',
    });
  });

  test('the main window loads the service at http://127.0.0.1:<port>/?shell=mac, the same page the reload uses', () => {
    expect(typeof cfg.url).toBe('string');
    const url = new URL(String(cfg.url));
    expect(url.protocol).toBe('http:');
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toMatch(/^\d+$/);
    expect(url.pathname).toBe('/');
    expect(url.search).toBe('?shell=mac');
    expect(url.hash).toBe('');
    expect(url.port).toBe(String(DEFAULT_PORT));
    expect(String(cfg.url)).toBe(pageUrl(DEFAULT_PORT));
    expect(cfg.mainWindow).not.toBe(false);
  });

  test('the window hides the title bar, keeps the native traffic lights over the sidebar, and floors its size', () => {
    expect(cfg.chrome).toEqual({ frame: false, windowControls: true, windowControlsPos: { x: 18, y: 20 }, vibrancy: 'sidebar' });
    expect(cfg.minSize).toBe('1100x700');
  });

  test('065 AC1: the app menu\'s About item fires the reserved id `about` instead of the stock panel', () => {
    expect(cfg.about).toBe('menu');
  });

  test("the api gate denies every Tiny call for the page except its drag regions, the pushed events, projectMenu, the two settings methods, handOff, jobMenu, setViewState, and getAbout", () => {
    // Tiny's page runtime turns a mousedown on [data-tiny-drag] into `win.startDrag` (a double-click
    // into `win.zoom`), and the backend's gate checks both: they are the narrowest exception. The one
    // event the page may receive is the status bar state the backend pushes (`event.<name>` is how
    // Tiny gates a pushed event). The one backend method the page may call is the project menu's,
    // by its bare name (Tiny gates the app's own api methods that way): it takes a project id only.
    // The Settings window's two methods (035) are named the same way; the backend answers them only
    // for that window. Exactly two entries more than after andon-project-menu (033). The main window's
    // hand-off (036) is the one more after andon-settings (035): the backend answers it only for the
    // main window, and it takes a project id, a job id, an action, and a note, never a command.
    // The job menu (040) is the one more after job 037: it takes a project id and a job id, never a
    // thread id, link, or path. Help → What's New (059) adds the one more pushed event, `whatsnew`:
    // the page only receives it (it carries nothing); no page-callable method is added.
    const after035 = ['win.startDrag', 'win.zoom', 'event.statusbar', 'projectMenu', 'getSettings', 'setSetting'];
    const after037 = [...after035, 'handOff'];
    const after040 = [...after037, 'jobMenu'];
    // The View menu (063) adds five pushed events (the Merged column state, and the four page
    // actions: Needs Me, the Settled sheet, the sidebar, the inspector), which the page only
    // receives, and exactly one page-callable method, `setViewState`: the main window's page reports
    // its three view booleans, answered only for the main window.
    const after059 = ['win.startDrag', 'win.zoom', 'event.statusbar', 'event.whatsnew', ...after040.slice(3)];
    const newEvents = [`event.${MERGED_EVENT}`, `event.${NEEDS_ME_EVENT}`, `event.${SETTLED_EVENT}`, `event.${SIDEBAR_EVENT}`, `event.${INSPECTOR_EVENT}`];
    expect(newEvents).toEqual(['event.merged', 'event.needsme', 'event.settled', 'event.sidebar', 'event.inspector']);
    // The About window (065) adds exactly one page-callable method, `getAbout`, answered only for
    // the About window, and no event.
    expect(GET_ABOUT_METHOD).toBe('getAbout');
    const after063 = [...after059, ...newEvents, VIEW_STATE_METHOD];
    // Show Backlog… (067) adds exactly one pushed event, `backlog`, right after `settled`, which the
    // page only receives; no page-callable method is added.
    expect(BACKLOG_EVENT).toBe('backlog');
    const viewEvents = [`event.${MERGED_EVENT}`, `event.${NEEDS_ME_EVENT}`, `event.${SETTLED_EVENT}`, `event.${BACKLOG_EVENT}`, `event.${SIDEBAR_EVENT}`, `event.${INSPECTOR_EVENT}`];
    expect(cfg.api).toEqual({
      disable: ['*'],
      enable: ['win.startDrag', 'win.zoom', `event.${STATUS_BAR_EVENT}`, `event.${WHATS_NEW_EVENT}`, ...viewEvents, PROJECT_MENU_METHOD, GET_SETTINGS_METHOD, SET_SETTING_METHOD, HAND_OFF_METHOD, JOB_MENU_METHOD, VIEW_STATE_METHOD, GET_ABOUT_METHOD],
    });
    const enable = isRecord(cfg.api) && Array.isArray(cfg.api.enable) ? cfg.api.enable : [];
    const events = (list: readonly unknown[]): unknown[] => list.filter((e) => typeof e === 'string' && e.startsWith('event.'));
    const methods = (list: readonly unknown[]): unknown[] => list.filter((e) => typeof e === 'string' && !e.startsWith('event.') && !e.startsWith('win.'));
    // 063: the 059 list, plus the new events, plus exactly one method
    expect(after063.filter((e) => !after059.includes(String(e)))).toEqual([...newEvents, VIEW_STATE_METHOD]);
    // 065: the 063 list plus exactly one method, getAbout; 067: plus exactly one event, backlog
    expect(enable.filter((e) => !after063.includes(String(e)))).toEqual([`event.${BACKLOG_EVENT}`, GET_ABOUT_METHOD]);
    expect(after063.every((e) => enable.includes(e))).toBe(true);
    expect(enable).toHaveLength(after063.length + 2);
    expect(methods(enable)).toEqual([...methods(after059), 'setViewState', 'getAbout']);
    expect(events(enable)).toEqual(['event.statusbar', 'event.whatsnew', ...viewEvents]);
    expect(cfg.inject).toBeUndefined();
  });

  test('the backend exports exactly those seven api methods: one more than after 063, getAbout', () => {
    const adapter = readFileSync(join(import.meta.dir, ADAPTER), 'utf8');
    const block = /^export const api = \{\n([\s\S]*?)^\};$/m.exec(adapter)?.[1] ?? '';
    const before = [PROJECT_MENU_METHOD, GET_SETTINGS_METHOD, SET_SETTING_METHOD, HAND_OFF_METHOD, JOB_MENU_METHOD, VIEW_STATE_METHOD];
    expect([...block.matchAll(/^  (\w+):/gm)].map((m) => m[1])).toEqual([...before, GET_ABOUT_METHOD]);
    expect([...block.matchAll(/^  (\w+):/gm)].map((m) => m[1])).toEqual(['projectMenu', 'getSettings', 'setSetting', 'handOff', 'jobMenu', 'setViewState', 'getAbout']);
  });

  test('065 AC3: getAbout checks the About window first, takes no params, and the page asks by the same method name', () => {
    const adapter = readFileSync(join(import.meta.dir, ADAPTER), 'utf8');
    const body = /export async function getAbout\([^)]*\)[^{]*\{\n([^\n]*)/.exec(adapter)?.[1]?.trim();
    expect(body).toBe('if (!fromAboutWindow(meta)) return null;');
    expect(adapter).toContain('  getAbout: (_params: unknown, _app: MacApp, meta: unknown): Promise<About | null> => getAbout(meta),');
    const ui = readFileSync(join(repoDir, 'apps', 'andon-ui', 'src', 'about.ts'), 'utf8');
    expect(ui).toContain(`export const GET_ABOUT_METHOD = '${GET_ABOUT_METHOD}';`);
  });

  test('the view-state method checks the main window first, and the page reports by the same method name', () => {
    const adapter = readFileSync(join(import.meta.dir, ADAPTER), 'utf8');
    const body = /export async function setViewState\([^)]*\)[^{]*\{\n([^\n]*)/.exec(adapter)?.[1]?.trim();
    expect(body).toBe('if (!fromMainWindow(meta)) return null;');
    expect(adapter).toContain('  setViewState: (params: unknown, app: MacApp, meta: unknown): Promise<ViewState | null> => setViewState(params, app, meta),');
    const ui = readFileSync(join(repoDir, 'apps', 'andon-ui', 'src', 'sidebar.ts'), 'utf8');
    expect(ui).toContain(`export const VIEW_STATE_METHOD = '${VIEW_STATE_METHOD}';`);
  });

  test('the job menu takes only the params and the app, and the page asks by the same method name', () => {
    const adapter = readFileSync(join(import.meta.dir, ADAPTER), 'utf8');
    expect(adapter).toContain('  jobMenu: (params: unknown, app: MacApp): Promise<void> => showJobMenu(params, app),');
    const ui = readFileSync(join(repoDir, 'apps', 'andon-ui', 'src', 'jobmenu.ts'), 'utf8');
    expect(ui).toContain(`export const JOB_MENU_METHOD = '${JOB_MENU_METHOD}';`);
  });

  test('the hand-off checks the main window first', () => {
    const adapter = readFileSync(join(import.meta.dir, ADAPTER), 'utf8');
    const body = /export async function handOff\([^)]*\)[^{]*\{\n([^\n]*)/.exec(adapter)?.[1]?.trim();
    expect(body).toBe('if (!fromMainWindow(meta)) return null;');
    expect(adapter).toContain('  handOff: (params: unknown, app: MacApp, meta: unknown): Promise<HandoffOutcome | null> => handOff(params, app, meta),');
  });

  test('the page hands off by the same method name', () => {
    const ui = readFileSync(join(repoDir, 'apps', 'andon-ui', 'src', 'handoff.ts'), 'utf8');
    expect(ui).toContain(`export const HAND_OFF_METHOD = '${HAND_OFF_METHOD}';`);
  });

  test('both settings methods check the window first', () => {
    const adapter = readFileSync(join(import.meta.dir, ADAPTER), 'utf8');
    for (const fn of ['getSettings', 'setSetting']) {
      const body = new RegExp(`export async function ${fn}\\([^)]*\\)[^{]*\\{\\n([^\\n]*)`).exec(adapter)?.[1]?.trim();
      expect({ fn, first: body }).toEqual({ fn, first: 'if (!fromSettingsWindow(meta)) return null;' });
    }
  });

  test('the Settings page asks by the same method names', () => {
    const ui = readFileSync(join(repoDir, 'apps', 'andon-ui', 'src', 'settings.ts'), 'utf8');
    expect(ui).toContain(`export const GET_SETTINGS_METHOD = '${GET_SETTINGS_METHOD}';`);
    expect(ui).toContain(`export const SET_SETTING_METHOD = '${SET_SETTING_METHOD}';`);
  });

  test('the page asks for the project menu by the same method name', () => {
    const ui = readFileSync(join(repoDir, 'apps', 'andon-ui', 'src', 'projectmenu.ts'), 'utf8');
    expect(ui).toContain(`export const PROJECT_MENU_METHOD = '${PROJECT_MENU_METHOD}';`);
  });

  test("the page listens for the same event name the Mac app pushes", () => {
    const ui = readFileSync(join(repoDir, 'apps', 'andon-ui', 'src', 'sidebar.ts'), 'utf8');
    expect(ui).toContain(`export const STATUS_BAR_EVENT = '${STATUS_BAR_EVENT}';`);
  });

  test('the backend entry is the Bun bundle', () => {
    expect(join(appDir, String(cfg.backend))).toBe(BACKEND_OUT);
  });

  test('the app is a regular app (a Dock icon, the window shown at launch) with the unlit lantern as its icon', () => {
    expect('activation' in cfg).toBe(false);
    expect(cfg.icon).toBe('assets/icon.png');
    expect(existsSync(join(appDir, 'assets', 'icon.png'))).toBe(true);
  });
});

test('the bundle is one self-contained ESM file with the repo fixed in, and no service command (062 AC8)', async () => {
  const js = await bundleBackend({ repo: '/the/repo' });
  expect(js).not.toMatch(/^\s*import\s/m); // nothing left to resolve under txiki
  expect(js).not.toMatch(/\brequire\(/);
  expect(js).not.toContain('__ANDON_REPO__');
  expect(js).toContain('"/the/repo"');
  expect(js).not.toContain('__ANDON_BUN__');
  // 065 AC3: the app's version, apps/andon/package.json `version`, is fixed in too
  expect(js).not.toContain('__ANDON_VERSION__');
  expect(js).toContain(JSON.stringify(await appVersion()));
  expect(js).not.toContain('andon-service');
  expect(js).toContain('factory service install');
  expect(js).toMatch(/export\s*\{[^}]*\binit\b/);
  expect(js).toMatch(/export\s*\{[^}]*\bonTray\b/);
  expect(js).toMatch(/export\s*\{[^}]*\bonMenu\b/);
  expect(js).toMatch(/export\s*\{[^}]*\bonNavigate\b/);
  expect(js).toMatch(/export\s*\{[^}]*\bonContextMenu\b/);
  expect(js).toMatch(/export\s*\{[^}]*\bapi\b/);
});
