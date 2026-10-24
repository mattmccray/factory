// The shell's boundaries: no contract, agent, or UI code runs in it, its logic is runtime-neutral
// (AC5), the window loads the agent on loopback with the page's Tiny API denied (AC6), and the
// backend entry is the Bun bundle of backend.ts.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKEND_OUT, bundleBackend } from '../build';
import { isRecord } from './state';

const shellDir = join(import.meta.dir, '..');
const ADAPTER = 'backend.ts';
const sources = readdirSync(import.meta.dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

/** Every module specifier a file names: `import ... from`, `export ... from`, a bare `import '...'`, and `import()`. */
function specifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]/g)) if (m[1] !== undefined) out.push(m[1]);
  return out;
}

const readJson = (path: string): Record<string, unknown> => {
  const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(v)) throw new Error(`${path} is not an object`);
  return v;
};

describe('AC5: the shell runs no contract, agent, or UI code', () => {
  test('the scan sees the logic modules and the adapter', () => {
    expect(sources).toContain(ADAPTER);
    for (const f of ['sse.ts', 'follow.ts', 'badge.ts', 'notify.ts', 'autostart.ts', 'trayclick.ts']) expect(sources).toContain(f);
  });

  test('no source imports @factory/contract, @factory/andon-agent, or apps/andon', () => {
    for (const f of sources) {
      const text = readFileSync(join(import.meta.dir, f), 'utf8');
      for (const s of specifiers(text)) {
        const bad = s.startsWith('@factory/') || /(^|\/)andon(\/|$)/.test(s) || s.includes('apps/andon/') || s.includes('andon-agent');
        expect({ file: f, specifier: s, bad }).toEqual({ file: f, specifier: s, bad: false });
      }
      expect(text).not.toMatch(/@factory\/(contract|andon-agent)/);
    }
  });

  test('the logic modules import only each other: no bun:*, node:*, or tjs', () => {
    for (const f of sources.filter((x) => x !== ADAPTER)) {
      for (const s of specifiers(readFileSync(join(import.meta.dir, f), 'utf8'))) {
        expect({ file: f, specifier: s, local: /^\.\/[a-z]+$/.test(s) }).toEqual({ file: f, specifier: s, local: true });
      }
    }
    // the adapter's imports are local too: Tiny and txiki are globals, described by ambient types
    for (const s of specifiers(readFileSync(join(import.meta.dir, ADAPTER), 'utf8'))) expect(s).toMatch(/^\.\/[a-z]+$/);
  });

  test('package.json has no dependencies and never names @factory/contract', () => {
    const pkg = readJson(join(shellDir, 'package.json'));
    expect(pkg.name).toBe('@factory/andon-shell');
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies).toBeUndefined();
    expect(JSON.stringify(pkg)).not.toContain('@factory/contract');
  });
});

describe('AC6: tinyjs.json', () => {
  const cfg = readJson(join(shellDir, 'tinyjs.json'));

  test('the main window loads the agent at http://127.0.0.1:<port>/', () => {
    expect(typeof cfg.url).toBe('string');
    const url = new URL(String(cfg.url));
    expect(url.protocol).toBe('http:');
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toMatch(/^\d+$/);
    expect(String(cfg.url)).toBe(`http://127.0.0.1:${url.port}/`);
    expect(url.port).toBe('8766');
    expect(cfg.mainWindow).not.toBe(false);
  });

  test('the api gate disables every Tiny call for the page and grants no origin anything', () => {
    expect(cfg.api).toEqual({ disable: ['*'] });
    expect(cfg.inject).toBeUndefined();
  });

  test('the backend entry is the Bun bundle, and the app is a tray app', () => {
    expect(join(shellDir, String(cfg.backend))).toBe(BACKEND_OUT);
    expect(cfg.activation).toBe('accessory');
  });
});

test('the bundle is one self-contained ESM file with the agent location fixed in', async () => {
  const js = await bundleBackend({ repo: '/the/repo', bun: '/the/bun' });
  expect(js).not.toMatch(/^\s*import\s/m); // nothing left to resolve under txiki
  expect(js).not.toMatch(/\brequire\(/);
  expect(js).not.toContain('__ANDON_REPO__');
  expect(js).toContain('"/the/repo"');
  expect(js).toContain('"/the/bun"');
  expect(js).toMatch(/export\s*\{[^}]*\binit\b/);
  expect(js).toMatch(/export\s*\{[^}]*\bonTray\b/);
});
