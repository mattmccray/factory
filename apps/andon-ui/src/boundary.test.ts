// The UI's boundaries: contract code never runs in the UI (009 AC3), the dev server stays on
// loopback (AC4), index.html needs nothing a strict CSP would block (AC6), and Andon never writes
// job state: it only reads, and its actions copy a `/factory` command (026 AC5) and, in the Mac app,
// name the job for the Mac app to hand to T3 Code (036).
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import config from '../vite.config';
import { isRecord } from './job';
import { PUSHED_EVENTS, STATUS_BAR_EVENT, VIEW_STATE_METHOD, WHATS_NEW_EVENT } from './sidebar';

const app = join(import.meta.dir, '..');

describe('the contract boundary (009 AC3)', () => {
  const sources = [
    join(app, 'main.ts'),
    ...readdirSync(import.meta.dir)
      .filter((f) => (f.endsWith('.ts') || f.endsWith('.svelte')) && !f.endsWith('.test.ts'))
      .map((f) => join(import.meta.dir, f)),
  ];

  test('every import from @factory/contract is `import type`', () => {
    let typeImports = 0;
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      // Every statement that names the package: `import ... from`, a side-effect import, `export ... from`, or `import()`.
      const mentions = [...text.matchAll(/^.*['"]@factory\/contract(?:\/[^'"]*)?['"].*$/gm)].map((m) => m[0].trim());
      for (const line of mentions) {
        expect({ file, line, typeOnly: /^import type \{[^}]*\} from ['"]@factory\/contract['"];?$/.test(line) }).toEqual({ file, line, typeOnly: true });
        typeImports++;
      }
    }
    expect(typeImports).toBeGreaterThan(0); // job.ts checks its shapes against the contract
  });

  test('@factory/contract is a devDependency only', () => {
    const pkg: unknown = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
    if (!isRecord(pkg)) throw new Error('package.json is not an object');
    const dev = isRecord(pkg.devDependencies) ? pkg.devDependencies : {};
    expect(dev['@factory/contract']).toBe('workspace:*');
    expect(pkg.dependencies).toBeUndefined();
    for (const key of ['peerDependencies', 'optionalDependencies']) expect(pkg[key]).toBeUndefined();
  });
});

describe('the Vite dev server (009 AC4)', () => {
  test('binds loopback with CORS off, and still proxies /projects, /events, and /release (059) to the service', () => {
    const server = isRecord(config) && isRecord(config.server) ? config.server : {};
    expect(server.host).toBe('127.0.0.1');
    expect(server.cors).toBe(false);
    const proxy = isRecord(server.proxy) ? server.proxy : {};
    expect(Object.keys(proxy).sort()).toEqual(['/events', '/projects', '/release']);
    for (const key of ['/projects', '/events', '/release']) {
      const entry = proxy[key];
      expect(isRecord(entry) && entry.target).toBe(`http://127.0.0.1:${process.env.ANDON_PORT ?? '8766'}`);
      expect(isRecord(entry) && entry.changeOrigin).toBe(true);
      expect(isRecord(entry) && typeof entry.configure).toBe('function');
    }
  });
});

describe('index.html under the CSP (009 AC6)', () => {
  const html = readFileSync(join(app, 'index.html'), 'utf8');

  test('every <script> has a src, and there is no inline script, style, or event handler', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs = '', body = ''] of scripts) {
      expect(attrs).toMatch(/\ssrc=["'][^"']+["']/);
      expect(body.trim()).toBe('');
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });
});

describe('Andon never writes job state (026 AC5)', () => {
  const sources = [
    join(app, 'main.ts'),
    ...readdirSync(import.meta.dir)
      .filter((f) => (f.endsWith('.ts') || f.endsWith('.svelte')) && !f.endsWith('.test.ts'))
      .map((f) => join(import.meta.dir, f)),
  ];
  const read = (file: string): string => readFileSync(file, 'utf8');

  /** The argument text of every call to `name(`, up to its balanced closing paren. */
  function calls(text: string, name: RegExp): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(name)) {
      let depth = 0;
      let end = m.index + m[0].length - 1; // at the opening paren
      for (let i = end; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')' && --depth === 0) {
          end = i;
          break;
        }
      }
      out.push(text.slice(m.index + m[0].length, end));
    }
    return out;
  }

  test('every fetch is a GET: no method other than GET, and no body', () => {
    let found = 0;
    for (const file of sources) {
      for (const args of calls(read(file), /\bfetch\s*\(/g)) {
        found++;
        const method = /\bmethod\s*:\s*['"`]?(\w+)/i.exec(args)?.[1];
        expect({ file, args, method: method?.toUpperCase() ?? 'GET', body: /\bbody\s*:/.test(args) }).toEqual({ file, args, method: 'GET', body: false });
      }
    }
    expect(found).toBeGreaterThan(0); // App.svelte's fetcher
  });

  test('no other way to send: no XMLHttpRequest, sendBeacon, WebSocket, or form post', () => {
    for (const file of sources) {
      const text = read(file);
      expect({ file, hit: /\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b|<form\b|method=["']post/i.exec(text)?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });

  test("the page calls the Mac app's backend in six places only, each with its own fixed method names (032, 033, 035, 036, 040, 063, 065)", () => {
    // Every mention of Tiny's `api.call` (or a `'call'` key) across the page's sources.
    const hits: { file: string; hit: string }[] = [];
    for (const file of sources) {
      for (const m of read(file).matchAll(/\bapi\s*\.\s*call\b|['"]call['"]|\[\s*['"`]call/g)) hits.push({ file: file.slice(import.meta.dir.length + 1), hit: m[0] });
    }
    expect(hits.sort((a, b) => a.file.localeCompare(b.file))).toEqual([
      { file: 'about.ts', hit: 'api.call' },
      { file: 'handoff.ts', hit: 'api.call' },
      { file: 'jobmenu.ts', hit: 'api.call' },
      { file: 'projectmenu.ts', hit: 'api.call' },
      { file: 'settings.ts', hit: 'api.call' },
      { file: 'sidebar.ts', hit: 'api.call' },
    ]);
    const text = read(join(import.meta.dir, 'projectmenu.ts'));
    // The one method name, fixed; the one call site passes it and a `{ project }` and nothing else.
    expect(text).toContain("export const PROJECT_MENU_METHOD = 'projectMenu';");
    const applies = [...text.matchAll(/Reflect\.apply\(([^;]*)\);/g)].map((m) => m[1]);
    expect(applies).toEqual(['call, api, [PROJECT_MENU_METHOD, { project }]', 'el.getAttribute, el, [PROJECT_MENU_ATTR]']);
    // The settings caller (035): its two fixed method names, the get with no params and the set with
    // only the status bar change.
    const settings = read(join(import.meta.dir, 'settings.ts'));
    expect(settings).toContain("export const GET_SETTINGS_METHOD = 'getSettings';");
    expect(settings).toContain("export const SET_SETTING_METHOD = 'setSetting';");
    expect([...settings.matchAll(/Reflect\.apply\(([^;]*?)\)\)/g)].map((m) => m[1])).toEqual([
      'call, api, [GET_SETTINGS_METHOD, null]',
      "call, api, [SET_SETTING_METHOD, { key: 'statusBarHidden', value: hidden }]",
      "call, api, [SET_SETTING_METHOD, { key: 't3Handoff', value: mode }]",
      "call, api, [SET_SETTING_METHOD, { key: 'mergedHidden', value: hidden }]",
    ]);
    // The view-state reporter (063): its one fixed method name, and the one call site passes it and
    // only the three booleans. sidebar.ts's other Reflect.apply calls are the push subscriber's.
    const sidebar = read(join(import.meta.dir, 'sidebar.ts'));
    expect(sidebar).toContain("export const VIEW_STATE_METHOD = 'setViewState';");
    expect(VIEW_STATE_METHOD).toBe('setViewState');
    expect([...sidebar.matchAll(/Reflect\.apply\(([^;]*?)\);/g)].map((m) => m[1])).toEqual([
      'on, api, [event, fn]',
      'off, undefined, []',
      'call, api, [VIEW_STATE_METHOD, { needsMe, sidebarShown, inspectorOpen }]',
    ]);
    // The hand-off caller (036): its one fixed method name, and the one call site passes it and the
    // request (a project id, a job id, an action, and a note: HandoffRequest), never a command.
    const handoff = read(join(import.meta.dir, 'handoff.ts'));
    expect(handoff).toContain("export const HAND_OFF_METHOD = 'handOff';");
    expect([...handoff.matchAll(/Reflect\.apply\(([^;]*?)\);/g)].map((m) => m[1])).toEqual(['call, api, [HAND_OFF_METHOD, req]']);
    // The job menu caller (040): its one fixed method name, and the one call site passes it and a
    // `{ project, job }` and nothing else (never a thread id, a link, or a path).
    const jobmenu = read(join(import.meta.dir, 'jobmenu.ts'));
    expect(jobmenu).toContain("export const JOB_MENU_METHOD = 'jobMenu';");
    expect([...jobmenu.matchAll(/Reflect\.apply\(([^;]*)\);/g)].map((m) => m[1])).toEqual(['call, api, [JOB_MENU_METHOD, { project, job }]', 'el.getAttribute, el, [name]']);
    expect(handoff).toContain("export type HandoffRequest = { project: string; job: string; action: 'approve' } | { project: string; job: string; action: 'rework' | 'abandon'; note: string };");
    // The about caller (065): its one fixed method name, and the one call site passes it and no params.
    const about = read(join(import.meta.dir, 'about.ts'));
    expect(about).toContain("export const GET_ABOUT_METHOD = 'getAbout';");
    expect([...about.matchAll(/Reflect\.apply\(([^;]*?)\);/g)].map((m) => m[1])).toEqual(['call, api, [GET_ABOUT_METHOD, null]']);
    // No other file reaches Tiny's api object: only sidebar.ts's push subscriber reads `api.on`.
    for (const file of sources) {
      const name = file.slice(import.meta.dir.length + 1);
      if (name === 'projectmenu.ts' || name === 'jobmenu.ts' || name === 'sidebar.ts' || name === 'settings.ts' || name === 'handoff.ts' || name === 'about.ts') continue;
      expect({ file: name, hit: /\bhost\.api\b|\btiny\.api\b|\bapi\.on\b/.exec(read(file))?.[0] ?? null }).toEqual({ file: name, hit: null });
    }
  });

  test("the page hears exactly the Mac app's pushed events its api gate names: statusbar and whatsnew (059), and the View menu's (063)", () => {
    expect(STATUS_BAR_EVENT).toBe('statusbar');
    expect(WHATS_NEW_EVENT).toBe('whatsnew');
    expect(PUSHED_EVENTS).toEqual(['statusbar', 'whatsnew', 'merged', 'needsme', 'settled', 'sidebar', 'inspector']);
    const tiny: unknown = JSON.parse(read(join(app, '..', 'andon', 'tinyjs.json')));
    const gate = isRecord(tiny) && isRecord(tiny.api) && Array.isArray(tiny.api.enable) ? tiny.api.enable : [];
    expect(gate.filter((e): e is string => typeof e === 'string' && e.startsWith('event.'))).toEqual(PUSHED_EVENTS.map((e) => `event.${e}`));
    expect(gate).toContain('event.whatsnew');
    // Every subscription goes through pushSubscriber with one of those names, in App.svelte only.
    const subs = [...read(join(import.meta.dir, 'App.svelte')).matchAll(/subscribe\?\.\((\w+),/g)].map((m) => m[1]);
    expect(subs).toEqual(['STATUS_BAR_EVENT', 'WHATS_NEW_EVENT', 'MERGED_EVENT', 'NEEDS_ME_EVENT', 'SETTLED_EVENT', 'SIDEBAR_EVENT', 'INSPECTOR_EVENT']);
  });

  test('Fetcher stays path-only', () => {
    const api = read(join(import.meta.dir, 'api.ts'));
    expect(api).toContain('export type Fetcher = (path: string) => Promise<FetchResponse>;');
    expect(read(join(import.meta.dir, 'App.svelte'))).toMatch(/const fetcher: Fetcher = \(path\) => fetch\(path, \{ cache: 'no-store' \}\);/);
  });

  test('`/factory` appears only in a command built to be copied, or as help text', () => {
    // A command mention: `/factory` not followed by a path character (`<root>/factory/jobs` is a path, not a command).
    const command = /\/factory(?![\w/.-])/g;
    let built = 0;
    for (const file of sources) {
      const lines = read(file).split('\n');
      for (const line of lines) {
        if (line.match(command) === null) continue;
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue; // a comment
        if (file.endsWith('inspector.ts')) {
          // inspector.ts builds the copied strings: each mention opens a template literal.
          for (const m of line.matchAll(command)) expect({ file, line: trimmed, opensString: line[m.index - 1] === '`' }).toEqual({ file, line: trimmed, opensString: true });
          built++;
          continue;
        }
        // Elsewhere only as help text, inside <code>…</code>, never in a fetch, URL, or handler.
        const outside = line.replace(/<code>[^<]*<\/code>/g, '');
        expect({ file, line: trimmed, outsideCode: command.test(outside) }).toEqual({ file, line: trimmed, outsideCode: false });
        command.lastIndex = 0;
      }
    }
    expect(built).toBe(5); // approve, rework, abandon, and an epic's resume and abandon
  });

  test('the drawer and the Settled dialog are gone', () => {
    expect(existsSync(join(import.meta.dir, 'Drawer.svelte'))).toBe(false);
    expect(existsSync(join(import.meta.dir, 'SettledDialog.svelte'))).toBe(false);
  });
});
