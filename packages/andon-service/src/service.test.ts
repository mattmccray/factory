import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { connect as tcp } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { addRoot, appendEvent, parseConfig, parseEventInput, registryPath } from '@factory/contract';
import { spawnGit } from './archive';
import { projectId, startService } from './index';
import type { GitRunner, Service } from './index';

const CONFIG = { schema: 'factory/v1', reviewers: ['security', 'code'], maxRound: 2, dashboard: { settleAfterHours: 24 } };

let tmp: string;
let registry: string;
let service: Service | null;
const logs: string[] = [];
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'andon-service-')));
  registry = registryPath(join(tmp, 'andon'));
  service = null;
  logs.length = 0;
});
afterEach(async () => {
  await service?.stop();
  await rm(tmp, { recursive: true, force: true });
});

const start = async (uiDir?: string): Promise<Service> => {
  service = await startService({ port: 0, registryPath: registry, log: (l) => logs.push(l), ...(uiDir === undefined ? {} : { uiDir }) });
  return service;
};
const writeAt = async (path: string, text: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
};

// A project root with factory/config.json and one claimed job per id.
async function makeProject(name: string, ids: string[]): Promise<string> {
  const root = join(tmp, name);
  const factory = join(root, 'factory');
  await writeAt(join(factory, 'config.json'), JSON.stringify(CONFIG));
  const config = parseConfig(CONFIG);
  for (const id of ids) await appendEvent(factory, id, parseEventInput('job.claimed', {}, { id, config }));
  return root;
}

const getJson = async (url: string): Promise<{ status: number; body: unknown; cache: string | null }> => {
  const res = await fetch(url);
  const t = await res.text();
  let body: unknown = t;
  try {
    body = JSON.parse(t);
  } catch {
    // plain-text body
  }
  return { status: res.status, body, cache: res.headers.get('cache-control') };
};

interface Sse {
  event: string;
  data: unknown;
}

// An event-stream client that collects frames and waits for one that matches.
async function connect(url: string): Promise<{ next: (match: (e: Sse) => boolean, ms?: number) => Promise<Sse>; seen: Sse[]; close: () => void; contentType: string | null }> {
  const ctl = new AbortController();
  const res = await fetch(`${url}/events`, { signal: ctl.signal });
  const body = res.body;
  if (body === null) throw new Error('no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const seen: Sse[] = [];
  const waiters: Array<{ match: (e: Sse) => boolean; resolve: (e: Sse) => void; from: number }> = [];
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
          const event = block.match(/^event: (.*)$/m)?.[1] ?? 'message';
          const data: unknown = JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? 'null');
          seen.push({ event, data });
          for (const w of [...waiters]) {
            const hit = seen.slice(w.from).find(w.match);
            if (hit !== undefined) {
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve(hit);
            }
          }
          i = buf.indexOf('\n\n');
        }
      }
    } catch {
      // aborted
    }
  })();
  const next = (match: (e: Sse) => boolean, ms = 2000): Promise<Sse> => {
    const hit = seen.find(match);
    if (hit !== undefined) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no matching event within ${ms} ms; saw ${JSON.stringify(seen.map((s) => s.event))}`)), ms);
      waiters.push({
        match,
        from: 0,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      });
    });
  };
  return { next, seen, close: () => ctl.abort(), contentType: res.headers.get('content-type') };
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const field = (v: unknown, k: string): unknown => (isRec(v) ? v[k] : undefined);
const stagesOf = (data: unknown): unknown[] => {
  const jobs = field(data, 'jobs');
  return Array.isArray(jobs) ? jobs.map((j) => field(j, 'stage')) : [];
};
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('HTTP endpoints (AC3)', () => {
  test('lists projects, serves each board and a job\'s docs in reading order', async () => {
    const a = await makeProject('alpha', ['001-first-job', '002-second-job']);
    const b = await makeProject('beta', ['001-other-job']);
    await addRoot(registry, a);
    await addRoot(registry, b);
    const job = join(a, 'factory', 'jobs', '001-first-job');
    for (const f of ['decision.md', 'conflict-10.md', 'build.md', 'conflict-2.md', 'spec.md', 'feature.md', 'rework-2.md', 'conflict-1.md', 'rework-1.md', 'notes.txt', 'conflict-x.md']) await writeFile(join(job, f), `# ${f}\n`);
    for (const f of ['review-code.md', 'review-security.md', 'review-zeta.md']) await writeAt(join(job, 'round-1', f), `# r1 ${f}\n`);
    await writeAt(join(job, 'round-2', 'review-code.md'), '# r2\n');
    await writeAt(join(job, 'round-1', 'code', 'shot.png'), 'png');

    const { url } = await start();
    const projects = await getJson(`${url}/projects`);
    expect(projects.status).toBe(200);
    expect(projects.cache).toBe('no-store');
    expect(projects.body).toEqual({
      projects: [
        { id: projectId(a), name: 'alpha', root: a },
        { id: projectId(b), name: 'beta', root: b },
      ],
    });
    expect(projectId(a)).toMatch(/^[0-9a-f]{12}$/);
    expect(projectId(a)).toBe(new Bun.CryptoHasher('sha256').update(a).digest('hex').slice(0, 12));

    const boardA = await getJson(`${url}/projects/${projectId(a)}/board`);
    expect(boardA.status).toBe(200);
    expect(boardA.cache).toBe('no-store');
    expect(field(boardA.body, 'config')).toEqual(parseConfig(CONFIG));
    const jobsA = field(boardA.body, 'jobs');
    expect(Array.isArray(jobsA) ? jobsA.map((j) => field(j, 'id')) : null).toEqual(['001-first-job', '002-second-job']);
    const boardB = await getJson(`${url}/projects/${projectId(b)}/board`);
    expect(stagesOf(boardB.body)).toEqual(['claimed']);

    const docs = await getJson(`${url}/projects/${projectId(a)}/jobs/001-first-job/docs`);
    expect(docs.status).toBe(200);
    const files = field(docs.body, 'files');
    expect(Array.isArray(files) ? files.map((f) => field(f, 'path')) : null).toEqual([
      'jobs/001-first-job/feature.md',
      'jobs/001-first-job/spec.md',
      'jobs/001-first-job/build.md',
      'jobs/001-first-job/rework-1.md',
      'jobs/001-first-job/rework-2.md',
      'jobs/001-first-job/conflict-1.md',
      'jobs/001-first-job/conflict-2.md',
      'jobs/001-first-job/conflict-10.md',
      'jobs/001-first-job/decision.md',
      'jobs/001-first-job/round-1/review-security.md',
      'jobs/001-first-job/round-1/review-code.md',
      'jobs/001-first-job/round-1/review-zeta.md',
      'jobs/001-first-job/round-2/review-code.md',
    ]);
    expect(Array.isArray(files) ? field(files[0], 'text') : null).toBe('# feature.md\n');
  });

  test('a brief named in job.json leads the docs', async () => {
    const a = await makeProject('alpha', []);
    const factory = join(a, 'factory');
    await appendEvent(factory, '003-briefed-job', parseEventInput('job.claimed', { brief: 'factory/briefs/thing.md' }, { id: '003-briefed-job', config: parseConfig(CONFIG) }));
    await writeAt(join(factory, 'briefs', 'thing.md'), '# brief\n');
    await writeFile(join(factory, 'jobs', '003-briefed-job', 'spec.md'), '# spec\n');
    await addRoot(registry, a);
    const { url } = await start();
    const docs = await getJson(`${url}/projects/${projectId(a)}/jobs/003-briefed-job/docs`);
    const files = field(docs.body, 'files');
    expect(Array.isArray(files) ? files.map((f) => field(f, 'path')) : null).toEqual(['briefs/thing.md', 'jobs/003-briefed-job/spec.md']);
  });

  test('an unknown project is a 404, a malformed job id is a 404 that reads no file', async () => {
    const a = await makeProject('alpha', ['001-first-job']);
    // A directory whose name is not a job id, with a readable file in it.
    await writeAt(join(a, 'factory', 'jobs', 'Bad_Id', 'spec.md'), 'secret');
    await writeAt(join(a, 'factory', 'secret.md'), 'secret');
    await addRoot(registry, a);
    const { url } = await start();
    const pid = projectId(a);
    expect((await getJson(`${url}/projects/000000000000/board`)).status).toBe(404);
    expect((await getJson(`${url}/projects/000000000000/jobs/001-first-job/docs`)).status).toBe(404);
    for (const bad of ['Bad_Id', '..', '..%2Fsecret.md', '%2e%2e', '1-short', '001-first-job%2F..']) {
      const r = await getJson(`${url}/projects/${pid}/jobs/${bad}/docs`);
      expect({ bad, status: r.status }).toEqual({ bad, status: 404 });
      expect(JSON.stringify(r.body)).not.toContain('secret');
    }
    // A symlinked job dir is never read through.
    await writeAt(join(tmp, 'outside', 'spec.md'), 'secret');
    await symlink(join(tmp, 'outside'), join(a, 'factory', 'jobs', '009-linked-job'));
    const linked = await getJson(`${url}/projects/${pid}/jobs/009-linked-job/docs`);
    expect(linked.body).toEqual({ files: [] });
    expect((await getJson(`${url}/nope`)).status).toBe(404);
    expect((await fetch(`${url}/projects`, { method: 'POST' })).status).toBe(405);
  });

  test('a bad config.json is a 500 carrying the reason, on board and docs', async () => {
    const a = await makeProject('alpha', ['001-first-job']);
    await writeFile(join(a, 'factory', 'config.json'), JSON.stringify({ ...CONFIG, extra: true }));
    await addRoot(registry, a);
    const { url } = await start();
    const r = await getJson(`${url}/projects/${projectId(a)}/board`);
    expect(r.status).toBe(500);
    expect(String(r.body)).toStartWith('config.json: ');
    expect(String(r.body)).toContain('extra');
    const d = await getJson(`${url}/projects/${projectId(a)}/jobs/001-first-job/docs`);
    expect(d.status).toBe(500);
    expect(String(d.body)).toContain('extra');
  });

  test('a job.json that goes missing or is mid-write keeps the last good snapshot', async () => {
    const a = await makeProject('alpha', ['001-first-job']);
    await addRoot(registry, a);
    const { url } = await start();
    const board = `${url}/projects/${projectId(a)}/board`;
    expect(stagesOf((await getJson(board)).body)).toEqual(['claimed']);
    await writeFile(join(a, 'factory', 'jobs', '001-first-job', 'job.json'), '{"id": "001-fi');
    expect(stagesOf((await getJson(board)).body)).toEqual(['claimed']);
    await rm(join(a, 'factory', 'jobs', '001-first-job', 'job.json'));
    expect(stagesOf((await getJson(board)).body)).toEqual(['claimed']);
  });

  test('a registered project with no factory/ is still listed', async () => {
    const bare = join(tmp, 'bare');
    await mkdir(bare);
    await addRoot(registry, bare);
    const { url } = await start();
    expect((await getJson(`${url}/projects`)).body).toEqual({ projects: [{ id: projectId(bare), name: basename(bare), root: bare }] });
  });
});

const namesOf = (data: unknown): unknown[] => {
  const list = field(data, 'projects');
  return Array.isArray(list) ? list.map((p) => field(p, 'name')) : [];
};

describe('project names from config.json (AC3, AC4)', () => {
  test('GET /projects and the projects event on connect report the config name, else the basename', async () => {
    const named = await makeProject('named', []);
    await writeFile(join(named, 'factory', 'config.json'), JSON.stringify({ ...CONFIG, name: 'Café — Ops (v2)!' }));
    const plain = await makeProject('plain', []);
    const invalid = await makeProject('invalid', []);
    await writeFile(join(invalid, 'factory', 'config.json'), JSON.stringify({ ...CONFIG, name: ' Padded' }));
    const bare = join(tmp, 'bare');
    await mkdir(bare);
    for (const r of [named, plain, invalid, bare]) await addRoot(registry, r);

    const { url } = await start();
    const want = {
      projects: [
        { id: projectId(named), name: 'Café — Ops (v2)!', root: named },
        { id: projectId(plain), name: 'plain', root: plain },
        { id: projectId(invalid), name: 'invalid', root: invalid },
        { id: projectId(bare), name: 'bare', root: bare },
      ],
    };
    expect((await getJson(`${url}/projects`)).body).toEqual(want);
    const client = await connect(url);
    expect((await client.next((e) => e.event === 'projects')).data).toEqual(want);
    expect(client.seen[0]?.event).toBe('projects');
    client.close();
  });

  test('a name gained, changed, removed, or invalidated is re-sent as projects; an edit that keeps it sends none', async () => {
    const a = await makeProject('alpha', ['001-first-job']);
    const b = await makeProject('beta', []);
    await addRoot(registry, a);
    await addRoot(registry, b);
    const config = join(a, 'factory', 'config.json');
    const { url } = await start();
    const client = await connect(url);
    expect(namesOf((await client.next((e) => e.event === 'projects')).data)).toEqual(['alpha', 'beta']);
    await settle(150);

    const step = async (body: unknown, name: string, also: 'board' | 'error'): Promise<void> => {
      const from = client.seen.length;
      await writeFile(config, typeof body === 'string' ? body : JSON.stringify(body));
      const since = (e: Sse): boolean => client.seen.indexOf(e) >= from;
      const ev = await client.next((e) => since(e) && e.event === 'projects');
      expect(namesOf(ev.data)).toEqual([name, 'beta']);
      const list = field(ev.data, 'projects');
      expect(Array.isArray(list) ? list.map((p) => field(p, 'id')) : null).toEqual([projectId(a), projectId(b)]);
      await client.next((e) => since(e) && e.event === also && field(e.data, 'project') === projectId(a));
      expect(namesOf((await getJson(`${url}/projects`)).body)).toEqual([name, 'beta']);
    };
    await step({ ...CONFIG, name: 'Minerva Admin' }, 'Minerva Admin', 'board'); // gained
    await step({ ...CONFIG, name: 'Minerva Ops' }, 'Minerva Ops', 'board'); // changed
    await step(CONFIG, 'alpha', 'board'); // removed
    await step({ ...CONFIG, name: 'Back' }, 'Back', 'board');
    await step({ ...CONFIG, name: 'Back', nope: 1 }, 'alpha', 'error'); // turned invalid

    // An edit that leaves the resolved name unchanged: a board event, no projects event.
    await step({ ...CONFIG, name: 'Same' }, 'Same', 'board');
    await settle(150);
    const from = client.seen.length;
    await writeFile(config, JSON.stringify({ ...CONFIG, maxRound: 3, name: 'Same' }));
    await client.next((e) => client.seen.indexOf(e) >= from && e.event === 'board' && field(field(e.data, 'config'), 'maxRound') === 3);
    await settle(300);
    expect(client.seen.slice(from).some((e) => e.event === 'projects')).toBe(false);
    client.close();
  });
});

describe('DNS-rebinding guard', () => {
  test('a foreign Host or Origin is a 403 on every endpoint, including /events', async () => {
    const a = await makeProject('alpha', ['001-first-job']);
    await addRoot(registry, a);
    const { url } = await start();
    const port = new URL(url).port;
    const paths = ['/projects', `/projects/${projectId(a)}/board`, `/projects/${projectId(a)}/jobs/001-first-job/docs`, '/events'];
    for (const path of paths) {
      const bad: Array<Record<string, string>> = [{ host: 'evil.example' }, { host: `evil.example:${port}` }, { host: `127.0.0.1:${port}`, origin: 'http://evil.example' }, { host: `localhost:${port}`, origin: `http://evil.example:${port}` }];
      for (const headers of bad) {
        const res = await fetch(`${url}${path}`, { headers });
        expect({ path, headers, status: res.status }).toEqual({ path, headers, status: 403 });
        await res.body?.cancel();
      }
    }
    const good: Array<Record<string, string>> = [{ host: `localhost:${port}` }, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }, { host: `localhost:${port}`, origin: `http://localhost:${port}` }];
    for (const headers of good) {
      const res = await fetch(`${url}/projects`, { headers });
      expect({ headers, status: res.status }).toEqual({ headers, status: 200 });
    }
  });
});

describe('the event stream (AC4, AC5)', () => {
  test('sends projects on connect, then a board event within 2 s of appendEvent', async () => {
    const a = await makeProject('alpha', ['001-first-job']);
    await addRoot(registry, a);
    const { url } = await start();
    const client = await connect(url);
    expect(client.contentType).toStartWith('text/event-stream');
    const first = await client.next((e) => e.event === 'projects');
    expect(client.seen[0]?.event).toBe('projects');
    expect(first.data).toEqual({ projects: [{ id: projectId(a), name: 'alpha', root: a }] });
    await settle(150);

    await appendEvent(join(a, 'factory'), '001-first-job', parseEventInput('stage.entered', { stage: 'spec' }));
    const ev = await client.next((e) => e.event === 'board' && stagesOf(e.data).includes('spec'), 2000);
    expect(field(ev.data, 'project')).toBe(projectId(a));
    expect(field(ev.data, 'config')).toEqual(parseConfig(CONFIG));
    client.close();
  });

  test('a burst of changes yields one board event per project', async () => {
    const a = await makeProject('alpha', ['001-first-job']);
    await addRoot(registry, a);
    const { url } = await start();
    const client = await connect(url);
    await client.next((e) => e.event === 'projects');
    await settle(150);
    const factory = join(a, 'factory');
    // Late fs events from the fixture setup may still yield board events: only what follows the
    // burst's first append counts.
    const from = client.seen.length;
    await appendEvent(factory, '001-first-job', parseEventInput('stage.entered', { stage: 'spec' }));
    await appendEvent(factory, '001-first-job', parseEventInput('stage.entered', { stage: 'build' }));
    await client.next((e) => e.event === 'board' && stagesOf(e.data).includes('build'));
    await settle(400);
    expect(client.seen.slice(from).filter((e) => e.event === 'board').length).toBeLessThanOrEqual(2);
    client.close();
  });

  test('a bad config yields an error event for that project instead of a board event', async () => {
    const a = await makeProject('alpha', ['001-first-job']);
    await addRoot(registry, a);
    const { url } = await start();
    const client = await connect(url);
    await client.next((e) => e.event === 'projects');
    await settle(150);
    // Late fs events from the fixture setup may still yield a legitimate board event: only what
    // follows the bad write counts.
    await writeFile(join(a, 'factory', 'config.json'), '{"schema": "factory/v1", "nope": 1}');
    const ev = await client.next((e) => e.event === 'error');
    expect(field(ev.data, 'project')).toBe(projectId(a));
    expect(String(field(ev.data, 'reason'))).toStartWith('config.json: ');
    await settle(300);
    expect(client.seen.slice(client.seen.indexOf(ev)).some((e) => e.event === 'board')).toBe(false);
    client.close();
  });

  test('a root added to the registry is announced and then watched; .worktrees/ is not', async () => {
    const a = await makeProject('alpha', ['001-first-job']);
    const b = await makeProject('beta', ['001-other-job']);
    const c = await makeProject('gamma', ['001-third-job']);
    await addRoot(registry, a);
    await addRoot(registry, b);
    const { url } = await start();
    const client = await connect(url);
    await client.next((e) => e.event === 'projects');

    await addRoot(registry, c);
    const listed = await client.next((e) => e.event === 'projects' && JSON.stringify(e.data).includes(c));
    expect(field(listed.data, 'projects')).toEqual([
      { id: projectId(a), name: 'alpha', root: a },
      { id: projectId(b), name: 'beta', root: b },
      { id: projectId(c), name: 'gamma', root: c },
    ]);
    await settle(150);

    // Writes under the new project's .worktrees/ and .lock/ produce nothing. First wait for a
    // quiet window, so late fs events from the fixture setup are not counted.
    let settled = client.seen.length;
    for (let i = 0; i < 10; i++) {
      await settle(200);
      if (client.seen.length === settled) break;
      settled = client.seen.length;
    }
    const quietFrom = client.seen.length;
    await writeAt(join(c, 'factory', '.worktrees', '001-third-job', 'src', 'x.ts'), 'x');
    await writeAt(join(c, 'factory', '.worktrees', '001-third-job', 'y.ts'), 'y');
    await writeAt(join(c, 'factory', '.lock', 'held'), 'z');
    await settle(500);
    expect(client.seen.slice(quietFrom)).toEqual([]);

    await appendEvent(join(c, 'factory'), '001-third-job', parseEventInput('stage.entered', { stage: 'spec' }));
    const ev = await client.next((e) => e.event === 'board' && field(e.data, 'project') === projectId(c));
    expect(stagesOf(ev.data)).toEqual(['spec']);
    client.close();
  });

  test('an invalid registry edit keeps the current list and is logged', async () => {
    const a = await makeProject('alpha', []);
    await addRoot(registry, a);
    const { url } = await start();
    await writeFile(registry, '{"schema":"factory/v2","projects":[]}');
    // Wait for the service to reload and log the rejection (deadline 2 s), not a fixed delay.
    const deadline = Date.now() + 2000;
    while (!logs.some((l) => l.includes('schema')) && Date.now() < deadline) await settle(20);
    expect(logs.some((l) => l.includes('schema'))).toBe(true);
    expect(field((await getJson(`${url}/projects`)).body, 'projects')).toEqual([{ id: projectId(a), name: 'alpha', root: a }]);
  });
});

// A request sent as raw bytes, so the path reaches the server exactly as written (fetch would
// normalize `..`). Resolves to the response's status code.
function rawStatus(url: string, path: string): Promise<number> {
  const { hostname, port } = new URL(url);
  return new Promise((done, fail) => {
    const sock = tcp({ host: hostname, port: Number(port) }, () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/^HTTP\/1\.1 (\d{3})/);
      if (m !== null) {
        sock.destroy();
        done(Number(m[1]));
      }
    });
    sock.on('error', fail);
  });
}

describe('the built UI (AC5)', () => {
  async function makeUi(): Promise<string> {
    const ui = join(tmp, 'ui', 'dist');
    await writeAt(join(ui, 'index.html'), '<!doctype html><title>Andon</title>');
    await writeAt(join(ui, 'assets', 'app-abc123.js'), 'console.log("andon")');
    await writeAt(join(tmp, 'ui', 'secret.txt'), 'outside the build');
    await writeAt(join(tmp, 'outside', 'leak.txt'), 'outside the build');
    await symlink(join(tmp, 'outside', 'leak.txt'), join(ui, 'assets', 'leak.txt'));
    await symlink(join(tmp, 'outside'), join(ui, 'linked'));
    return ui;
  }

  test('GET / is index.html and an asset path is its file, both no-store', async () => {
    const { url } = await start(await makeUi());
    const index = await fetch(`${url}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('cache-control')).toBe('no-store');
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toContain('<title>Andon</title>');
    const asset = await fetch(`${url}/assets/app-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toBe('no-store');
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(await asset.text()).toBe('console.log("andon")');
  });

  test('a path escaping the build by .., encoded .., or a symlink is a 404', async () => {
    const { url } = await start(await makeUi());
    const escapes = ['/../secret.txt', '/assets/../../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/%2E%2E%2Fsecret.txt', '/assets/leak.txt', '/linked/leak.txt', '/assets/%00x', '/%E0%A4%A'];
    for (const path of escapes) expect({ path, status: await rawStatus(url, path) }).toEqual({ path, status: 404 });
    for (const path of escapes) {
      const res = await fetch(`${url}${path}`);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(await rawStatus(url, '/assets/app-abc123.js')).toBe(200); // the raw client itself works
    expect((await fetch(`${url}/assets`)).status).toBe(404); // a directory is not a file
    expect((await fetch(`${url}/missing.js`)).status).toBe(404);
  });

  test('the guards still apply: a foreign Host or Origin is a 403, a non-GET is a 405', async () => {
    const { url } = await start(await makeUi());
    const port = new URL(url).port;
    for (const path of ['/', '/assets/app-abc123.js']) {
      expect((await fetch(`${url}${path}`, { headers: { host: `evil.example:${port}` } })).status).toBe(403);
      expect((await fetch(`${url}${path}`, { headers: { origin: 'http://evil.example' } })).status).toBe(403);
      for (const method of ['POST', 'PUT', 'DELETE']) expect((await fetch(`${url}${path}`, { method })).status).toBe(405);
    }
  });

  test('with no build present, GET / is a 404 and the API is unchanged', async () => {
    const a = await makeProject('alpha', ['001-first-job']);
    await addRoot(registry, a);
    for (const uiDir of [undefined, join(tmp, 'never-built')]) {
      const { url } = await start(uiDir);
      const root = await fetch(`${url}/`);
      expect(root.status).toBe(404);
      expect(root.headers.get('cache-control')).toBe('no-store');
      expect((await fetch(`${url}/index.html`)).status).toBe(404);
      expect(field((await getJson(`${url}/projects`)).body, 'projects')).toEqual([{ id: projectId(a), name: 'alpha', root: a }]);
      expect((await getJson(`${url}/projects/${projectId(a)}/board`)).status).toBe(200);
      expect((await getJson(`${url}/projects/nope/board`)).status).toBe(404);
      await service?.stop();
      service = null;
    }
  });

  test('successful UI route responses carry the CSP; API, SSE, 404, 403, and 405 responses do not', async () => {
    const csp =
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    expect(csp).not.toContain('unsafe-');
    const a = await makeProject('alpha', ['001-first-job']);
    await addRoot(registry, a);
    const { url } = await start(await makeUi());
    const port = new URL(url).port;
    for (const path of ['/', '/assets/app-abc123.js']) {
      const res = await fetch(`${url}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-security-policy')).toBe(csp);
    }
    const none = async (res: Response, status: number, body?: string): Promise<void> => {
      expect(res.status).toBe(status);
      expect(res.headers.get('content-security-policy')).toBeNull();
      if (body !== undefined) expect(await res.text()).toBe(body);
    };
    await none(await fetch(`${url}/projects`), 200);
    await none(await fetch(`${url}/projects/${projectId(a)}/board`), 200);
    await none(await fetch(`${url}/projects/${projectId(a)}/jobs/001-first-job/docs`), 200);
    await none(await fetch(`${url}/missing.js`), 404, 'Not found');
    await none(await fetch(`${url}/`, { headers: { host: `evil.example:${port}` } }), 403, 'Forbidden');
    await none(await fetch(`${url}/`, { method: 'POST' }), 405, 'Method not allowed');
    const ctl = new AbortController();
    const sse = await fetch(`${url}/events`, { signal: ctl.signal });
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    expect(sse.headers.get('content-security-policy')).toBeNull();
    ctl.abort();
  });

  test('the API wins over a build file of the same name', async () => {
    const ui = await makeUi();
    await writeAt(join(ui, 'projects'), 'not the API');
    const { url } = await start(ui);
    expect(field((await getJson(`${url}/projects`)).body, 'projects')).toEqual([]);
  });
});

describe('abandoned jobs (AC5)', () => {
  test('the board returns an abandoned snapshot with stoppedBy/stoppedFrom intact', async () => {
    const a = await makeProject('alpha', ['001-first-job', '002-second-job']);
    const factory = join(a, 'factory');
    const steps: Array<[string, Record<string, unknown>]> = [
      ['stage.entered', { stage: 'spec' }], ['stage.entered', { stage: 'build' }],
      ['job.escalated', { reason: 'stuck' }], ['job.abandoned', { reason: 'dead end' }],
    ];
    for (const [type, fields] of steps) await appendEvent(factory, '001-first-job', parseEventInput(type, fields));
    await addRoot(registry, a);
    const { url } = await start();
    const board = await getJson(`${url}/projects/${projectId(a)}/board`);
    expect(board.status).toBe(200);
    const jobs = field(board.body, 'jobs');
    const abandoned = Array.isArray(jobs) ? jobs.find((j) => field(j, 'id') === '001-first-job') : undefined;
    expect(abandoned).toMatchObject({ stage: 'abandoned', note: 'dead end', stoppedBy: 'escalated', stoppedFrom: 'build' });
    expect(typeof field(abandoned, 'endedAt')).toBe('string');
    const other = Array.isArray(jobs) ? jobs.find((j) => field(j, 'id') === '002-second-job') : undefined;
    expect(other).toMatchObject({ stage: 'claimed', stoppedBy: null, stoppedFrom: null });
  });
});

// --- Jobs found only on `factory/archive` (job 047) ---

const testEnv = (extra: Record<string, string> = {}): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_')) env[k] = v;
  return { ...env, ...extra };
};

// Runs git for a fixture (never the service's runner); throws on a non-zero exit.
function gitFx(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const p = Bun.spawnSync(['git', '-c', 'user.name=andon-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: testEnv(env),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString().trim();
}

// A project root that is a git repo on `main` with one commit, factory/config.json, and claimed jobs.
async function makeRepoProject(name: string, ids: string[]): Promise<string> {
  const root = await makeProject(name, ids);
  gitFx(root, ['init', '--quiet', '--initial-branch=main']);
  gitFx(root, ['commit', '--quiet', '--allow-empty', '-m', 'init']);
  return root;
}

// Archives jobs the way `factory archive` lays them out: `<id>/` holds every file of `jobs/<id>/`
// but `job.json` (kept for a legacy job), one commit on top of the current tip. `stage` holds
// every job archived so far. `extra` runs on the staged index before the tree is written.
async function archiveJobs(repo: string, stage: string, ids: string[], extra?: (env: Record<string, string>) => void): Promise<string> {
  const gitDir = gitFx(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  for (const id of ids) {
    const dir = join(repo, 'factory', 'jobs', id);
    const legacy = !(await Bun.file(join(dir, 'events.jsonl')).exists());
    await cp(dir, join(stage, id), { recursive: true, verbatimSymlinks: true, filter: (src) => legacy || basename(src) !== 'job.json' });
  }
  const idx = join(tmp, `index-${Math.random().toString(16).slice(2)}`);
  const env = { GIT_DIR: gitDir, GIT_WORK_TREE: stage, GIT_INDEX_FILE: idx };
  gitFx(stage, ['add', '-A', '-f', '.'], env);
  extra?.(env);
  const tree = gitFx(stage, ['write-tree'], env);
  const tip = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', 'refs/heads/factory/archive^{commit}'], { cwd: repo, env: testEnv(), stdout: 'pipe' }).stdout.toString().trim();
  const commit = gitFx(repo, ['commit-tree', tree, ...(tip === '' ? [] : ['-p', tip]), '-m', `chore(factory): archive job ${ids.join(' ')}`]);
  gitFx(repo, ['update-ref', 'refs/heads/factory/archive', commit, ...(tip === '' ? [''] : [tip])]);
  await rm(idx, { force: true });
  return commit;
}

const idsOf = (body: unknown): unknown[] => {
  const jobs = field(body, 'jobs');
  return Array.isArray(jobs) ? jobs.map((j) => field(j, 'id')) : [];
};
const jobOf = (body: unknown, id: string): unknown => {
  const jobs = field(body, 'jobs');
  return Array.isArray(jobs) ? jobs.find((j) => field(j, 'id') === id) : undefined;
};
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));

interface GitCall {
  args: string[];
  cwd: string;
}
// The real runner, recording every invocation.
const recording = (calls: GitCall[]): GitRunner => async (args, opts) => {
  calls.push({ args: [...args], cwd: opts.cwd });
  return spawnGit(args, opts);
};
const startWith = async (git: GitRunner): Promise<Service> => {
  service = await startService({ port: 0, registryPath: registry, log: (l) => logs.push(l), git });
  return service;
};
// Waits until no event has arrived for `quiet` ms (late fs events from the fixture setup).
async function quiet(client: { seen: Sse[] }, calls: GitCall[] = [], ms = 300): Promise<void> {
  let n = -1;
  for (let i = 0; i < 20 && n !== client.seen.length + calls.length; i++) {
    n = client.seen.length + calls.length;
    await settle(ms);
  }
}

// Gives a job real history and docs: spec, build, a review round, a rework, and a supporting file.
async function fleshOut(root: string, id: string, brief?: string): Promise<void> {
  const factory = join(root, 'factory');
  const dir = join(factory, 'jobs', id);
  for (const stage of ['spec', 'build']) await appendEvent(factory, id, parseEventInput('stage.entered', { stage }));
  for (const f of ['spec.md', 'build.md', 'feature.md', 'rework-1.md', 'decision.md']) await writeFile(join(dir, f), `# ${id} ${f}\n\nCafé — ✓\n`);
  await writeAt(join(dir, 'round-1', 'review-code.md'), '# code\n');
  await writeAt(join(dir, 'round-1', 'review-security.md'), '# security\n');
  await writeAt(join(dir, 'round-1', 'code', 'shot.png'), 'png');
  if (brief !== undefined) await writeAt(join(factory, brief.replace(/^factory\//, '')), '# the brief\n');
}

describe('archived jobs (job 047)', () => {
  test('AC1/AC2/AC6: an archived-only job is on the board and its docs match the local copy; bad entries are ignored', async () => {
    const root = await makeRepoProject('alpha', ['001-local-job']);
    const factory = join(root, 'factory');
    const config = parseConfig(CONFIG);
    await appendEvent(factory, '002-archived-job', parseEventInput('job.claimed', { brief: 'factory/briefs/two.md' }, { id: '002-archived-job', config }));
    await fleshOut(root, '002-archived-job', 'factory/briefs/two.md');
    for (const f of ['conflict-2.md', 'conflict-1.md']) await writeFile(join(factory, 'jobs', '002-archived-job', f), `# ${f}\n`);
    await symlink(join(factory, 'jobs', '002-archived-job', 'spec.md'), join(factory, 'jobs', '002-archived-job', 'round-1', 'review-link.md'));
    // A legacy job: job.json only.
    const legacy = { schema: 'factory/v1', id: '003-legacy-job', title: 'Legacy', stage: 'merged', round: 1, extra: { kept: true } };
    await writeAt(join(factory, 'jobs', '003-legacy-job', 'job.json'), JSON.stringify(legacy));
    await writeFile(join(factory, 'jobs', '003-legacy-job', 'spec.md'), '# legacy spec\n');
    await appendEvent(factory, '004-later-local', parseEventInput('job.claimed', {}, { id: '004-later-local', config }));
    await addRoot(registry, root);

    // The local copies, before their dirs are removed.
    const before = await start();
    const docsBefore = async (id: string): Promise<unknown> => (await getJson(`${before.url}/projects/${projectId(root)}/jobs/${id}/docs`)).body;
    const docs2 = await docsBefore('002-archived-job');
    const docs3 = await docsBefore('003-legacy-job');
    await before.stop();
    service = null;
    const job2 = await readJson(join(factory, 'jobs', '002-archived-job', 'job.json'));
    expect(field(job2, 'stage')).toBe('build');

    const stage = join(tmp, 'stage');
    // Bad entries: a torn log, a log not starting with job.claimed, a legacy job.json that's an
    // array, a non-job top-level dir and file, and a submodule entry.
    await writeAt(join(stage, '005-torn-job', 'events.jsonl'), `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', type: 'job.claimed', schema: 'factory/v1', id: '005-torn-job', maxRound: 2, reviewers: [] })}\n{"ts":"2026-`);
    await writeAt(join(stage, '006-headless-job', 'events.jsonl'), `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', type: 'stage.entered', stage: 'spec' })}\n`);
    await writeAt(join(stage, '007-array-job', 'job.json'), '[1, 2]');
    await writeAt(join(stage, '008-empty-log', 'events.jsonl'), '');
    await writeAt(join(stage, 'Bad_Id', 'job.json'), JSON.stringify({ ...legacy, id: 'Bad_Id' }));
    await writeAt(join(stage, 'README.md'), '# not a job\n');
    const head = gitFx(root, ['rev-parse', 'HEAD']);
    await archiveJobs(root, stage, ['002-archived-job', '003-legacy-job'], (env) => {
      gitFx(stage, ['update-index', '--add', '--cacheinfo', `160000,${head},009-submodule/job.json`], env);
    });
    await rm(join(factory, 'jobs', '002-archived-job'), { recursive: true });
    await rm(join(factory, 'jobs', '003-legacy-job'), { recursive: true });

    const { url } = await start();
    const board = await getJson(`${url}/projects/${projectId(root)}/board`);
    expect(board.status).toBe(200);
    expect(Object.keys(isRec(board.body) ? board.body : {}).sort()).toEqual(['config', 'epics', 'jobs']);
    expect(field(board.body, 'config')).toEqual(parseConfig(CONFIG));
    expect(idsOf(board.body)).toEqual(['001-local-job', '002-archived-job', '003-legacy-job', '004-later-local']);
    expect(jobOf(board.body, '002-archived-job')).toEqual(job2);
    expect(jobOf(board.body, '003-legacy-job')).toEqual(legacy);

    const docs = async (id: string): Promise<unknown> => (await getJson(`${url}/projects/${projectId(root)}/jobs/${id}/docs`)).body;
    expect(await docs('002-archived-job')).toEqual(docs2);
    const paths = field(docs2, 'files');
    expect(Array.isArray(paths) ? paths.map((f) => field(f, 'path')) : null).toEqual([
      'briefs/two.md',
      'jobs/002-archived-job/feature.md',
      'jobs/002-archived-job/spec.md',
      'jobs/002-archived-job/build.md',
      'jobs/002-archived-job/rework-1.md',
      'jobs/002-archived-job/conflict-1.md',
      'jobs/002-archived-job/conflict-2.md',
      'jobs/002-archived-job/decision.md',
      'jobs/002-archived-job/round-1/review-security.md',
      'jobs/002-archived-job/round-1/review-code.md',
    ]);
    expect(await docs('003-legacy-job')).toEqual(docs3);
    for (const id of ['005-torn-job', '006-headless-job', '007-array-job', '008-empty-log', '009-submodule']) expect({ id, docs: await docs(id) }).toEqual({ id, docs: { files: [] } });
    for (const id of ['005-torn-job', '006-headless-job', '007-array-job', '008-empty-log']) expect({ id, logged: logs.some((l) => l.includes(id)) }).toEqual({ id, logged: true });

    // Without the brief locally, the archived job's docs simply omit it.
    await rm(join(factory, 'briefs'), { recursive: true });
    const noBrief = field(await docs('002-archived-job'), 'files');
    expect(Array.isArray(noBrief) ? noBrief.map((f) => field(f, 'path'))[0] : null).toBe('jobs/002-archived-job/feature.md');
  });

  test('AC3: a job both local and archived is served from the local copy only', async () => {
    const root = await makeRepoProject('alpha', ['001-both-job']);
    const factory = join(root, 'factory');
    const dir = join(factory, 'jobs', '001-both-job');
    await writeFile(join(dir, 'spec.md'), '# archived spec\n');
    const stage = join(tmp, 'stage');
    await archiveJobs(root, stage, ['001-both-job']);
    await appendEvent(factory, '001-both-job', parseEventInput('stage.entered', { stage: 'spec' }));
    await writeFile(join(dir, 'spec.md'), '# local spec\n');
    await writeFile(join(dir, 'build.md'), '# local build\n');
    await addRoot(registry, root);

    const { url } = await start();
    const pid = projectId(root);
    const board = await getJson(`${url}/projects/${pid}/board`);
    expect(idsOf(board.body)).toEqual(['001-both-job']);
    expect(jobOf(board.body, '001-both-job')).toEqual(await readJson(join(dir, 'job.json')));
    expect(field(jobOf(board.body, '001-both-job'), 'stage')).toBe('spec');
    expect((await getJson(`${url}/projects/${pid}/jobs/001-both-job/docs`)).body).toEqual({
      files: [
        { path: 'jobs/001-both-job/spec.md', text: '# local spec\n' },
        { path: 'jobs/001-both-job/build.md', text: '# local build\n' },
      ],
    });
    // The last-good rule: a job.json mid-write keeps the last local read, never the archived copy.
    await writeFile(join(dir, 'job.json'), '{"id": "001-bo');
    expect(stagesOf((await getJson(`${url}/projects/${pid}/board`)).body)).toEqual(['spec']);
  });

  test('AC4: a board event follows the archive branch being created, moved, and repacked', async () => {
    const root = await makeRepoProject('alpha', ['001-first-job', '002-second-job', '003-third-job']);
    await addRoot(registry, root);
    const { url } = await start();
    const pid = projectId(root);
    const client = await connect(url);
    await client.next((e) => e.event === 'projects');
    await quiet(client);
    const stage = join(tmp, 'stage');
    const factory = join(root, 'factory');
    const boardWith = (id: string, from: number) => client.next((e) => client.seen.indexOf(e) >= from && e.event === 'board' && field(e.data, 'project') === pid && idsOf(e.data).includes(id));

    // Created after startup (no refs/heads/factory/ yet), as a loose ref.
    let from = client.seen.length;
    await archiveJobs(root, stage, ['001-first-job']);
    await rm(join(factory, 'jobs', '001-first-job'), { recursive: true });
    await boardWith('001-first-job', from);
    await quiet(client);

    // Moved by a new archive commit.
    from = client.seen.length;
    await archiveJobs(root, stage, ['002-second-job']);
    await rm(join(factory, 'jobs', '002-second-job'), { recursive: true });
    await boardWith('002-second-job', from);
    await quiet(client);

    // Packed, then moved in packed-refs only (no loose ref): only the packed-refs watch can see it.
    gitFx(root, ['pack-refs', '--all']);
    await quiet(client);
    const prev = gitFx(root, ['rev-parse', 'refs/heads/factory/archive']);
    await cp(join(factory, 'jobs', '003-third-job'), join(stage, '003-third-job'), { recursive: true, filter: (src) => basename(src) !== 'job.json' });
    const gitDir = gitFx(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const idx = join(tmp, 'index-packed');
    const env = { GIT_DIR: gitDir, GIT_WORK_TREE: stage, GIT_INDEX_FILE: idx };
    gitFx(stage, ['add', '-A', '-f', '.'], env);
    const commit = gitFx(root, ['commit-tree', gitFx(stage, ['write-tree'], env), '-p', prev, '-m', 'archive 003']);
    await rm(join(factory, 'jobs', '003-third-job'), { recursive: true });
    await quiet(client);
    const packed = join(gitDir, 'packed-refs');
    const text = await readFile(packed, 'utf8');
    expect(text).toContain(`${prev} refs/heads/factory/archive`);
    from = client.seen.length;
    await writeFile(`${packed}.lock`, text.replace(`${prev} refs/heads/factory/archive`, `${commit} refs/heads/factory/archive`));
    await rename(`${packed}.lock`, packed);
    const ev = await boardWith('003-third-job', from);
    expect(idsOf(ev.data)).toEqual(['001-first-job', '002-second-job', '003-third-job']);
    client.close();
  });

  test('AC4: a linked worktree project sees archive moves made in the main repo', async () => {
    const main = await makeRepoProject('main-repo', ['001-first-job']);
    const linked = join(tmp, 'linked');
    gitFx(main, ['worktree', 'add', '--quiet', '-b', 'side', linked]);
    await writeAt(join(linked, 'factory', 'config.json'), JSON.stringify(CONFIG));
    await addRoot(registry, linked);
    const { url } = await start();
    const pid = projectId(linked);
    const client = await connect(url);
    await client.next((e) => e.event === 'projects');
    await quiet(client);
    const from = client.seen.length;
    await archiveJobs(main, join(tmp, 'stage'), ['001-first-job']);
    await client.next((e) => client.seen.indexOf(e) >= from && e.event === 'board' && field(e.data, 'project') === pid && idsOf(e.data).includes('001-first-job'));
    expect(idsOf((await getJson(`${url}/projects/${pid}/board`)).body)).toEqual(['001-first-job']);
    client.close();
  });

  test('AC5/AC6: jobs/ changes run no git; an archive move runs one ls-tree and one cat-file --batch; argv is fixed and read-only', async () => {
    const root = await makeRepoProject('alpha', ['001-first-job', '002-second-job', '003-third-job', '004-live-job']);
    const stage = join(tmp, 'stage');
    await fleshOut(root, '001-first-job');
    await archiveJobs(root, stage, ['001-first-job', '002-second-job']);
    await addRoot(registry, root);
    const calls: GitCall[] = [];
    const { url } = await startWith(recording(calls));
    const pid = projectId(root);
    const client = await connect(url);
    await client.next((e) => e.event === 'projects');
    await quiet(client, calls);
    const count = (cmd: string, list = calls): number => list.filter((c) => c.args[0] === cmd).length;
    // Startup: the common dir and the tip once each, then one ls-tree and one cat-file for every file.
    expect(count('ls-tree')).toBe(1);
    expect(count('cat-file')).toBe(1);
    expect(calls.slice(0, 2).map((c) => c.args)).toEqual([
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      ['rev-parse', '--verify', '--quiet', 'refs/heads/factory/archive^{commit}'],
    ]);

    // A change under factory/jobs/: a board event, and no git at all.
    let mark = calls.length;
    let from = client.seen.length;
    await appendEvent(join(root, 'factory'), '004-live-job', parseEventInput('stage.entered', { stage: 'spec' }));
    await client.next((e) => client.seen.indexOf(e) >= from && e.event === 'board' && field(jobOf(e.data, '004-live-job'), 'stage') === 'spec');
    await getJson(`${url}/projects/${pid}/board`);
    await getJson(`${url}/projects/${pid}/jobs/001-first-job/docs`);
    await settle(200);
    expect(calls.slice(mark)).toEqual([]);

    // A job branch moving re-reads the tip only.
    await quiet(client, calls);
    mark = calls.length;
    from = client.seen.length;
    gitFx(root, ['branch', 'factory/004-live-job']);
    await client.next((e) => client.seen.indexOf(e) >= from && e.event === 'board');
    await quiet(client, calls);
    expect(calls.slice(mark).length).toBeGreaterThan(0);
    expect(calls.slice(mark).map((c) => c.args[0])).toEqual(calls.slice(mark).map(() => 'rev-parse'));

    // The archive tip moving: exactly one ls-tree and one cat-file --batch.
    mark = calls.length;
    from = client.seen.length;
    await archiveJobs(root, stage, ['003-third-job']);
    await rm(join(root, 'factory', 'jobs', '003-third-job'), { recursive: true });
    await rm(join(root, 'factory', 'jobs', '002-second-job'), { recursive: true });
    await client.next((e) => client.seen.indexOf(e) >= from && e.event === 'board' && idsOf(e.data).includes('003-third-job') && idsOf(e.data).includes('002-second-job'));
    await quiet(client, calls);
    const moved = calls.slice(mark);
    expect(count('ls-tree', moved)).toBe(1);
    expect(count('cat-file', moved)).toBe(1);

    // Every invocation: read-only, a fixed argv, run in the project root.
    const tips = new Set(calls.filter((c) => c.args[0] === 'ls-tree').map((c) => c.args[4]));
    for (const c of calls) {
      expect(c.cwd).toBe(root);
      const fixed = [
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        ['rev-parse', '--verify', '--quiet', 'refs/heads/factory/archive^{commit}'],
        ['cat-file', '--batch'],
      ];
      const ok = fixed.some((f) => JSON.stringify(f) === JSON.stringify(c.args)) || (c.args.length === 5 && JSON.stringify(c.args.slice(0, 4)) === JSON.stringify(['ls-tree', '-r', '-z', '--full-tree']) && /^[0-9a-f]{40}$/.test(c.args[4] ?? ''));
      expect({ args: c.args, ok }).toEqual({ args: c.args, ok: true });
    }
    expect(tips.size).toBe(2);
    expect(count('rev-parse', calls.filter((c) => c.args[1] === '--path-format=absolute'))).toBe(1); // the common dir, once
    client.close();
  });

  test('AC7: no archive branch, or no git repo: responses as before, nothing logged', async () => {
    const repo = await makeRepoProject('repo', ['001-first-job']);
    const plain = await makeProject('plain', ['001-first-job']);
    await addRoot(registry, repo);
    await addRoot(registry, plain);
    const calls: GitCall[] = [];
    const { url } = await startWith(recording(calls));
    const client = await connect(url);
    await client.next((e) => e.event === 'projects');
    for (const root of [repo, plain]) {
      const board = await getJson(`${url}/projects/${projectId(root)}/board`);
      expect(board.status).toBe(200);
      expect(board.body).toEqual({ jobs: [await readJson(join(root, 'factory', 'jobs', '001-first-job', 'job.json'))], config: parseConfig(CONFIG), epics: [] });
      expect((await getJson(`${url}/projects/${projectId(root)}/jobs/001-first-job/docs`)).body).toEqual({ files: [] });
      expect((await getJson(`${url}/projects/${projectId(root)}/jobs/002-not-there/docs`)).body).toEqual({ files: [] });
    }
    await quiet(client, calls);
    const from = client.seen.length;
    await appendEvent(join(plain, 'factory'), '001-first-job', parseEventInput('stage.entered', { stage: 'spec' }));
    const ev = await client.next((e) => client.seen.indexOf(e) >= from && e.event === 'board' && field(e.data, 'project') === projectId(plain));
    expect(stagesOf(ev.data)).toEqual(['spec']);
    expect(logs).toEqual([]);
    expect(calls.filter((c) => c.cwd === plain).map((c) => c.args)).toEqual([['rev-parse', '--path-format=absolute', '--git-common-dir']]);
    expect(calls.some((c) => c.args[0] === 'ls-tree' || c.args[0] === 'cat-file')).toBe(false);
    client.close();
  });
});

// --- Jobs removed by `factory prune` (job 048) ---

// The source CLI's process entry; it finds the factory at `<cwd>/factory`.
const CLI_MAIN = join(import.meta.dir, '..', '..', 'cli', 'src', 'main.ts');

async function factoryCli(root: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const env = testEnv({ ANDON_HOME: join(tmp, 'andon-home') });
  const p = Bun.spawn([process.execPath, CLI_MAIN, ...args], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

describe('pruned jobs (job 048)', () => {
  test('AC5: a job removed by prune is still on the board, projected from its archived events.jsonl, and its id is not reused', async () => {
    const root = await makeRepoProject('alpha', ['001-live-job', '002-pruned-job']);
    gitFx(root, ['config', 'user.name', 'andon-test']);
    gitFx(root, ['config', 'user.email', 'test@example.invalid']);
    gitFx(root, ['config', 'commit.gpgsign', 'false']);
    const factory = join(root, 'factory');
    await writeFile(join(factory, 'config.json'), JSON.stringify({ ...CONFIG, archive: { enabled: true } }));
    await fleshOut(root, '002-pruned-job');
    await appendEvent(factory, '002-pruned-job', parseEventInput('job.abandoned', { reason: 'not needed' }), undefined, { force: true });
    const local = await readJson(join(factory, 'jobs', '002-pruned-job', 'job.json'));
    expect(field(local, 'stage')).toBe('abandoned');

    expect((await factoryCli(root, ['archive', '--all'])).code).toBe(0);
    const pruned = await factoryCli(root, ['prune']);
    expect(pruned).toEqual({
      code: 0,
      out: 'kept 001-live-job: not merged or abandoned (claimed)\npruned 002-pruned-job\nprune: removed 1, kept 1, failed 0\n',
      err: '',
    });
    expect(await Bun.file(join(factory, 'jobs', '002-pruned-job', 'events.jsonl')).exists()).toBe(false);

    await addRoot(registry, root);
    const { url } = await start();
    const pid = projectId(root);
    const board = await getJson(`${url}/projects/${pid}/board`);
    expect(idsOf(board.body)).toEqual(['001-live-job', '002-pruned-job']);
    // Served from the archive (the dir is gone), as the CLI projected it before the prune.
    expect(jobOf(board.body, '002-pruned-job')).toEqual(local);
    const docs = field((await getJson(`${url}/projects/${pid}/jobs/002-pruned-job/docs`)).body, 'files');
    expect(Array.isArray(docs) ? docs.map((f) => field(f, 'path')) : null).toContain('jobs/002-pruned-job/spec.md');

    // The next claim's number is above the pruned id.
    expect(await factoryCli(root, ['claim', 'after-prune'])).toEqual({ code: 0, out: '003-after-prune\n', err: '' });
  });
});
