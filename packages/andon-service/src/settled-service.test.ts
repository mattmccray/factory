// Settled jobs on demand (job 049): the `?settled=summary` narrow board and event, the settle
// timer, and `GET /projects/<pid>/settled`.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRoot, parseConfig, registryPath } from '@factory/contract';
import { projectId, startService } from './index';
import type { Service, SettleTimers } from './index';

const CONFIG = { schema: 'factory/v1', reviewers: ['security', 'code'], maxRound: 2, dashboard: { settleAfterHours: 24 } };
const H = 3_600_000;

let tmp: string;
let registry: string;
let service: Service | null;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'andon-settled-')));
  registry = registryPath(join(tmp, 'andon'));
  service = null;
});
afterEach(async () => {
  await service?.stop();
  await rm(tmp, { recursive: true, force: true });
});

const start = async (settleTimers?: SettleTimers): Promise<Service> => {
  service = await startService({ port: 0, registryPath: registry, log: () => undefined, ...(settleTimers === undefined ? {} : { settleTimers }) });
  return service;
};
const writeAt = async (path: string, text: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number): string => new Date(ms).toISOString();
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const field = (v: unknown, k: string): unknown => (isRec(v) ? v[k] : undefined);
const jobsOf = (body: unknown): unknown[] => {
  const jobs = field(body, 'jobs');
  return Array.isArray(jobs) ? jobs : [];
};
const idsOf = (body: unknown): unknown[] => jobsOf(body).map((j) => field(j, 'id'));

// A legacy-style job: its job.json only (the board reads it as is, unknown fields included).
const job = (id: string, stage: string, endedAt: string | null): Record<string, unknown> => ({
  schema: 'factory/v1', id, title: id, stage, round: 1, endedAt, extra: { kept: id },
});
const writeJob = (root: string, j: Record<string, unknown>): Promise<void> => writeAt(join(root, 'factory', 'jobs', String(j.id), 'job.json'), JSON.stringify(j));

async function makeProject(name: string, config: Record<string, unknown> = CONFIG): Promise<string> {
  const root = join(tmp, name);
  await writeAt(join(root, 'factory', 'config.json'), JSON.stringify(config));
  await mkdir(join(root, 'factory', 'jobs'), { recursive: true });
  return root;
}

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_')) env[k] = v;
  return env;
}
function git(cwd: string, args: string[], stdin?: string): string {
  const p = Bun.spawnSync(['git', '-c', 'user.name=andon-test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: gitEnv(),
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString().trim();
}

// Makes `root` a git repo whose `factory/archive` branch holds each job as a legacy `<id>/job.json`.
function archiveOnly(root: string, jobs: Array<Record<string, unknown>>): void {
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['commit', '--quiet', '--allow-empty', '-m', 'init']);
  const entries = jobs.map((j) => {
    const blob = git(root, ['hash-object', '-w', '--stdin'], JSON.stringify(j));
    const tree = git(root, ['mktree'], `100644 blob ${blob}\tjob.json\n`);
    return `040000 tree ${tree}\t${String(j.id)}\n`;
  });
  const top = git(root, ['mktree'], entries.join(''));
  const commit = git(root, ['commit-tree', top, '-m', 'archive']);
  git(root, ['update-ref', 'refs/heads/factory/archive', commit]);
}

interface Sse {
  event: string;
  data: unknown;
}

// An event-stream client on `/events<query>` that collects frames.
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

// Waits until no event has arrived on any client for `ms` (late fs events from the fixture setup).
async function quiet(clients: Array<{ seen: Sse[] }>, ms = 300): Promise<void> {
  let n = -1;
  const count = (): number => clients.reduce((s, c) => s + c.seen.length, 0);
  for (let i = 0; i < 20 && n !== count(); i++) {
    n = count();
    await sleep(ms);
  }
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(20);
  }
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

// The AC2 project: every kind of job, one of them found only on `factory/archive`.
async function mixedProject(): Promise<{ root: string; now: number; old: Record<string, unknown>; archived: Record<string, unknown> }> {
  const root = await makeProject('alpha');
  const now = Date.now();
  const old = job('001-old-merged', 'merged', iso(now - 72 * H));
  const archived = job('002-archived-old', 'merged', iso(now - 30 * H));
  archiveOnly(root, [archived]);
  for (const j of [
    old,
    job('003-recent-merged', 'merged', iso(now - 1 * H)),
    job('004-no-end', 'merged', null),
    job('005-abandoned', 'abandoned', iso(now - 1000)),
    job('006-working', 'build', null),
    job('007-needs-human', 'needs-human', null),
  ]) await writeJob(root, j);
  return { root, now, old, archived };
}

describe('the plain board is unchanged (AC1)', () => {
  test('no parameter, or any value but `summary`, is byte-for-byte the plain board', async () => {
    const { root } = await mixedProject();
    await addRoot(registry, root);
    const { url } = await start();
    const board = `${url}/projects/${projectId(root)}/board`;
    const plain = await get(board);
    expect(plain.status).toBe(200);
    expect(Object.keys(isRec(plain.body) ? plain.body : {}).sort()).toEqual(['config', 'jobs']);
    expect(idsOf(plain.body)).toEqual(['001-old-merged', '002-archived-old', '003-recent-merged', '004-no-end', '005-abandoned', '006-working', '007-needs-human']);
    for (const q of ['?settled=', '?settled=Summary', '?settled=summary%20', '?settled=all', '?other=summary']) {
      const r = await get(`${board}${q}`);
      expect({ q, status: r.status, text: r.text }).toEqual({ q, status: 200, text: plain.text });
    }
  });

  test('a plain /events client (no parameter or another value) gets the full { project, jobs, config }', async () => {
    const { root } = await mixedProject();
    await addRoot(registry, root);
    const { url } = await start();
    const a = await connect(url);
    const b = await connect(url, '?settled=full');
    await a.next((e) => e.event === 'projects');
    await b.next((e) => e.event === 'projects');
    await quiet([a, b]);
    const fromA = a.seen.length;
    const fromB = b.seen.length;
    await writeJob(root, job('006-working', 'review', null));
    const isReview = (e: Sse): boolean => e.event === 'board' && jobsOf(e.data).some((j) => field(j, 'stage') === 'review');
    for (const [c, from] of [[a, fromA], [b, fromB]] as const) {
      const ev = await c.next(isReview, from);
      expect(Object.keys(isRec(ev.data) ? ev.data : {})).toEqual(['project', 'jobs', 'config']);
      expect(idsOf(ev.data)).toHaveLength(7);
    }
    a.close();
    b.close();
  });
});

describe('the narrow board (AC2)', () => {
  test('?settled=summary keeps unsettled jobs in id order and summarizes the settled ones', async () => {
    const { root, archived } = await mixedProject();
    await addRoot(registry, root);
    const { url } = await start();
    const pid = projectId(root);
    const plain = await get(`${url}/projects/${pid}/board`);
    const narrow = await get(`${url}/projects/${pid}/board?settled=summary`);
    expect(narrow.status).toBe(200);
    expect(narrow.cache).toBe('no-store');
    expect(Object.keys(isRec(narrow.body) ? narrow.body : {})).toEqual(['jobs', 'config', 'settled']);
    expect(idsOf(narrow.body)).toEqual(['003-recent-merged', '004-no-end', '006-working', '007-needs-human']);
    expect(field(narrow.body, 'config')).toEqual(field(plain.body, 'config'));
    // Same entries as on the plain board, unknown fields included.
    for (const j of jobsOf(narrow.body)) expect(jobsOf(plain.body)).toContainEqual(j);
    expect(field(narrow.body, 'settled')).toEqual({ count: 3, lastMergedAt: archived.endedAt });
  });

  test('no settled jobs is { count: 0, lastMergedAt: null }; only abandoned ones leave lastMergedAt null', async () => {
    const root = await makeProject('alpha');
    await writeJob(root, job('001-working', 'build', null));
    await writeJob(root, job('002-recent', 'merged', iso(Date.now() - H)));
    await addRoot(registry, root);
    const { url } = await start();
    const board = `${url}/projects/${projectId(root)}/board?settled=summary`;
    expect(field((await get(board)).body, 'settled')).toEqual({ count: 0, lastMergedAt: null });
    await writeJob(root, job('003-gone', 'abandoned', iso(Date.now())));
    await writeJob(root, job('004-gone-too', 'abandoned', iso(Date.now())));
    const r = await get(board);
    expect(idsOf(r.body)).toEqual(['001-working', '002-recent']);
    expect(field(r.body, 'settled')).toEqual({ count: 2, lastMergedAt: null });
  });

  test('a bad config.json is a 500 config.json: <reason> on the narrow board too', async () => {
    const root = await makeProject('alpha', { ...CONFIG, extra: true });
    await addRoot(registry, root);
    const { url } = await start();
    const r = await get(`${url}/projects/${projectId(root)}/board?settled=summary`);
    expect(r.status).toBe(500);
    expect(r.text).toStartWith('config.json: ');
  });
});

describe('narrow and plain clients at once (AC3)', () => {
  test('a job change sends each client its own form; a bad config sends both the same error', async () => {
    const { root, archived } = await mixedProject();
    await addRoot(registry, root);
    const { url } = await start();
    const pid = projectId(root);
    const narrow = await connect(url, '?settled=summary');
    const plain = await connect(url);
    await narrow.next((e) => e.event === 'projects');
    await plain.next((e) => e.event === 'projects');
    await quiet([narrow, plain]);
    const fromN = narrow.seen.length;
    const fromP = plain.seen.length;

    await writeJob(root, job('006-working', 'review', null));
    const isReview = (e: Sse): boolean => e.event === 'board' && jobsOf(e.data).some((j) => field(j, 'stage') === 'review');
    const n = await narrow.next(isReview, fromN);
    expect(Object.keys(isRec(n.data) ? n.data : {})).toEqual(['project', 'jobs', 'config', 'settled']);
    expect(field(n.data, 'project')).toBe(pid);
    expect(idsOf(n.data)).toEqual(['003-recent-merged', '004-no-end', '006-working', '007-needs-human']);
    expect(field(n.data, 'config')).toEqual(parseConfig(CONFIG));
    expect(field(n.data, 'settled')).toEqual({ count: 3, lastMergedAt: archived.endedAt });
    const p = await plain.next(isReview, fromP);
    expect(Object.keys(isRec(p.data) ? p.data : {})).toEqual(['project', 'jobs', 'config']);
    expect(idsOf(p.data)).toEqual(['001-old-merged', '002-archived-old', '003-recent-merged', '004-no-end', '005-abandoned', '006-working', '007-needs-human']);
    // Every narrow event is narrow, every plain event plain.
    expect(narrow.seen.filter((e) => e.event === 'board').every((e) => isRec(e.data) && 'settled' in e.data)).toBe(true);
    expect(plain.seen.filter((e) => e.event === 'board').every((e) => isRec(e.data) && !('settled' in e.data))).toBe(true);

    await quiet([narrow, plain]);
    const errN = narrow.seen.length;
    const errP = plain.seen.length;
    await writeFile(join(root, 'factory', 'config.json'), '{"schema": "factory/v1", "nope": 1}');
    const en = await narrow.next((e) => e.event === 'error', errN);
    const ep = await plain.next((e) => e.event === 'error', errP);
    expect(en.data).toEqual(ep.data);
    expect(field(en.data, 'project')).toBe(pid);
    expect(String(field(en.data, 'reason'))).toStartWith('config.json: ');
    narrow.close();
    plain.close();
  });
});

describe('the settle timer (AC4, AC5)', () => {
  test('a merged job crossing settleAfterHours with no file change sends narrow clients a board event; a settleAfterHours edit re-arms it', async () => {
    const hours = 0.001; // 3.6 s
    const root = await makeProject('alpha', { ...CONFIG, dashboard: { settleAfterHours: hours } });
    const old = job('001-old', 'merged', iso(Date.now() - H));
    const ended = Date.now() - hours * H + 3000; // crosses about 3 s from now
    const crossing = job('002-crossing', 'merged', iso(ended));
    await writeJob(root, old);
    await writeJob(root, crossing);
    await writeJob(root, job('003-working', 'build', null));
    await addRoot(registry, root);
    const { url } = await start();
    const narrow = await connect(url, '?settled=summary');
    const plain = await connect(url);
    await narrow.next((e) => e.event === 'projects');
    await plain.next((e) => e.event === 'projects');
    const before = await get(`${url}/projects/${projectId(root)}/board?settled=summary`);
    expect(idsOf(before.body)).toEqual(['002-crossing', '003-working']);
    expect(field(before.body, 'settled')).toEqual({ count: 1, lastMergedAt: old.endedAt });
    // Late fs events from the fixture setup may still yield board events: only what follows counts.
    await quiet([narrow, plain], 200);
    expect(Date.now()).toBeLessThan(ended + hours * H);
    const fromP = plain.seen.length;

    const gone = (e: Sse): boolean => e.event === 'board' && !idsOf(e.data).includes('002-crossing');
    const ev = await narrow.next(gone, 0, 4000);
    const lag = Date.now() - (ended + hours * H);
    expect(lag).toBeGreaterThanOrEqual(0);
    expect(lag).toBeLessThan(2000);
    expect(idsOf(ev.data)).toEqual(['003-working']);
    expect(field(ev.data, 'settled')).toEqual({ count: 2, lastMergedAt: crossing.endedAt });
    await sleep(300);
    expect(plain.seen.slice(fromP).filter((e) => e.event === 'board')).toEqual([]);

    // Raise settleAfterHours so the job is unsettled again and crosses about 1.5 s later: the
    // config.json rebuild re-arms the timer for the new crossing.
    await quiet([narrow, plain]);
    const hours2 = (Date.now() - ended + 1500) / H;
    const fromN2 = narrow.seen.length;
    await writeFile(join(root, 'factory', 'config.json'), JSON.stringify({ ...CONFIG, dashboard: { settleAfterHours: hours2 } }));
    const back = await narrow.next((e) => e.event === 'board' && idsOf(e.data).includes('002-crossing'), fromN2);
    expect(field(back.data, 'settled')).toEqual({ count: 1, lastMergedAt: old.endedAt });
    await quiet([plain], 150);
    const fromP2 = plain.seen.length;
    const again = await narrow.next(gone, narrow.seen.indexOf(back) + 1, 4000);
    expect(Date.now() - (ended + hours2 * H)).toBeLessThan(2000);
    expect(field(again.data, 'settled')).toEqual({ count: 2, lastMergedAt: crossing.endedAt });
    await sleep(300);
    expect(plain.seen.slice(fromP2).filter((e) => e.event === 'board')).toEqual([]);
    narrow.close();
    plain.close();
  }, 20_000);

  test('no timer is armed without a narrow client; the last narrow client leaving and stop() clear it', async () => {
    const pending = new Set<ReturnType<typeof setTimeout>>();
    let armed = 0;
    const timers: SettleTimers = {
      set: (fn, ms) => {
        armed++;
        const t = setTimeout(() => {
          pending.delete(t);
          fn();
        }, ms);
        pending.add(t);
        return t;
      },
      clear: (t) => {
        clearTimeout(t);
        pending.delete(t);
      },
    };
    const root = await makeProject('alpha');
    await writeJob(root, job('001-recent', 'merged', iso(Date.now() - H)));
    await addRoot(registry, root);
    const svc = await start(timers);

    // A plain client and a job change: the board is rebuilt, but no settle timer is armed.
    const plain = await connect(svc.url);
    await plain.next((e) => e.event === 'projects');
    await quiet([plain]);
    const from = plain.seen.length;
    await writeJob(root, job('002-working', 'build', null));
    await plain.next((e) => e.event === 'board', from);
    await sleep(100);
    expect(armed).toBe(0);
    expect(pending.size).toBe(0);

    // The first narrow client arms it; the second shares it; both leaving clears it.
    const n1 = await connect(svc.url, '?settled=summary');
    await until(() => pending.size === 1);
    const n2 = await connect(svc.url, '?settled=summary');
    await n2.next((e) => e.event === 'projects');
    await sleep(100);
    expect(pending.size).toBe(1);
    n1.close();
    await sleep(100);
    expect(pending.size).toBe(1);
    n2.close();
    await until(() => pending.size === 0);

    // A job change after the last narrow client left arms nothing.
    const armedBefore = armed;
    await quiet([plain]);
    const from2 = plain.seen.length;
    await writeJob(root, job('003-recent-too', 'merged', iso(Date.now() - H)));
    await plain.next((e) => e.event === 'board', from2);
    await sleep(100);
    expect(armed).toBe(armedBefore);
    expect(pending.size).toBe(0);

    // Armed again, then stop() leaves nothing pending.
    const n3 = await connect(svc.url, '?settled=summary');
    await until(() => pending.size === 1);
    plain.close();
    n3.close();
    await svc.stop();
    service = null;
    expect(pending.size).toBe(0);
  }, 20_000);
});

describe('GET /projects/<pid>/settled (AC6)', () => {
  test('returns exactly the jobs the narrow board left out, in id order and the plain board\'s shape', async () => {
    const { root, old, archived } = await mixedProject();
    await addRoot(registry, root);
    const { url } = await start();
    const pid = projectId(root);
    const plain = await get(`${url}/projects/${pid}/board`);
    const narrow = await get(`${url}/projects/${pid}/board?settled=summary`);
    const settled = await get(`${url}/projects/${pid}/settled`);
    expect(settled.status).toBe(200);
    expect(settled.cache).toBe('no-store');
    expect(Object.keys(isRec(settled.body) ? settled.body : {})).toEqual(['jobs']);
    expect(idsOf(settled.body)).toEqual(['001-old-merged', '002-archived-old', '005-abandoned']);
    // A partition of the plain board, entry for entry.
    const plainIds = idsOf(plain.body);
    const union = [...jobsOf(narrow.body), ...jobsOf(settled.body)].sort((a, b) => plainIds.indexOf(field(a, 'id')) - plainIds.indexOf(field(b, 'id')));
    expect(union).toEqual(jobsOf(plain.body));
    expect(jobsOf(settled.body)[0]).toEqual(old);
    expect(jobsOf(settled.body)[1]).toEqual(archived);

    // A job.json that turns unreadable keeps its last good snapshot here too.
    await writeFile(join(root, 'factory', 'jobs', '001-old-merged', 'job.json'), '{"id": "001-ol');
    expect(jobsOf((await get(`${url}/projects/${pid}/settled`)).body)[0]).toEqual(old);
  });

  test('errors and guards: a bad config is a 500, an unknown pid a 404, a non-GET a 405, a foreign Host or Origin a 403', async () => {
    const root = await makeProject('alpha', { ...CONFIG, extra: true });
    await addRoot(registry, root);
    const { url } = await start();
    const path = `${url}/projects/${projectId(root)}/settled`;
    const bad = await get(path);
    expect(bad.status).toBe(500);
    expect(bad.text).toStartWith('config.json: ');
    expect(bad.text).toContain('extra');
    expect(bad.cache).toBe('no-store');
    expect((await get(`${url}/projects/000000000000/settled`)).status).toBe(404);
    expect((await get(path, { method: 'POST' })).status).toBe(405);
    const port = new URL(url).port;
    const foreign: Array<Record<string, string>> = [{ host: 'evil.example' }, { host: `127.0.0.1:${port}`, origin: 'http://evil.example' }];
    for (const headers of foreign) {
      expect((await get(path, { headers })).status).toBe(403);
      expect((await get(`${url}/projects/${projectId(root)}/board?settled=summary`, { headers })).status).toBe(403);
    }
    const ev = await fetch(`${url}/events?settled=summary`, { headers: { host: 'evil.example' } });
    expect(ev.status).toBe(403);
    await ev.body?.cancel();
  });
});
