// Andon's three parts in the workspace (job 029): the service (`packages/andon-service`), the UI
// (`apps/andon-ui`), and the Mac app (`apps/andon`), their package names, the root scripts that run
// them, and the build output .gitignore keeps out of git.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from './state';

const repoDir = join(import.meta.dir, '..', '..', '..');

const readJson = (rel: string): Record<string, unknown> => {
  const v: unknown = JSON.parse(readFileSync(join(repoDir, rel), 'utf8'));
  if (!isRecord(v)) throw new Error(`${rel} is not an object`);
  return v;
};

const rootScripts = (): Record<string, unknown> => {
  const scripts = readJson('package.json').scripts;
  if (!isRecord(scripts)) throw new Error('package.json has no scripts');
  return scripts;
};

describe('AC1: the workspace names the service, the UI, and the Mac app', () => {
  test('each part is in its folder under its package name', () => {
    expect(readJson('packages/andon-service/package.json').name).toBe('@factory/andon-service');
    expect(readJson('apps/andon-ui/package.json').name).toBe('@factory/andon-ui');
    expect(readJson('apps/andon/package.json').name).toBe('@factory/andon');
  });

  test('the service bin is andon-service, on src/main.ts', () => {
    expect(readJson('packages/andon-service/package.json').bin).toEqual({ 'andon-service': 'src/main.ts' });
  });

  test('the old folders are gone', () => {
    for (const old of ['packages/andon-agent', 'apps/andon-shell']) expect({ old, exists: existsSync(join(repoDir, old)) }).toEqual({ old, exists: false });
  });

  test('bun.lock lists the new names only', () => {
    const lock = readFileSync(join(repoDir, 'bun.lock'), 'utf8');
    for (const name of ['@factory/andon-service', '@factory/andon-ui', '@factory/andon"', '"packages/andon-service"', '"apps/andon-ui"', '"apps/andon"']) {
      expect({ name, listed: lock.includes(name) }).toEqual({ name, listed: true });
    }
    for (const old of ['andon-agent', 'andon-shell']) expect({ old, listed: lock.includes(old) }).toEqual({ old, listed: false });
  });
});

describe('AC2: the root scripts and .gitignore follow the new names', () => {
  test('andon runs the Mac app, andon:service the service, andon:ui:* the UI, and andon:build both', () => {
    const s = rootScripts();
    expect(s.andon).toBe('bun run --cwd apps/andon dev');
    expect(s['andon:service']).toBe('bun packages/andon-service/src/main.ts');
    expect(s['andon:ui:build']).toBe('bun run --cwd apps/andon-ui build');
    expect(s['andon:ui:dev']).toBe('bun run --cwd apps/andon-ui dev');
    expect(s['andon:build']).toBe('bun run andon:ui:build && bun run --cwd apps/andon build');
  });

  test('check runs svelte-check in apps/andon-ui', () => {
    expect(rootScripts().check).toBe('tsc --noEmit && bun run --cwd apps/andon-ui check');
  });

  test('no script is named andon:shell* or andon:dev, and none names an old folder', () => {
    const s = rootScripts();
    for (const name of Object.keys(s)) expect({ name, old: name.startsWith('andon:shell') || name === 'andon:dev' }).toEqual({ name, old: false });
    for (const [name, cmd] of Object.entries(s)) {
      expect({ name, old: /andon-agent|andon-shell/.test(String(cmd)) }).toEqual({ name, old: false });
    }
  });

  test('.gitignore lists the UI and Mac app build output, and no old folder', () => {
    const lines = readFileSync(join(repoDir, '.gitignore'), 'utf8').split('\n');
    for (const want of ['apps/andon-ui/dist/', 'apps/andon/build/', 'apps/andon/.build/', 'apps/andon/dist/']) expect(lines).toContain(want);
    for (const line of lines) expect({ line, old: /andon-agent|andon-shell/.test(line) }).toEqual({ line, old: false });
  });
});
