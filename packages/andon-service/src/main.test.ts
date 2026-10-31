import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRoot, registryPath } from '@factory/contract';
import { bundleTree, sourceTree } from './entry';
import { BUNDLE_VERSION_FILE, SOURCE_VERSION_FILE } from './release';

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

test('the process entry passes the repo root as the clone root: GET /release runs the templates version', async () => {
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
    const res = await fetch(`${url}/release`);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const pkg: unknown = await Bun.file(join(import.meta.dir, '..', '..', 'templates', 'package.json')).json();
    const version = typeof pkg === 'object' && pkg !== null && 'version' in pkg ? pkg.version : undefined;
    expect(typeof version).toBe('string');
    expect(typeof body === 'object' && body !== null && 'running' in body ? body.running : undefined).toBe(version);
    expect(typeof body === 'object' && body !== null && 'onDisk' in body ? body.onDisk : undefined).toBe(version);
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
  expect(text).toContain("const cloneRoot = join(import.meta.dir, '..', '..', '..');");
  expect(text).toContain('await serve(sourceTree(cloneRoot));');
  const root = join(import.meta.dir, '..', '..', '..');
  expect(sourceTree(root)).toEqual({ uiDir: join(root, 'apps', 'andon-ui', 'dist'), cloneRoot: root, versionFile: SOURCE_VERSION_FILE });
  expect(bundleTree('/b')).toEqual({ uiDir: '/b/andon/ui', cloneRoot: '/b', versionFile: BUNDLE_VERSION_FILE });
  const ui = join(import.meta.dir, '..', '..', '..', 'apps', 'andon-ui', 'package.json');
  expect(JSON.stringify(await Bun.file(ui).json())).toContain('"name":"@factory/andon-ui"');
});

// Job 078 AC2: `serve` reads ANDON_TAILNET_HOST and passes it to startService.
const NAME = 'studio.manticore-hue.ts.net';
async function firstLines(proc: { stdout: ReadableStream<Uint8Array> }, n: number): Promise<string[]> {
  const reader = proc.stdout.getReader();
  let out = '';
  while (out.split('\n').length <= n) {
    const { done, value } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return out.split('\n').slice(0, n);
}

test('ANDON_TAILNET_HOST set: the service also accepts that Host and its https Origin, and still binds 127.0.0.1', async () => {
  await addRoot(registryPath(home), join(home, 'proj'));
  const proc = Bun.spawn([process.execPath, MAIN], { env: { ...process.env, ANDON_HOME: home, ANDON_PORT: '0', ANDON_TAILNET_HOST: NAME }, stdout: 'pipe', stderr: 'pipe' });
  try {
    const [first, second] = await firstLines(proc, 2);
    const url = first?.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(url).toBeDefined();
    const port = new URL(url ?? 'http://x').port;
    expect(first).toBe(`Andon service: ${url} (registry ${registryPath(home)})`);
    expect(second).toBe(`Andon service: also https://${NAME}:${port}/ through tailscale serve`);
    const tailnet: Array<Record<string, string>> = [{ host: `${NAME}:${port}` }, { host: `${NAME}:${port}`, origin: `https://${NAME}:${port}` }];
    for (const headers of tailnet) {
      const res = await fetch(`${url}/projects`, { headers });
      expect(res.status).toBe(200);
      expect(JSON.stringify(await res.json())).toContain(join(home, 'proj'));
    }
    expect((await fetch(`${url}/projects`, { headers: { host: `other.manticore-hue.ts.net:${port}` } })).status).toBe(403);
  } finally {
    proc.kill();
    await proc.exited;
  }
});

test('ANDON_TAILNET_HOST unset: the tailnet Host is a 403 and the output is as before', async () => {
  const env: Record<string, string | undefined> = { ...process.env, ANDON_HOME: home, ANDON_PORT: '0' };
  delete env.ANDON_TAILNET_HOST;
  const proc = Bun.spawn([process.execPath, MAIN], { env, stdout: 'pipe', stderr: 'pipe' });
  try {
    const [first] = await firstLines(proc, 1);
    const url = first?.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(first).toBe(`Andon service: ${url} (registry ${registryPath(home)})`);
    const port = new URL(url ?? 'http://x').port;
    expect((await fetch(`${url}/projects`, { headers: { host: `${NAME}:${port}` } })).status).toBe(403);
    expect((await fetch(`${url}/projects`)).status).toBe(200);
  } finally {
    proc.kill();
    await proc.exited;
  }
});

test('an ANDON_TAILNET_HOST that is not a lowercase DNS name exits 1 with one andon: line and never listens', async () => {
  for (const bad of ['', `${NAME}:8766`, `https://${NAME}`, `${NAME} `, ' ', `${NAME}/board`, 'Studio.Manticore-Hue.ts.net', `${NAME}.`]) {
    const proc = Bun.spawn([process.execPath, MAIN], { env: { ...process.env, ANDON_HOME: home, ANDON_PORT: '0', ANDON_TAILNET_HOST: bad }, stdout: 'pipe', stderr: 'pipe' });
    expect({ bad, code: await proc.exited }).toEqual({ bad, code: 1 });
    const err = (await new Response(proc.stderr).text()).trimEnd().split('\n');
    expect({ bad, err }).toEqual({ bad, err: [`andon: ANDON_TAILNET_HOST must be a lowercase DNS name, got ${JSON.stringify(bad)}`] });
    expect(await new Response(proc.stdout).text()).toBe('');
  }
});
