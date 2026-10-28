// The UI's boundaries: contract code never runs in the UI (009 AC3), the dev server stays on
// loopback (AC4), index.html needs nothing a strict CSP would block (AC6), and Andon never writes
// job state: it only reads, and its actions copy a `/factory` command (026 AC5).
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import config from '../vite.config';
import { isRecord } from './job';

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
  test('binds loopback with CORS off, and still proxies /projects and /events to the service', () => {
    const server = isRecord(config) && isRecord(config.server) ? config.server : {};
    expect(server.host).toBe('127.0.0.1');
    expect(server.cors).toBe(false);
    const proxy = isRecord(server.proxy) ? server.proxy : {};
    expect(Object.keys(proxy).sort()).toEqual(['/events', '/projects']);
    for (const key of ['/projects', '/events']) {
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

  test("the page never calls the Mac app's backend (032): no tiny.api.call", () => {
    for (const file of sources) {
      const text = read(file);
      expect({ file, hit: /\bapi\s*\.\s*call\b|['"]call['"]/.exec(text)?.[0] ?? null }).toEqual({ file, hit: null });
    }
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
    expect(built).toBe(3); // approve, rework, abandon
  });

  test('the drawer and the Settled dialog are gone', () => {
    expect(existsSync(join(import.meta.dir, 'Drawer.svelte'))).toBe(false);
    expect(existsSync(join(import.meta.dir, 'SettledDialog.svelte'))).toBe(false);
  });
});
