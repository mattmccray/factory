import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { connect as tcp } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { addRoot, appendEvent, parseConfig, parseEventInput, registryPath } from '@factory/contract';
import { projectId, startAgent } from './index';
import type { Agent } from './index';

const CONFIG = { schema: 'factory/v1', reviewers: ['security', 'code'], maxRound: 2, dashboard: { settleAfterHours: 24 } };

let tmp: string;
let registry: string;
let agent: Agent | null;
const logs: string[] = [];
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'andon-agent-')));
  registry = registryPath(join(tmp, 'andon'));
  agent = null;
  logs.length = 0;
});
afterEach(async () => {
  await agent?.stop();
  await rm(tmp, { recursive: true, force: true });
});

const start = async (uiDir?: string): Promise<Agent> => {
  agent = await startAgent({ port: 0, registryPath: registry, log: (l) => logs.push(l), ...(uiDir === undefined ? {} : { uiDir }) });
  return agent;
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
    for (const f of ['decision.md', 'build.md', 'spec.md', 'feature.md', 'rework-2.md', 'rework-1.md', 'notes.txt']) await writeFile(join(job, f), `# ${f}\n`);
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
    // Wait for the agent to reload and log the rejection (deadline 2 s), not a fixed delay.
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
      await agent?.stop();
      agent = null;
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
