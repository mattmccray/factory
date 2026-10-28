import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRoot, registryPath } from '@factory/contract';

const MAIN = join(import.meta.dir, 'main.ts');
let home: string;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'andon-main-')));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test('the process entry reads ANDON_PORT and ANDON_HOME and serves the registry', async () => {
  await addRoot(registryPath(home), join(home, 'proj'));
  const proc = Bun.spawn([process.execPath, MAIN], { env: { ...process.env, ANDON_HOME: home, ANDON_PORT: '0' }, stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = proc.stdout.getReader();
    let out = '';
    while (!out.includes('\n')) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    const url = out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(url).toBeDefined();
    expect(out.split('\n')[0]).toBe(`Andon service: ${url} (registry ${registryPath(home)})`);
    const res = await fetch(`${url}/projects`);
    const body: unknown = await res.json();
    expect(JSON.stringify(body)).toContain(join(home, 'proj'));
  } finally {
    proc.kill();
    await proc.exited;
  }
});

test('a malformed ANDON_PORT exits 1 with a reason', async () => {
  const proc = Bun.spawn([process.execPath, MAIN], { env: { ...process.env, ANDON_HOME: home, ANDON_PORT: 'eighty' }, stdout: 'pipe', stderr: 'pipe' });
  expect(await proc.exited).toBe(1);
  expect(await new Response(proc.stderr).text()).toContain('ANDON_PORT');
});

test('the process entry serves the UI from apps/andon-ui/dist', async () => {
  const text = await Bun.file(MAIN).text();
  expect(text).toContain("const uiDir = join(import.meta.dir, '..', '..', '..', 'apps', 'andon-ui', 'dist');");
  const ui = join(import.meta.dir, '..', '..', '..', 'apps', 'andon-ui', 'package.json');
  expect(JSON.stringify(await Bun.file(ui).json())).toContain('"name":"@factory/andon-ui"');
});
