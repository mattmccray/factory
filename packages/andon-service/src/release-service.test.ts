import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRoot, registryPath } from '@factory/contract';
import { projectId, startService } from './index';
import type { Service } from './index';

const CONFIG = { schema: 'factory/v1', reviewers: ['security', 'code'], maxRound: 2, dashboard: { settleAfterHours: 24 } };
const SHA = 'b'.repeat(64);
const CHANGELOG = [
  '# Changelog',
  '',
  '## v0.2.0 (2026-10-29)',
  '',
  '### Added',
  '- Andon: show epics as sub-lanes (056-andon-epics-ui)',
  '- Skill: a direct commit',
  '',
  '### Fixed',
  '- no area here (057-no-area)',
  '',
  '## v0.1.0 (2026-10-01)',
  '',
  '### Breaking',
  '- CLI: drop the old flag (050-drop-flag)',
  '',
].join('\n');
const PARSED = [
  {
    version: '0.2.0',
    date: '2026-10-29',
    sections: {
      breaking: [],
      added: [
        { area: 'Andon', text: 'show epics as sub-lanes', job: '056-andon-epics-ui' },
        { area: 'Skill', text: 'a direct commit', job: null },
      ],
      fixed: [{ area: null, text: 'no area here', job: '057-no-area' }],
    },
  },
  { version: '0.1.0', date: '2026-10-01', sections: { breaking: [{ area: 'CLI', text: 'drop the old flag', job: '050-drop-flag' }], added: [], fixed: [] } },
];

let tmp: string;
let registry: string;
let service: Service | null;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'andon-release-svc-')));
  registry = registryPath(join(tmp, 'andon'));
  service = null;
});
afterEach(async () => {
  await service?.stop();
  await rm(tmp, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const writeAt = async (path: string, text: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
};
const manifest = (version: unknown, files: Record<string, string> = {}): string => JSON.stringify({ schema: 'factory/v1', version, files });
// As the installer writes it: a dot-named temp file in factory/, renamed over the target.
async function install(root: string, text: string): Promise<void> {
  const tmpFile = join(root, 'factory', `.managed.json.${process.pid}.${Date.now()}.factory-tmp`);
  await writeFile(tmpFile, text);
  await rename(tmpFile, join(root, 'factory', 'managed.json'));
}

// A fixture clone: packages/templates/package.json at `version`, and CHANGELOG.md when given.
async function makeClone(version: unknown, changelog?: string): Promise<string> {
  const root = join(tmp, 'clone');
  await writeAt(join(root, 'packages', 'templates', 'package.json'), JSON.stringify({ name: '@factory/templates', version }));
  if (changelog !== undefined) await writeFile(join(root, 'CHANGELOG.md'), changelog);
  return root;
}
// A registered project with a valid config.json and, when given, a managed.json body.
async function makeProject(name: string, managed?: string): Promise<string> {
  const root = join(tmp, 'projects', name);
  await writeAt(join(root, 'factory', 'config.json'), JSON.stringify(CONFIG));
  if (managed !== undefined) await writeFile(join(root, 'factory', 'managed.json'), managed);
  await addRoot(registry, root);
  return root;
}

const start = async (cloneRoot?: string, versionFile?: string): Promise<Service> => {
  service = await startService({ port: 0, registryPath: registry, log: () => undefined, ...(cloneRoot === undefined ? {} : { cloneRoot }), ...(versionFile === undefined ? {} : { versionFile }) });
  return service;
};

const get = async (url: string, init?: RequestInit): Promise<{ status: number; body: unknown; cache: string | null }> => {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // plain text
  }
  return { status: res.status, body, cache: res.headers.get('cache-control') };
};

interface Sse {
  event: string;
  data: unknown;
}

async function connect(url: string): Promise<{ seen: Sse[]; next: (match: (e: Sse) => boolean, from?: number, ms?: number) => Promise<Sse>; close: () => void }> {
  const ctl = new AbortController();
  const res = await fetch(`${url}/events`, { signal: ctl.signal });
  const body = res.body;
  if (body === null) throw new Error('no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const seen: Sse[] = [];
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let i = buf.indexOf('\n\n');
        while (i !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          seen.push({ event: block.match(/^event: (.*)$/m)?.[1] ?? 'message', data: JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? 'null') });
          i = buf.indexOf('\n\n');
        }
      }
    } catch {
      // aborted
    }
  })();
  const next = async (match: (e: Sse) => boolean, from = 0, ms = 2000): Promise<Sse> => {
    const until = Date.now() + ms;
    for (;;) {
      const hit = seen.slice(from).find(match);
      if (hit !== undefined) return hit;
      if (Date.now() > until) throw new Error(`no matching event within ${ms} ms; saw ${JSON.stringify(seen.map((s) => s.event))}`);
      await sleep(20);
    }
  };
  return { seen, next, close: () => ctl.abort() };
}

// Waits until no event has arrived for `ms` (late fs events from the fixture setup).
async function quiet(client: { seen: Sse[] }, ms = 300): Promise<void> {
  let n = -1;
  for (let i = 0; i < 20 && n !== client.seen.length; i++) {
    n = client.seen.length;
    await sleep(ms);
  }
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const field = (v: unknown, k: string): unknown => (isRec(v) ? v[k] : undefined);
const releaseOf = (data: unknown, root: string): unknown => {
  const list = field(data, 'projects');
  return Array.isArray(list) ? field(list.find((p) => field(p, 'root') === root), 'release') : undefined;
};

describe('release on projects (AC1)', () => {
  test('each project\'s installed release and state against the running one, on GET /projects and the projects event', async () => {
    const clone = await makeClone('0.2.0', CHANGELOG);
    const behind = await makeProject('behind', manifest('0.1.0', { 'a.md': SHA }));
    const current = await makeProject('current', manifest('0.2.0'));
    const ahead = await makeProject('ahead', manifest('0.3.0'));
    const none = await makeProject('none');
    const badJson = await makeProject('bad-json', '{ nope');
    const rejected = await makeProject('rejected', JSON.stringify({ schema: 'factory/v1', version: '0.2.0', files: {}, extra: 1 }));
    const next = await makeProject('next', manifest('next'));
    const bare = join(tmp, 'projects', 'bare');
    await mkdir(bare, { recursive: true });
    await addRoot(registry, bare);

    const { url } = await start(clone);
    const unknown = { installed: null, state: 'unknown' };
    const want = {
      projects: [
        { id: projectId(behind), name: 'behind', root: behind, release: { installed: '0.1.0', state: 'behind' } },
        { id: projectId(current), name: 'current', root: current, release: { installed: '0.2.0', state: 'current' } },
        { id: projectId(ahead), name: 'ahead', root: ahead, release: { installed: '0.3.0', state: 'ahead' } },
        { id: projectId(none), name: 'none', root: none, release: unknown },
        { id: projectId(badJson), name: 'bad-json', root: badJson, release: unknown },
        { id: projectId(rejected), name: 'rejected', root: rejected, release: unknown },
        { id: projectId(next), name: 'next', root: next, release: { installed: 'next', state: 'unknown' } },
        { id: projectId(bare), name: 'bare', root: bare, release: unknown },
      ],
    };
    expect((await get(`${url}/projects`)).body).toEqual(want);
    const client = await connect(url);
    expect((await client.next((e) => e.event === 'projects')).data).toEqual(want);
    client.close();
  });
});

describe('the projects re-send on a managed.json change (AC2)', () => {
  test('an installer write that changes the version re-sends projects; one that only changes files sends none', async () => {
    const clone = await makeClone('0.2.0');
    const a = await makeProject('alpha', manifest('0.1.0'));
    const b = await makeProject('beta', manifest('0.2.0'));
    const { url } = await start(clone);
    const client = await connect(url);
    await client.next((e) => e.event === 'projects');
    await quiet(client);

    let from = client.seen.length;
    await install(a, manifest('0.2.0', { 'x.md': SHA }));
    const ev = await client.next((e) => e.event === 'projects', from);
    expect(releaseOf(ev.data, a)).toEqual({ installed: '0.2.0', state: 'current' });
    expect(releaseOf(ev.data, b)).toEqual({ installed: '0.2.0', state: 'current' });
    expect(releaseOf((await get(`${url}/projects`)).body, a)).toEqual({ installed: '0.2.0', state: 'current' });
    await quiet(client);

    // Only `files` differs: the board event comes, no projects event.
    from = client.seen.length;
    await install(a, manifest('0.2.0', { 'y.md': SHA }));
    await client.next((e) => e.event === 'board' && field(e.data, 'project') === projectId(a), from);
    await quiet(client);
    expect(client.seen.slice(from).some((e) => e.event === 'projects')).toBe(false);

    // Upgraded past the service, then removed: each is a re-send.
    from = client.seen.length;
    await install(a, manifest('0.3.0'));
    expect(releaseOf((await client.next((e) => e.event === 'projects', from)).data, a)).toEqual({ installed: '0.3.0', state: 'ahead' });
    await quiet(client);
    from = client.seen.length;
    await rm(join(a, 'factory', 'managed.json'));
    expect(releaseOf((await client.next((e) => e.event === 'projects', from)).data, a)).toEqual({ installed: null, state: 'unknown' });
    client.close();
  });
});

describe('GET /release (AC3)', () => {
  test('returns running, onDisk, and the changelog newest first', async () => {
    const clone = await makeClone('0.2.0', CHANGELOG);
    const { url } = await start(clone);
    const res = await get(`${url}/release`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ running: '0.2.0', onDisk: '0.2.0', changelog: PARSED });
  });

  test('no CHANGELOG.md is changelog: []', async () => {
    const clone = await makeClone('0.2.0');
    const { url } = await start(clone);
    expect((await get(`${url}/release`)).body).toEqual({ running: '0.2.0', onDisk: '0.2.0', changelog: [] });
  });

  test('with no clone root, running and onDisk are null and every project is unknown', async () => {
    const a = await makeProject('alpha', manifest('0.2.0'));
    const { url } = await start();
    expect((await get(`${url}/release`)).body).toEqual({ running: null, onDisk: null, changelog: [] });
    expect(releaseOf((await get(`${url}/projects`)).body, a)).toEqual({ installed: '0.2.0', state: 'unknown' });
  });

  test('with no readable templates version, running and onDisk are null and every project is unknown', async () => {
    const clone = await makeClone(2, CHANGELOG);
    const a = await makeProject('alpha', manifest('0.2.0'));
    const { url } = await start(clone);
    expect((await get(`${url}/release`)).body).toEqual({ running: null, onDisk: null, changelog: PARSED });
    expect(releaseOf((await get(`${url}/projects`)).body, a)).toEqual({ installed: '0.2.0', state: 'unknown' });
  });
});

describe('the release event (AC5)', () => {
  test('sent on connect after projects, and again on a templates version or CHANGELOG.md change', async () => {
    const clone = await makeClone('0.2.0', CHANGELOG);
    const a = await makeProject('alpha', manifest('0.2.0'));
    const { url } = await start(clone);
    const client = await connect(url);
    const first = await client.next((e) => e.event === 'release');
    expect(first.data).toEqual({ running: '0.2.0', onDisk: '0.2.0', changelog: PARSED });
    expect(client.seen.map((e) => e.event).slice(0, 2)).toEqual(['projects', 'release']);
    await quiet(client);

    // A `git pull` that bumps the templates version: onDisk moves, running and states do not.
    let from = client.seen.length;
    await writeFile(join(clone, 'packages', 'templates', 'package.json'), JSON.stringify({ name: '@factory/templates', version: '0.3.0' }));
    const bumped = await client.next((e) => e.event === 'release' && field(e.data, 'onDisk') === '0.3.0', from);
    expect(bumped.data).toEqual({ running: '0.2.0', onDisk: '0.3.0', changelog: PARSED });
    expect((await get(`${url}/release`)).body).toEqual({ running: '0.2.0', onDisk: '0.3.0', changelog: PARSED });
    expect(releaseOf((await get(`${url}/projects`)).body, a)).toEqual({ installed: '0.2.0', state: 'current' });
    await quiet(client);

    // A CHANGELOG.md edit (replaced by rename, as git checks it out).
    from = client.seen.length;
    const edited = `## v0.3.0 (2026-10-30)\n\n### Added\n- Andon: the new thing (058-andon-version-service)\n\n${CHANGELOG.replace('# Changelog\n\n', '')}`;
    await writeFile(join(clone, '.CHANGELOG.md.tmp'), edited);
    await rename(join(clone, '.CHANGELOG.md.tmp'), join(clone, 'CHANGELOG.md'));
    const changed = await client.next((e) => e.event === 'release' && Array.isArray(field(e.data, 'changelog')) && JSON.stringify(field(e.data, 'changelog')).includes('0.3.0'), from);
    expect(changed.data).toEqual({
      running: '0.2.0',
      onDisk: '0.3.0',
      changelog: [{ version: '0.3.0', date: '2026-10-30', sections: { breaking: [], added: [{ area: 'Andon', text: 'the new thing', job: '058-andon-version-service' }], fixed: [] } }, ...PARSED],
    });
    await quiet(client);

    // Other files in the clone root send nothing.
    from = client.seen.length;
    await writeFile(join(clone, 'README.md'), '# hi\n');
    await writeFile(join(clone, 'packages', 'templates', 'other.json'), '{}');
    await sleep(400);
    expect(client.seen.slice(from).some((e) => e.event === 'release')).toBe(false);
    client.close();
  });

  test('with no clone root, the release event on connect carries nulls', async () => {
    await makeProject('alpha', manifest('0.2.0'));
    const { url } = await start();
    const client = await connect(url);
    expect((await client.next((e) => e.event === 'release')).data).toEqual({ running: null, onDisk: null, changelog: [] });
    client.close();
  });
});

// Every entry under `dir`: its relative path, type, and content (or link target).
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    for (const name of (await readdir(join(dir, rel))).sort()) {
      const path = rel === '' ? name : `${rel}/${name}`;
      const full = join(dir, path);
      const info = await lstat(full);
      if (info.isSymbolicLink()) out[path] = `link ${await readlink(full)}`;
      else if (info.isDirectory()) {
        out[path] = 'dir';
        await walk(path);
      } else out[path] = `file ${createHash('sha256').update(await readFile(full)).digest('hex')}`;
    }
  };
  await walk('');
  return out;
}

describe('the release bundle as the tree it runs in (060 AC7)', () => {
  test('versionFile package.json: GET /release and the release event read the bundle root\'s package.json', async () => {
    const bundle = join(tmp, 'bundle');
    await writeAt(join(bundle, 'package.json'), JSON.stringify({ name: 'factory', version: '0.2.0', bin: { factory: 'bin/factory.js' } }));
    await writeFile(join(bundle, 'CHANGELOG.md'), CHANGELOG);
    const a = await makeProject('alpha', manifest('0.1.0'));
    const { url } = await start(bundle, 'package.json');
    expect((await get(`${url}/release`)).body).toEqual({ running: '0.2.0', onDisk: '0.2.0', changelog: PARSED });
    expect(releaseOf((await get(`${url}/projects`)).body, a)).toEqual({ installed: '0.1.0', state: 'behind' });

    const client = await connect(url);
    await client.next((e) => e.event === 'release');
    await quiet(client);
    const from = client.seen.length;
    await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: 'factory', version: '0.3.0' }));
    const bumped = await client.next((e) => e.event === 'release' && field(e.data, 'onDisk') === '0.3.0', from);
    expect(bumped.data).toEqual({ running: '0.2.0', onDisk: '0.3.0', changelog: PARSED });
    client.close();
  });
});

describe('guards and read-only (AC6)', () => {
  test('a foreign Host or Origin is a 403, a non-GET is a 405, a 200 is no-store, and nothing is written', async () => {
    const clone = await makeClone('0.2.0', CHANGELOG);
    await makeProject('alpha', manifest('0.1.0'));
    await makeProject('beta');
    const before = { clone: await snapshot(clone), projects: await snapshot(join(tmp, 'projects')) };

    const { url } = await start(clone);
    const port = new URL(url).port;
    const bad: Array<Record<string, string>> = [{ host: 'evil.example' }, { host: `evil.example:${port}` }, { host: `127.0.0.1:${port}`, origin: 'http://evil.example' }, { host: `localhost:${port}`, origin: `http://evil.example:${port}` }];
    for (const headers of bad) expect({ headers, status: (await get(`${url}/release`, { headers })).status }).toEqual({ headers, status: 403 });
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) expect({ method, status: (await get(`${url}/release`, { method })).status }).toEqual({ method, status: 405 });
    const ok = await get(`${url}/release`, { headers: { host: `localhost:${port}`, origin: `http://localhost:${port}` } });
    expect(ok.status).toBe(200);
    expect(ok.cache).toBe('no-store');
    expect((await get(`${url}/release?x=1`)).cache).toBe('no-store');

    const client = await connect(url);
    await client.next((e) => e.event === 'release');
    await get(`${url}/projects`);
    client.close();
    await service?.stop();
    service = null;
    expect({ clone: await snapshot(clone), projects: await snapshot(join(tmp, 'projects')) }).toEqual(before);
  });
});
