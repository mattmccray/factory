// The backlog in the Andon service (job 066): `GET /projects/<pid>/backlog`, the narrow board's
// `backlog` counts, the brief and plan endpoints and their guards, the `backlog` event and the
// `factory/briefs/` watch, and that the service writes nothing.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRoot, registryPath } from '@factory/contract';
import { projectId, startService } from './index';
import type { Service } from './index';

const CONFIG = { schema: 'factory/v1', reviewers: ['security', 'code'], maxRound: 2, dashboard: { settleAfterHours: 24 } };

let tmp: string;
let registry: string;
let service: Service | null;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'andon-backlog-')));
  registry = registryPath(join(tmp, 'andon'));
  service = null;
});
afterEach(async () => {
  await service?.stop();
  await rm(tmp, { recursive: true, force: true });
});

const start = async (debounceMs = 50): Promise<Service> => {
  service = await startService({ port: 0, registryPath: registry, log: () => undefined, debounceMs });
  return service;
};
const writeAt = async (path: string, text: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const field = (v: unknown, k: string): unknown => (isRec(v) ? v[k] : undefined);
const list = (v: unknown, k: string): unknown[] => {
  const x = field(v, k);
  return Array.isArray(x) ? x : [];
};

const BACKLOG = [
  '# Backlog',
  '',
  '- [x] Shipped — done — brief: factory/briefs/shipped.md → 001-shipped',
  '- [ ] Pointed draft — it is done — brief: factory/briefs/pointed-draft.md',
  '- [ ] The epic — it lands — epic: factory/epics/ready-plan.md',
  '- [ ] Free text — what done looks like',
  '- [ ] No separator',
  '- [ ] Bad pointer — x — brief: factory/briefs/Nope.md',
  '- [ ] Unknown key — x — idea: factory/briefs/pointed-draft.md',
  '',
].join('\n');
const doc = (title: string, status: string | null, extra = ''): string => `# ${title}\n\n${status === null ? '' : `- Status: ${status}\n`}${extra}`;
const PLAN_READY = doc('Ready plan', 'ready', '- Abandoned: 2026-10-01: first try\n\n## Members\n- `one`\n- `two`\n');
const PLAN_DRAFT = doc('Draft plan', 'draft', '\n## Members\n- `x`\n');

async function makeProject(name: string): Promise<string> {
  const root = join(tmp, name);
  const f = join(root, 'factory');
  await writeAt(join(f, 'config.json'), JSON.stringify(CONFIG));
  await mkdir(join(f, 'jobs'), { recursive: true });
  return root;
}

// The AC2 fixture: open, ticked, brief, epic, free-text, and malformed lines; draft, ready, and
// done briefs (one draft pointed at); draft and ready plans.
async function fixture(name = 'alpha'): Promise<string> {
  const root = await makeProject(name);
  const f = join(root, 'factory');
  await writeAt(join(f, 'backlog.md'), BACKLOG);
  await writeAt(join(f, 'briefs', 'shipped.md'), doc('Shipped', 'done'));
  await writeAt(join(f, 'briefs', 'pointed-draft.md'), doc('Pointed draft', 'draft', '- Abandoned: 2026-10-02: stalled\n'));
  await writeAt(join(f, 'briefs', 'a-draft.md'), doc('A draft', 'draft'));
  await writeAt(join(f, 'briefs', 'z-draft.md'), doc('Z draft', 'draft'));
  await writeAt(join(f, 'briefs', 'ready-brief.md'), doc('Ready brief', 'ready'));
  await writeAt(join(f, 'briefs', 'done-brief.md'), doc('Done brief', 'done'));
  await writeAt(join(f, 'briefs', 'no-status.md'), doc('No status', null));
  await writeAt(join(f, 'epics', 'ready-plan.md'), PLAN_READY);
  await writeAt(join(f, 'epics', 'draft-plan.md'), PLAN_DRAFT);
  return root;
}

const get = async (url: string, init?: RequestInit): Promise<{ status: number; text: string; body: unknown; cache: string | null }> => {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // plain text
  }
  return { status: res.status, text, body, cache: res.headers.get('cache-control') };
};

interface Sse {
  event: string;
  data: unknown;
}
async function connect(url: string, query = ''): Promise<{ seen: Sse[]; next: (match: (e: Sse) => boolean, from?: number, ms?: number) => Promise<Sse>; close: () => void }> {
  const ctl = new AbortController();
  const res = await fetch(`${url}/events${query}`, { signal: ctl.signal });
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
  const next = async (match: (e: Sse) => boolean, from = 0, ms = 3000): Promise<Sse> => {
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
async function quiet(clients: Array<{ seen: Sse[] }>, ms = 400): Promise<void> {
  let n = -1;
  const count = (): number => clients.reduce((s, c) => s + c.seen.length, 0);
  for (let i = 0; i < 20 && n !== count(); i++) {
    n = count();
    await sleep(ms);
  }
}

// Every entry under `dir`: its relative path, type, content hash (or link target), and mtime.
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    for (const name of (await readdir(join(dir, rel))).sort()) {
      const path = rel === '' ? name : `${rel}/${name}`;
      const full = join(dir, path);
      const info = await lstat(full);
      if (info.isSymbolicLink()) out[path] = `link ${await readlink(full)} ${info.mtimeMs}`;
      else if (info.isDirectory()) {
        out[path] = `dir ${info.mtimeMs}`;
        await walk(path);
      } else out[path] = `file ${createHash('sha256').update(await readFile(full)).digest('hex')} ${info.mtimeMs}`;
    }
  };
  await walk('');
  return out;
}

describe('GET /projects/<pid>/backlog (AC2)', () => {
  test('queued is the open lines in file order; exploring is the unreferenced draft briefs and plans', async () => {
    const root = await fixture();
    await addRoot(registry, root);
    const { url } = await start();
    const r = await get(`${url}/projects/${projectId(root)}/backlog`);
    expect(r.status).toBe(200);
    expect(r.cache).toBe('no-store');
    expect(r.body).toEqual({
      queued: [
        { kind: 'brief', slug: 'pointed-draft', title: 'Pointed draft', done: 'it is done', status: 'draft', members: null, abandoned: ['2026-10-02: stalled'] },
        { kind: 'epic', slug: 'ready-plan', title: 'The epic', done: 'it lands', status: 'ready', members: 2, abandoned: ['2026-10-01: first try'] },
        { kind: 'text', slug: null, title: 'Free text', done: 'what done looks like', status: null, members: null, abandoned: [] },
        { kind: 'text', slug: null, title: 'No separator', done: null, status: null, members: null, abandoned: [] },
        { kind: 'text', slug: null, title: 'Bad pointer', done: 'x — brief: factory/briefs/Nope.md', status: null, members: null, abandoned: [] },
        { kind: 'text', slug: null, title: 'Unknown key', done: 'x — idea: factory/briefs/pointed-draft.md', status: null, members: null, abandoned: [] },
      ],
      exploring: [
        { kind: 'brief', slug: 'a-draft', title: 'A draft', done: null, status: 'draft', members: null, abandoned: [] },
        { kind: 'brief', slug: 'z-draft', title: 'Z draft', done: null, status: 'draft', members: null, abandoned: [] },
        { kind: 'epic', slug: 'draft-plan', title: 'Draft plan', done: null, status: 'draft', members: 1, abandoned: [] },
      ],
    });
  });

  test('an unknown pid is a 404; a project with no backlog.md, briefs/, or epics/ is empty', async () => {
    const root = await makeProject('empty');
    await addRoot(registry, root);
    const { url } = await start();
    expect((await get(`${url}/projects/000000000000/backlog`)).status).toBe(404);
    const r = await get(`${url}/projects/${projectId(root)}/backlog`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ queued: [], exploring: [] });
  });

  test('a symlinked backlog.md, brief, or plan is not read', async () => {
    const root = await makeProject('links');
    const f = join(root, 'factory');
    await writeAt(join(tmp, 'outside', 'backlog.md'), '- [ ] SECRET — x\n');
    await writeAt(join(tmp, 'outside', 'draft.md'), doc('SECRET', 'draft'));
    await symlink(join(tmp, 'outside', 'backlog.md'), join(f, 'backlog.md'));
    await mkdir(join(f, 'briefs'));
    await symlink(join(tmp, 'outside', 'draft.md'), join(f, 'briefs', 'linked.md'));
    await addRoot(registry, root);
    const { url } = await start();
    const r = await get(`${url}/projects/${projectId(root)}/backlog`);
    expect(r.body).toEqual({ queued: [], exploring: [] });
    expect(r.text).not.toContain('SECRET');
  });
});

describe('the narrow board carries backlog counts (AC3)', () => {
  test('the endpoint and the narrow event carry counts; the plain board, event, and /settled do not', async () => {
    const root = await fixture();
    await addRoot(registry, root);
    const { url } = await start();
    const pid = projectId(root);
    const base = `${url}/projects/${pid}`;
    const bl = (await get(`${base}/backlog`)).body;
    const counts = { queued: list(bl, 'queued').length, exploring: list(bl, 'exploring').length };
    expect(counts).toEqual({ queued: 6, exploring: 3 });

    const narrow = (await get(`${base}/board?settled=summary`)).body;
    expect(Object.keys(isRec(narrow) ? narrow : {})).toEqual(['jobs', 'config', 'settled', 'epics', 'backlog']);
    expect(field(narrow, 'backlog')).toEqual(counts);
    const plainBoard = (await get(`${base}/board`)).body;
    expect(Object.keys(isRec(plainBoard) ? plainBoard : {})).toEqual(['jobs', 'config', 'epics']);
    for (const q of ['', '?settled=other', '?settled=']) expect(field((await get(`${base}/board${q}`)).body, 'backlog')).toBeUndefined();
    const settled = (await get(`${base}/settled`)).body;
    expect(Object.keys(isRec(settled) ? settled : {})).toEqual(['jobs', 'epics']);

    const plainC = await connect(url);
    const narrowC = await connect(url, '?settled=summary');
    await plainC.next((x) => x.event === 'projects');
    await narrowC.next((x) => x.event === 'projects');
    await quiet([plainC, narrowC]);
    const fromP = plainC.seen.length;
    const fromN = narrowC.seen.length;
    await writeAt(join(root, 'factory', 'jobs', '001-a', 'job.json'), JSON.stringify({ schema: 'factory/v1', id: '001-a', stage: 'build', round: 0, endedAt: null }));
    const p = await plainC.next((x) => x.event === 'board', fromP);
    const n = await narrowC.next((x) => x.event === 'board', fromN);
    expect(Object.keys(isRec(p.data) ? p.data : {})).toEqual(['project', 'jobs', 'config', 'epics']);
    expect(Object.keys(isRec(n.data) ? n.data : {})).toEqual(['project', 'jobs', 'config', 'settled', 'epics', 'backlog']);
    expect(field(n.data, 'backlog')).toEqual(counts);
    plainC.close();
    narrowC.close();
  });
});

describe('GET …/briefs/<slug> and …/plans/<slug> (AC4, AC5)', () => {
  test('an existing brief and plan return { path, text } exactly', async () => {
    const root = await fixture();
    await addRoot(registry, root);
    const { url } = await start();
    const base = `${url}/projects/${projectId(root)}`;
    const b = await get(`${base}/briefs/a-draft`);
    expect(b.status).toBe(200);
    expect(b.cache).toBe('no-store');
    expect(b.body).toEqual({ path: 'briefs/a-draft.md', text: doc('A draft', 'draft') });
    const p = await get(`${base}/plans/ready-plan`);
    expect(p.status).toBe(200);
    expect(p.body).toEqual({ path: 'epics/ready-plan.md', text: PLAN_READY });
  });

  test('a missing file, a directory, and a symlink (even inside factory/) are 404s', async () => {
    const root = await fixture();
    const f = join(root, 'factory');
    await mkdir(join(f, 'briefs', 'a-dir.md'));
    await mkdir(join(f, 'epics', 'a-dir.md'));
    await symlink(join(f, 'briefs', 'a-draft.md'), join(f, 'briefs', 'inside-link.md'));
    await symlink(join(f, 'epics', 'ready-plan.md'), join(f, 'epics', 'inside-link.md'));
    await addRoot(registry, root);
    const { url } = await start();
    const base = `${url}/projects/${projectId(root)}`;
    for (const kind of ['briefs', 'plans']) {
      for (const slug of ['missing', 'a-dir', 'inside-link']) {
        const r = await get(`${base}/${kind}/${slug}`);
        expect({ kind, slug, status: r.status }).toEqual({ kind, slug, status: 404 });
        expect(r.cache).toBe('no-store');
      }
    }
    expect((await get(`${url}/projects/000000000000/briefs/a-draft`)).status).toBe(404);
  });

  test('a bad slug is a 404 and reads nothing; the guards apply to every new endpoint', async () => {
    const root = await fixture();
    // A sentinel reachable by each escape: tmp/<…>.md beside the project, and factory/../secret.md.
    await writeAt(join(tmp, 'secret.md'), 'SENTINEL');
    await writeAt(join(root, 'secret.md'), 'SENTINEL');
    await writeAt(join(root, 'factory', 'secret.md'), 'SENTINEL');
    await addRoot(registry, root);
    const { url } = await start();
    const base = `${url}/projects/${projectId(root)}`;
    const bad = ['..', '%2e%2e', '%2E%2E', '..%2fsecret', '..%2F..%2Fsecret', 'a%2Fb', '%2e%2e%2fsecret', 'A-DRAFT', 'Ready-plan', '', '-a', 'a-', 'a--draft', '-', 'a_draft', 'a.md', '%00', 'a%20b'];
    for (const kind of ['briefs', 'plans']) {
      for (const slug of bad) {
        const r = await get(`${base}/${kind}/${slug}`);
        expect({ kind, slug, status: r.status }).toEqual({ kind, slug, status: 404 });
        expect(r.text).not.toContain('SENTINEL');
      }
    }

    const port = new URL(url).port;
    const foreign: Array<Record<string, string>> = [{ host: 'evil.example' }, { host: `127.0.0.1:${port}`, origin: 'http://evil.example' }];
    for (const path of ['backlog', 'briefs/a-draft', 'plans/ready-plan']) {
      const target = `${base}/${path}`;
      expect((await get(target)).cache).toBe('no-store');
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const r = await get(target, { method });
        expect({ path, method, status: r.status }).toEqual({ path, method, status: 405 });
        expect(r.cache).toBe('no-store');
      }
      for (const headers of foreign) {
        const r = await get(target, { headers });
        expect({ path, status: r.status }).toEqual({ path, status: 403 });
        expect(r.cache).toBe('no-store');
      }
    }
  });
});

describe('the backlog event and the factory/briefs/ watch (AC6)', () => {
  test('backlog.md, a brief (in a briefs/ created after startup), and a plan edit each send one backlog event and a narrow board', async () => {
    const root = await makeProject('alpha');
    await writeAt(join(root, 'factory', 'epics', 'p.md'), doc('P', 'ready', '\n## Members\n- `a`\n'));
    await addRoot(registry, root);
    const { url } = await start(150);
    const pid = projectId(root);
    const plainC = await connect(url);
    const narrowC = await connect(url, '?settled=summary');
    await plainC.next((x) => x.event === 'projects');
    await narrowC.next((x) => x.event === 'projects');
    await quiet([plainC, narrowC]);

    const backlogs = (c: { seen: Sse[] }, from: number): Sse[] => c.seen.slice(from).filter((x) => x.event === 'backlog');
    const narrowBoards = (from: number): Sse[] => narrowC.seen.slice(from).filter((x) => x.event === 'board' && field(x.data, 'project') === pid);

    // briefs/ appears after startup; this burst is not counted.
    await mkdir(join(root, 'factory', 'briefs'));
    await quiet([plainC, narrowC]);

    const steps: Array<{ name: string; edit: () => Promise<void>; counts: { queued: number; exploring: number } }> = [
      { name: 'backlog.md created', edit: () => writeFile(join(root, 'factory', 'backlog.md'), '- [ ] One — done\n'), counts: { queued: 1, exploring: 0 } },
      { name: 'backlog.md edited', edit: () => writeFile(join(root, 'factory', 'backlog.md'), '- [ ] One — done\n- [ ] Two\n'), counts: { queued: 2, exploring: 0 } },
      { name: 'brief created', edit: () => writeFile(join(root, 'factory', 'briefs', 'b.md'), doc('B', 'draft')), counts: { queued: 2, exploring: 1 } },
      { name: 'brief edited', edit: () => writeFile(join(root, 'factory', 'briefs', 'b.md'), doc('B', 'ready')), counts: { queued: 2, exploring: 0 } },
      { name: 'plan edited', edit: () => writeFile(join(root, 'factory', 'epics', 'p.md'), doc('P', 'draft', '\n## Members\n- `a`\n')), counts: { queued: 2, exploring: 1 } },
    ];
    for (const step of steps) {
      const fromP = plainC.seen.length;
      const fromN = narrowC.seen.length;
      await step.edit();
      await plainC.next((x) => x.event === 'backlog', fromP);
      await narrowC.next((x) => x.event === 'backlog', fromN);
      await narrowC.next((x) => x.event === 'board' && JSON.stringify(field(x.data, 'backlog')) === JSON.stringify(step.counts), fromN);
      await quiet([plainC, narrowC]);
      expect({ step: step.name, plain: backlogs(plainC, fromP), narrow: backlogs(narrowC, fromN) }).toEqual({
        step: step.name,
        plain: [{ event: 'backlog', data: { project: pid } }],
        narrow: [{ event: 'backlog', data: { project: pid } }],
      });
      const last = narrowBoards(fromN).at(-1);
      expect({ step: step.name, backlog: field(last?.data, 'backlog') }).toEqual({ step: step.name, backlog: step.counts });
    }

    // No poll, no periodic event: a quiet stretch sends nothing.
    const fromP = plainC.seen.length;
    const fromN = narrowC.seen.length;
    await sleep(1200);
    expect(plainC.seen.slice(fromP)).toEqual([]);
    expect(narrowC.seen.slice(fromN)).toEqual([]);
    plainC.close();
    narrowC.close();
  }, 30_000);
});

describe('the service writes nothing (AC7)', () => {
  test('every new endpoint and a watch cycle leave factory/ unchanged', async () => {
    const root = await fixture();
    await addRoot(registry, root);
    const { url } = await start();
    const pid = projectId(root);
    const base = `${url}/projects/${pid}`;
    const plainC = await connect(url);
    const narrowC = await connect(url, '?settled=summary');
    await plainC.next((x) => x.event === 'projects');
    await narrowC.next((x) => x.event === 'projects');
    await quiet([plainC, narrowC]);
    // The test's own edit starts a watch cycle; the snapshot is taken after it.
    const from = narrowC.seen.length;
    await writeFile(join(root, 'factory', 'backlog.md'), `${BACKLOG}- [ ] Added — x\n`);
    await writeFile(join(root, 'factory', 'briefs', 'a-draft.md'), doc('A draft', 'draft', 'more\n'));
    const before = await snapshot(join(root, 'factory'));
    await narrowC.next((x) => x.event === 'backlog', from);
    await narrowC.next((x) => x.event === 'board' && field(field(x.data, 'backlog'), 'queued') === 7, from);
    for (const path of ['backlog', 'board', 'board?settled=summary', 'settled', 'briefs/a-draft', 'plans/ready-plan', 'briefs/missing', 'plans/draft-plan', 'briefs/%2e%2e']) {
      await get(`${base}/${path}`);
    }
    await quiet([plainC, narrowC]);
    plainC.close();
    narrowC.close();
    await service?.stop();
    service = null;
    expect(await snapshot(join(root, 'factory'))).toEqual(before);
  });
});
