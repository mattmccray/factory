// The UI's boundaries: contract code never runs in the UI (009 AC3), the dev server stays on
// loopback (AC4), and index.html needs nothing a strict CSP would block (AC6).
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
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
  test('binds loopback with CORS off, and still proxies /projects and /events to the agent', () => {
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
