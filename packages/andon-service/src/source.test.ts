import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { registryPath } from '@factory/contract';
import { startService } from './index';

const SPECIFIER = /(?:^|\s)(?:import|export)\s(?:[^'"]*?\sfrom\s)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/gm;

const sources = async (): Promise<Array<{ file: string; text: string }>> => {
  const files = (await readdir(import.meta.dir, { recursive: true })).filter((f) => f.endsWith('.ts'));
  return Promise.all(files.map(async (file) => ({ file, text: await readFile(join(import.meta.dir, file), 'utf8') })));
};

// AC6: contract code comes only from `@factory/contract`, never the installed copy or a `..` path.
test('packages/andon-service imports contract code only from @factory/contract', async () => {
  const all = await sources();
  expect(all.map((s) => s.file)).toContain('index.ts');
  const seen: string[] = [];
  for (const { file, text } of all) {
    for (const m of text.matchAll(SPECIFIER)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? '';
      seen.push(spec);
      const allowed = spec === '@factory/contract' || spec === 'bun:test' || spec.startsWith('node:') || /^\.\/[\w.-]+$/.test(spec);
      expect({ file, spec, allowed }).toEqual({ file, spec, allowed: true });
      expect(spec).not.toContain('factory/lib');
      expect(spec).not.toContain('cli.ts');
      expect(spec).not.toContain('..');
    }
  }
  expect(seen).toContain('@factory/contract');
});

// AC4: changes are found by fs.watch, never by polling.
test('the service source has no setInterval and no polling loop', async () => {
  for (const { file, text } of await sources()) {
    if (file.endsWith('.test.ts')) continue;
    expect({ file, setInterval: text.includes('setInterval') }).toEqual({ file, setInterval: false });
    expect({ file, watchFile: /\bwatchFile\b/.test(text) }).toEqual({ file, watchFile: false });
    expect({ file, loop: /while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/.test(text) }).toEqual({ file, loop: false });
  }
  const index = await readFile(join(import.meta.dir, 'index.ts'), 'utf8');
  expect(index).toContain("from 'node:fs'");
  expect(index).toMatch(/\bwatch\(/);
});

// AC6: the service listens on loopback only.
let stop: (() => Promise<void>) | null = null;
let tmp: string | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
  if (tmp !== null) await rm(tmp, { recursive: true, force: true });
  tmp = null;
});

test('startService listens on 127.0.0.1 only', async () => {
  tmp = await mkdtemp(join(tmpdir(), 'andon-bind-'));
  const service = await startService({ port: 0, registryPath: registryPath(tmp), log: () => undefined });
  stop = service.stop;
  const url = new URL(service.url);
  expect(url.hostname).toBe('127.0.0.1');
  expect((await fetch(`${service.url}/projects`)).status).toBe(200);
  const external = Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .find((i) => i.family === 'IPv4' && !i.internal);
  if (external !== undefined) {
    const reached = await fetch(`http://${external.address}:${url.port}/projects`, { signal: AbortSignal.timeout(1000) }).then(
      () => true,
      () => false,
    );
    expect(reached).toBe(false);
  }
  const index = await readFile(join(import.meta.dir, 'index.ts'), 'utf8');
  expect(index).toContain("HOSTNAME = '127.0.0.1'");
  expect(index).toMatch(/hostname: HOSTNAME/);
});

// AC7: the contract doc documents the registry, init's registration, and the service's surface.
test('docs/contract/v1.md documents the registry, init registration, and the service endpoints', async () => {
  const doc = await readFile(join(import.meta.dir, '..', '..', '..', 'docs', 'contract', 'v1.md'), 'utf8');
  for (const want of [
    '## Andon registry',
    '$ANDON_HOME/projects.json',
    '`~/.andon`',
    '{ "schema": "factory/v1", "projects": [{ "root": "/absolute/repo/root" }] }',
    'note: not registered with Andon (<registry path>): <reason>',
    '## Andon service',
    '`bun run andon:service`',
    '`packages/andon-service`',
    '`apps/andon-ui/dist`',
    '`bun run andon:ui:build`',
    '`GET /projects`',
    '`GET /projects/<pid>/board`',
    '`GET /projects/<pid>/jobs/<id>/docs`',
    '`GET /events`',
    '`projects`: `{ projects: [{ id, name, root }] }`',
    '`board`: `{ project: <pid>, jobs, config }`',
    '`error`: `{ project: <pid>, reason: "config.json: <reason>" }`',
    '`127.0.0.1`',
    '8766',
    'is a 403 (a guard against DNS rebinding)',
  ]) {
    expect({ want, found: doc.includes(want) }).toEqual({ want, found: true });
  }
  expect(doc.indexOf('## Dashboard endpoints')).toBeLessThan(doc.indexOf('## Andon service'));
  expect(doc).not.toMatch(/andon[- ]agent/i);
});
