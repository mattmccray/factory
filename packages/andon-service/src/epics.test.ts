// Epics in the Andon service (job 054): `epics` on the board, the narrow board, `/settled`, and
// `board` events; archived epics; the epic-aware settle rule and the settle timer; the epic docs
// endpoint; and the `factory/epics/` watch.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRoot, parseEpicLog, parsePlan, projectEpic, registryPath } from '@factory/contract';
import type { EpicJob } from '@factory/contract';
import { spawnGit } from './archive';
import { projectId, startService } from './index';
import type { GitRunner, Service, SettleTimers } from './index';

const CONFIG = { schema: 'factory/v1', reviewers: ['security', 'code'], maxRound: 2, dashboard: { settleAfterHours: 24 } };
const H = 3_600_000;

let tmp: string;
let registry: string;
let service: Service | null;
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'andon-epics-')));
  registry = registryPath(join(tmp, 'andon'));
  service = null;
});
afterEach(async () => {
  await service?.stop();
  await rm(tmp, { recursive: true, force: true });
});

interface StartOpts {
  timers?: SettleTimers;
  git?: GitRunner;
  log?: (line: string) => void;
}
const start = async (o: StartOpts = {}): Promise<Service> => {
  service = await startService({
    port: 0,
    registryPath: registry,
    log: o.log ?? (() => undefined),
    ...(o.timers === undefined ? {} : { settleTimers: o.timers }),
    ...(o.git === undefined ? {} : { git: o.git }),
  });
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
const list = (v: unknown, k: string): unknown[] => {
  const x = field(v, k);
  return Array.isArray(x) ? x : [];
};
const ids = (body: unknown): unknown[] => list(body, 'jobs').map((j) => field(j, 'id'));
const slugs = (body: unknown): unknown[] => list(body, 'epics').map((e) => field(e, 'slug'));

async function makeProject(name: string, config: Record<string, unknown> = CONFIG): Promise<string> {
  const root = join(tmp, name);
  await writeAt(join(root, 'factory', 'config.json'), JSON.stringify(config));
  await mkdir(join(root, 'factory', 'jobs'), { recursive: true });
  return root;
}

const job = (id: string, stage: string, endedAt: string | null, epic: string | null = null, brief: string | null = null): Record<string, unknown> => ({
  schema: 'factory/v1', id, title: id, stage, round: 1, endedAt, brief, epic, kind: epic === null ? null : 'member', updated: endedAt ?? '2026-10-29T00:00:00.000Z', extra: { kept: id },
});
const writeJob = (root: string, j: Record<string, unknown>): Promise<void> => writeAt(join(root, 'factory', 'jobs', String(j.id), 'job.json'), JSON.stringify(j));

// A local epic.json, as the CLI would store it, with an unknown field.
const epic = (slug: string, state: string, endedAt: string | null): Record<string, unknown> => ({
  schema: 'factory/v1', slug, branch: `factory/epic/${slug}`, target: 'main', plan: `factory/epics/${slug}.md`, planError: null, state, waitingOn: null, note: '', session: null, sha: null,
  members: [], generated: [], counts: { queued: 0, blocked: 0, running: 0, merged: 0, 'needs-human': 0, abandoned: 0 }, startedAt: '2026-10-01T00:00:00.000Z', endedAt, updated: endedAt ?? '2026-10-01T00:00:00.000Z',
  unknownField: { kept: slug },
});
const writeEpic = (root: string, e: Record<string, unknown>): Promise<void> => writeAt(join(root, 'factory', 'jobs', 'epics', String(e.slug), 'epic.json'), JSON.stringify(e));

const plan = (members: string[]): string => `# Plan\n\n- Status: ready\n\n## Members\n${members.map((m) => `- \`${m}\``).join('\n')}\n`;

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

// A tree of files, by path, as a git tree object id (nested trees by mktree).
type Tree = { [name: string]: string | Tree };
function mktree(root: string, tree: Tree): string {
  const lines = Object.entries(tree).map(([name, v]) => {
    if (typeof v === 'string') return `100644 blob ${git(root, ['hash-object', '-w', '--stdin'], v)}\t${name}\n`;
    return `040000 tree ${mktree(root, v)}\t${name}\n`;
  });
  return git(root, ['mktree'], lines.join(''));
}
function archive(root: string, tree: Tree): void {
  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['commit', '--quiet', '--allow-empty', '-m', 'init']);
  const commit = git(root, ['commit-tree', mktree(root, tree), '-m', 'archive']);
  git(root, ['update-ref', 'refs/heads/factory/archive', commit]);
}
const jsonl = (events: Array<Record<string, unknown>>): string => events.map((e) => `${JSON.stringify(e)}\n`).join('');
const started = (slug: string, ts = '2026-10-01T00:00:00.000Z'): Record<string, unknown> => ({ ts, type: 'epic.started', schema: 'factory/v1', slug, target: 'main' });

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
async function quiet(clients: Array<{ seen: Sse[] }>, ms = 300): Promise<void> {
  let n = -1;
  const count = (): number => clients.reduce((s, c) => s + c.seen.length, 0);
  for (let i = 0; i < 20 && n !== count(); i++) {
    n = count();
    await sleep(ms);
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

describe('epics on the board and board events (AC1)', () => {
  test('a local epic.json is passed through unchanged everywhere; a torn or missing one keeps the last good snapshot', async () => {
    const root = await makeProject('alpha');
    const e = epic('feature-x', 'running', null);
    await writeEpic(root, e);
    await writeJob(root, job('001-x-a', 'build', null, 'feature-x', 'factory/briefs/x-a.md'));
    await addRoot(registry, root);
    const { url } = await start();
    const pid = projectId(root);
    const board = `${url}/projects/${pid}/board`;

    expect(field((await get(board)).body, 'epics')).toEqual([e]);
    expect(field((await get(`${board}?settled=summary`)).body, 'epics')).toEqual([e]);

    const plain = await connect(url);
    const narrow = await connect(url, '?settled=summary');
    await plain.next((x) => x.event === 'projects');
    await narrow.next((x) => x.event === 'projects');
    await quiet([plain, narrow]);
    const fromP = plain.seen.length;
    const fromN = narrow.seen.length;
    await writeJob(root, job('001-x-a', 'review', null, 'feature-x', 'factory/briefs/x-a.md'));
    const isReview = (x: Sse): boolean => x.event === 'board' && list(x.data, 'jobs').some((j) => field(j, 'stage') === 'review');
    const p = await plain.next(isReview, fromP);
    const n = await narrow.next(isReview, fromN);
    expect(Object.keys(isRec(p.data) ? p.data : {})).toEqual(['project', 'jobs', 'config', 'epics']);
    expect(Object.keys(isRec(n.data) ? n.data : {})).toEqual(['project', 'jobs', 'config', 'settled', 'epics', 'backlog']);
    expect(field(p.data, 'epics')).toEqual([e]);
    expect(field(n.data, 'epics')).toEqual([e]);
    plain.close();
    narrow.close();

    // Mid-write, then missing: the last good snapshot is served.
    await writeFile(join(root, 'factory', 'jobs', 'epics', 'feature-x', 'epic.json'), '{"schema": "factory/v1", "sl');
    expect(field((await get(board)).body, 'epics')).toEqual([e]);
    await rm(join(root, 'factory', 'jobs', 'epics', 'feature-x', 'epic.json'));
    expect(field((await get(board)).body, 'epics')).toEqual([e]);
    // A newer good one replaces it.
    const later = { ...e, note: 'later' };
    await writeEpic(root, later);
    expect(field((await get(board)).body, 'epics')).toEqual([later]);
  });

  test('no epics: today\'s payloads plus epics: [] and a summary with epics: 0; non-slug dirs are ignored', async () => {
    const root = await makeProject('alpha');
    await writeJob(root, job('001-old', 'merged', iso(Date.now() - 48 * H)));
    await writeJob(root, job('002-new', 'build', null));
    await mkdir(join(root, 'factory', 'jobs', 'epics', '003-job-like'), { recursive: true });
    await mkdir(join(root, 'factory', 'jobs', 'epics', 'Bad_Slug'), { recursive: true });
    await addRoot(registry, root);
    const { url } = await start();
    const pid = projectId(root);
    const board = await get(`${url}/projects/${pid}/board`);
    expect(Object.keys(isRec(board.body) ? board.body : {})).toEqual(['jobs', 'config', 'epics']);
    expect(field(board.body, 'epics')).toEqual([]);
    expect(ids(board.body)).toEqual(['001-old', '002-new']);
    const narrow = await get(`${url}/projects/${pid}/board?settled=summary`);
    expect(field(narrow.body, 'epics')).toEqual([]);
    expect(field(narrow.body, 'settled')).toEqual({ count: 1, lastMergedAt: field(list(board.body, 'jobs')[0], 'endedAt'), epics: 0 });
    expect((await get(`${url}/projects/${pid}/settled`)).body).toEqual({ jobs: [list(board.body, 'jobs')[0]], epics: [] });
  });
});

type GitCall = readonly string[];
const recording = (calls: GitCall[]): GitRunner => async (args, o) => {
  calls.push([...args]);
  return spawnGit(args, o);
};

describe('archived epics (AC2)', () => {
  test('an archived-only epic is re-projected by projectEpic; a local one wins; a torn or bad log is left out and logged', async () => {
    const root = await makeProject('alpha');
    const now = Date.now();
    const memberA = job('010-arch-a', 'merged', iso(now - 50 * H), 'arch', 'factory/briefs/arch-a.md');
    const memberB = job('011-arch-b', 'build', null, 'arch', 'factory/briefs/arch-b.md');
    const archLog = jsonl([started('arch')]);
    const archPlan = plan(['arch-a', 'arch-b', 'arch-c']);
    archive(root, {
      '010-arch-a': { 'job.json': JSON.stringify(memberA) },
      epics: {
        arch: { 'events.jsonl': archLog, 'plan.md': archPlan },
        both: { 'events.jsonl': jsonl([started('both')]), 'plan.md': plan(['x']) },
        torn: { 'events.jsonl': `${jsonl([started('torn')])}{"ts":"2026-10-02T00:00:00.000Z","ty`, 'plan.md': plan(['x']) },
        'no-start': { 'events.jsonl': jsonl([{ ts: '2026-10-01T00:00:00.000Z', type: 'epic.waiting', reason: 'x' }]), 'plan.md': plan(['x']) },
        landed: { 'events.jsonl': jsonl([started('landed'), { ts: iso(now - 30 * H), type: 'epic.landed', sha: 'a'.repeat(40) }]), 'plan.md': plan(['y']) },
      },
    });
    // A member still running locally: the board holds it from factory/jobs/.
    await writeJob(root, memberB);
    const localBoth = epic('both', 'running', null);
    await writeEpic(root, localBoth);
    await addRoot(registry, root);
    const calls: GitCall[] = [];
    const logs: string[] = [];
    const { url } = await start({ git: recording(calls), log: (l) => logs.push(l) });
    const pid = projectId(root);

    const board = await get(`${url}/projects/${pid}/board`);
    expect(board.status).toBe(200);
    expect(slugs(board.body)).toEqual(['arch', 'both']);
    const asJob = (j: Record<string, unknown>): EpicJob => ({ id: String(j.id), stage: String(j.stage), kind: 'member', brief: typeof j.brief === 'string' ? j.brief : null, updated: typeof j.updated === 'string' ? j.updated : null });
    const expected: unknown = JSON.parse(JSON.stringify(projectEpic(parseEpicLog(archLog), parsePlan(archPlan).members, [asJob(memberA), asJob(memberB)], null)));
    expect(list(board.body, 'epics')[0]).toEqual(expected);
    expect(field(list(board.body, 'epics')[0], 'counts')).toMatchObject({ merged: 1, running: 1, queued: 1 });
    expect(list(board.body, 'epics')[1]).toEqual(localBoth);
    expect(logs.filter((l) => l.includes('epics/torn'))).toHaveLength(1);
    expect(logs.filter((l) => l.includes('epics/no-start'))).toHaveLength(1);
    expect(logs.some((l) => l.includes('epics/arch') || l.includes('epics/both') || l.includes('epics/landed'))).toBe(false);
    // The landed epic (30 h ago) and its archived jobs are settled.
    expect((await get(`${url}/projects/${pid}/settled`)).body).toMatchObject({ epics: [{ slug: 'landed', state: 'landed' }] });
    // The archive was read once: one ls-tree and one cat-file --batch for jobs and epics together.
    expect(calls.filter((c) => c[0] === 'ls-tree')).toHaveLength(1);
    expect(calls.filter((c) => c[0] === 'cat-file')).toHaveLength(1);
    for (const c of calls) expect(['rev-parse', 'ls-tree', 'cat-file']).toContain(c[0] ?? '');
  });
});

describe('the epic-aware settle rule in the service (AC3, AC4)', () => {
  test('members settle with their epic; abandoned jobs and epics at once; standalone jobs as before', async () => {
    const root = await makeProject('alpha');
    const now = Date.now();
    const long = iso(now - 100 * H);
    for (const e of [epic('live', 'running', null), epic('old-land', 'landed', iso(now - 30 * H)), epic('new-land', 'landed', iso(now - 1 * H)), epic('dropped', 'abandoned', iso(now - 1000)), epic('waits', 'waiting', null)]) await writeEpic(root, e);
    for (const j of [
      job('001-alone-old', 'merged', iso(now - 48 * H)),
      job('002-alone-new', 'merged', iso(now - 1 * H)),
      job('003-live-merged', 'merged', long, 'live'),
      job('004-live-abandoned', 'abandoned', long, 'live'),
      job('005-live-working', 'build', null, 'live'),
      job('006-old-merged', 'merged', long, 'old-land'),
      job('007-new-merged', 'merged', long, 'new-land'),
      job('008-dropped-merged', 'merged', iso(now - 1000), 'dropped'),
      job('009-unknown-epic', 'merged', long, 'nowhere'),
    ]) await writeJob(root, j);
    await addRoot(registry, root);
    const { url } = await start();
    const pid = projectId(root);
    const plainB = await get(`${url}/projects/${pid}/board`);
    const narrow = await get(`${url}/projects/${pid}/board?settled=summary`);
    const settled = await get(`${url}/projects/${pid}/settled`);

    expect(ids(narrow.body)).toEqual(['002-alone-new', '003-live-merged', '005-live-working', '007-new-merged', '009-unknown-epic']);
    expect(ids(settled.body)).toEqual(['001-alone-old', '004-live-abandoned', '006-old-merged', '008-dropped-merged']);
    expect(Object.keys(isRec(settled.body) ? settled.body : {})).toEqual(['jobs', 'epics']);
    expect(slugs(settled.body)).toEqual(['dropped', 'old-land']);
    expect(slugs(narrow.body)).toEqual(['live', 'new-land', 'waits']);
    expect(slugs(plainB.body)).toEqual(['live', 'new-land', 'waits']);
    // The plain board still holds every job.
    expect(ids(plainB.body)).toHaveLength(9);
    // The summary counts settled jobs, and settled epics apart.
    expect(field(narrow.body, 'settled')).toEqual({ count: 4, lastMergedAt: iso(now - 1000), epics: 2 });

    // AC4: board epics and /settled epics split every epic, no overlap, no gap.
    const all = [...list(plainB.body, 'epics'), ...list(settled.body, 'epics')].map((e) => field(e, 'slug'));
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(['dropped', 'live', 'new-land', 'old-land', 'waits']);
    expect(field(field(narrow.body, 'settled'), 'epics')).toBe(list(settled.body, 'epics').length);
    // Passed through as stored.
    expect(list(settled.body, 'epics')[1]).toEqual(epic('old-land', 'landed', iso(now - 30 * H)));
  });
});

describe('the settle timer covers epics (AC5)', () => {
  test('a landed epic arms the timer for its crossing; when it fires, narrow clients see the epic and its members settle', async () => {
    const hours = 0.001; // 3.6 s
    const root = await makeProject('alpha', { ...CONFIG, dashboard: { settleAfterHours: hours } });
    const landedAt = Date.now() - hours * H + 2500; // crosses about 2.5 s from now
    await writeEpic(root, epic('e', 'landed', iso(landedAt)));
    const memberEnd = iso(Date.now() - H);
    await writeJob(root, job('001-e-a', 'merged', memberEnd, 'e'));
    await writeJob(root, job('002-working', 'build', null));
    await addRoot(registry, root);
    const delays: number[] = [];
    const timers: SettleTimers = {
      set: (fn, ms) => {
        delays.push(ms);
        return setTimeout(fn, ms);
      },
      clear: (t) => clearTimeout(t),
    };
    const { url } = await start({ timers });
    const narrow = await connect(url, '?settled=summary');
    const plain = await connect(url);
    await narrow.next((x) => x.event === 'projects');
    await plain.next((x) => x.event === 'projects');
    const before = await get(`${url}/projects/${projectId(root)}/board?settled=summary`);
    expect(ids(before.body)).toEqual(['001-e-a', '002-working']);
    expect(slugs(before.body)).toEqual(['e']);
    // Armed for the epic's crossing (the member, merged an hour ago, arms nothing of its own).
    const first = delays[0];
    expect(first).toBeDefined();
    expect(Math.abs((first ?? 0) - (landedAt + hours * H - Date.now()))).toBeLessThan(1000);
    await quiet([narrow, plain], 200);
    expect(Date.now()).toBeLessThan(landedAt + hours * H);
    const fromP = plain.seen.length;

    const moved = (x: Sse): boolean => x.event === 'board' && slugs(x.data).length === 0;
    const ev = await narrow.next(moved, 0, 5000);
    expect(Date.now() - (landedAt + hours * H)).toBeGreaterThanOrEqual(0);
    expect(ids(ev.data)).toEqual(['002-working']);
    expect(field(ev.data, 'settled')).toEqual({ count: 1, lastMergedAt: memberEnd, epics: 1 });
    await sleep(300);
    expect(plain.seen.slice(fromP).filter((x) => x.event === 'board')).toEqual([]);
    narrow.close();
    plain.close();
  }, 20_000);

  test('members of a non-terminal epic arm nothing', async () => {
    const root = await makeProject('alpha');
    await writeEpic(root, epic('e', 'running', null));
    await writeJob(root, job('001-e-a', 'merged', iso(Date.now() - 23 * H), 'e'));
    await addRoot(registry, root);
    let armed = 0;
    const timers: SettleTimers = {
      set: (fn, ms) => {
        armed++;
        return setTimeout(fn, ms);
      },
      clear: (t) => clearTimeout(t),
    };
    const { url } = await start({ timers });
    const narrow = await connect(url, '?settled=summary');
    await narrow.next((x) => x.event === 'projects');
    await sleep(300);
    expect(armed).toBe(0);
    narrow.close();
  });
});

describe('GET /projects/<pid>/epics/<slug>/docs (AC6, AC7)', () => {
  test('the plan, then each member brief in plan order; a missing brief is skipped', async () => {
    const root = await makeProject('alpha');
    await writeAt(join(root, 'factory', 'epics', 'e.md'), plan(['a', 'b', 'c']));
    await writeAt(join(root, 'factory', 'briefs', 'a.md'), '# A\n');
    await writeAt(join(root, 'factory', 'briefs', 'c.md'), '# C\n');
    await writeAt(join(root, 'factory', 'briefs', 'unlisted.md'), '# no\n');
    await addRoot(registry, root);
    const { url } = await start();
    const r = await get(`${url}/projects/${projectId(root)}/epics/e/docs`);
    expect(r.status).toBe(200);
    expect(r.cache).toBe('no-store');
    expect(r.body).toEqual({ files: [{ path: 'epics/e.md', text: plan(['a', 'b', 'c']) }, { path: 'briefs/a.md', text: '# A\n' }, { path: 'briefs/c.md', text: '# C\n' }] });
  });

  test('an archived-only epic serves its archived plan.md', async () => {
    const root = await makeProject('alpha');
    const archived = plan(['a', 'gone']);
    archive(root, { epics: { old: { 'events.jsonl': jsonl([started('old')]), 'plan.md': archived } } });
    await writeAt(join(root, 'factory', 'briefs', 'a.md'), '# A\n');
    await addRoot(registry, root);
    const { url } = await start();
    const r = await get(`${url}/projects/${projectId(root)}/epics/old/docs`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ files: [{ path: 'epics/old.md', text: archived }, { path: 'briefs/a.md', text: '# A\n' }] });
  });

  test('bad slugs, symlinked or escaping plans and briefs, and missing plans read nothing outside; the guards apply', async () => {
    const root = await makeProject('alpha');
    const outside = join(tmp, 'outside');
    await writeAt(join(outside, 'secret.md'), plan(['a']));
    await writeAt(join(outside, 'briefs', 'b.md'), 'SECRET B');
    await writeAt(join(root, 'factory', 'epics', 'e.md'), plan(['a', 'b', 'c']));
    await writeAt(join(root, 'factory', 'briefs', 'a.md'), '# A\n');
    await symlink(join(outside, 'briefs', 'b.md'), join(root, 'factory', 'briefs', 'b.md'));
    await symlink(join(outside, 'secret.md'), join(root, 'factory', 'epics', 'link.md'));
    // A second project whose whole briefs/ dir is a symlink out of it.
    const other = await makeProject('beta');
    await writeAt(join(other, 'factory', 'epics', 'e.md'), plan(['b']));
    await symlink(join(outside, 'briefs'), join(other, 'factory', 'briefs'));
    await addRoot(registry, root);
    await addRoot(registry, other);
    const { url } = await start();
    const base = `${url}/projects/${projectId(root)}/epics`;

    const ok = await get(`${base}/e/docs`);
    expect(ok.body).toEqual({ files: [{ path: 'epics/e.md', text: plan(['a', 'b', 'c']) }, { path: 'briefs/a.md', text: '# A\n' }] });
    expect(ok.text).not.toContain('SECRET');
    expect((await get(`${url}/projects/${projectId(other)}/epics/e/docs`)).body).toEqual({ files: [{ path: 'epics/e.md', text: plan(['b']) }] });

    for (const slug of ['link', 'missing', '..', '%2e%2e', '..%2f..%2foutside%2fsecret', 'a%2fb', '001-job-like', 'UPPER', 'a_b', '%00']) {
      const r = await get(`${base}/${slug}/docs`);
      expect({ slug, status: r.status }).toEqual({ slug, status: 404 });
      expect(r.text).not.toContain('SECRET');
      expect(r.cache).toBe('no-store');
    }
    expect((await get(`${url}/projects/000000000000/epics/e/docs`)).status).toBe(404);
    expect((await get(`${base}/e/docs`, { method: 'POST' })).status).toBe(405);
    const port = new URL(url).port;
    const foreign: Array<Record<string, string>> = [{ host: 'evil.example' }, { host: `127.0.0.1:${port}`, origin: 'http://evil.example' }];
    for (const headers of foreign) {
      expect((await get(`${base}/e/docs`, { headers })).status).toBe(403);
    }
  });
});

describe('the factory/epics/ watch (AC8)', () => {
  test('creating factory/epics/ after startup, then creating and editing a plan, re-sends the board', async () => {
    const root = await makeProject('alpha');
    await addRoot(registry, root);
    const { url } = await start();
    const pid = projectId(root);
    const plainC = await connect(url);
    const narrowC = await connect(url, '?settled=summary');
    await plainC.next((x) => x.event === 'projects');
    await narrowC.next((x) => x.event === 'projects');
    await quiet([plainC, narrowC]);

    await mkdir(join(root, 'factory', 'epics'));
    await quiet([plainC, narrowC]);
    const boards = (c: { seen: Sse[] }, from: number): Sse[] => c.seen.slice(from).filter((x) => x.event === 'board' && field(x.data, 'project') === pid);

    for (const text of [plan(['a']), plan(['a', 'b'])]) {
      const fromP = plainC.seen.length;
      const fromN = narrowC.seen.length;
      await writeFile(join(root, 'factory', 'epics', 'e.md'), text);
      const p = await plainC.next((x) => x.event === 'board', fromP);
      const n = await narrowC.next((x) => x.event === 'board', fromN);
      expect(field(p.data, 'settled')).toBeUndefined();
      expect(field(n.data, 'settled')).toBeDefined();
      await quiet([plainC, narrowC]);
      // Debounced: one burst, a handful of events at most.
      expect(boards(plainC, fromP).length).toBeLessThanOrEqual(2);
    }
    plainC.close();
    narrowC.close();
  });

  test('a factory/epics/ present at startup is watched', async () => {
    const root = await makeProject('alpha');
    await writeAt(join(root, 'factory', 'epics', 'e.md'), plan(['a']));
    await addRoot(registry, root);
    const { url } = await start();
    const c = await connect(url);
    await c.next((x) => x.event === 'projects');
    await quiet([c]);
    const from = c.seen.length;
    await writeFile(join(root, 'factory', 'epics', 'e.md'), plan(['a', 'b']));
    await c.next((x) => x.event === 'board', from);
    c.close();
  });
});
