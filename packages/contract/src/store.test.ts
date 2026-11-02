import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEventInput, parseConfig } from './contract';
import type { EventInput } from './contract';
import { project } from './project';
import { agentIdsOf, appendEvent, claimJob, parseLog, readLog, readVerdict, rebuild } from './store';
import type { Usage, UsageReader, UsageWindow } from './usage';
import { formatShow } from './show';

let root: string;
const ID = '019-example';
const jobDir = (id = ID) => join(root, 'jobs', id);
const REVIEWERS = ['security', 'ux'];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'factory-store-'));
  await copyFile(join(import.meta.dir, 'fixtures', 'config.json'), join(root, 'config.json'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const claim = async (id = ID) => {
  const config = parseConfig(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')));
  return appendEvent(root, id, parseEventInput('job.claimed', { brief: null, issue: 'M80' }, { id, config }));
};
const ev = (type: string, fields: Record<string, unknown> = {}): EventInput => parseEventInput(type, fields);

async function toReview(): Promise<void> {
  await claim();
  await appendEvent(root, ID, ev('stage.entered', { stage: 'spec' }));
  await appendEvent(root, ID, ev('stage.entered', { stage: 'build' }));
  await appendEvent(root, ID, ev('round.started', { round: 1, reviewers: REVIEWERS }));
}
const writeReview = async (key: string, line: string) => {
  await mkdir(join(jobDir(), 'round-1'), { recursive: true });
  await writeFile(join(jobDir(), 'round-1', `review-${key}.md`), `${line}\n\nbody\n`);
};

describe('appendEvent / job.json', () => {
  test('writes a job.json equal to project(readLog) and leaves no tmp file', async () => {
    await claim();
    await appendEvent(root, ID, ev('stage.entered', { stage: 'spec' }));
    await appendEvent(root, ID, ev('job.titled', { title: 'Example' }));
    const snap = JSON.parse(await readFile(join(jobDir(), 'job.json'), 'utf8'));
    expect(snap).toEqual(JSON.parse(JSON.stringify(project(await readLog(root, ID)))));
    expect(snap.title).toBe('Example');
    expect((await readdir(jobDir())).sort()).toEqual(['events.jsonl', 'job.json']);
  });

  test('ts comes from the injected clock', async () => {
    const at = new Date('2026-01-02T03:04:05.678Z');
    const config = parseConfig(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')));
    await appendEvent(root, ID, parseEventInput('job.claimed', {}, { id: ID, config }), () => at);
    const [first] = await readLog(root, ID);
    expect(first?.ts).toBe('2026-01-02T03:04:05.678Z');
  });

  test('a rejected transition writes nothing', async () => {
    await claim();
    const log = join(jobDir(), 'events.jsonl');
    const before = await readFile(log);
    const m = (await stat(join(jobDir(), 'job.json'))).mtimeMs;
    await expect(appendEvent(root, ID, ev('stage.entered', { stage: 'approve' }))).rejects.toThrow();
    expect((await readFile(log)).length).toBe(before.length);
    expect((await stat(join(jobDir(), 'job.json'))).mtimeMs).toBe(m);
  });

  test('concurrent reviewer finishes both land in the log and in job.json', async () => {
    for (let i = 0; i < 20; i++) {
      await rm(jobDir(), { recursive: true, force: true });
      await toReview();
      await writeReview('security', 'VERDICT: CHANGES');
      await writeReview('ux', 'VERDICT: PASS');
      const fin = (key: string) => ev('agent.finished', { role: 'reviewer', key, round: 1 });
      await Promise.all([appendEvent(root, ID, fin('security')), appendEvent(root, ID, fin('ux'))]);
      const finished = (await readLog(root, ID)).filter((e) => e.type === 'agent.finished');
      expect(finished.length).toBe(2);
      const snap = JSON.parse(await readFile(join(jobDir(), 'job.json'), 'utf8'));
      expect(snap.reviews).toEqual({ security: 'CHANGES', ux: 'PASS' });
      expect((await readdir(jobDir())).includes('.events.lock')).toBe(false);
    }
  });

  test('a stale lock (older than 30s) is broken', async () => {
    await mkdir(jobDir(), { recursive: true });
    const lock = join(jobDir(), '.events.lock');
    await mkdir(lock);
    const old = new Date(Date.now() - 60_000);
    const { utimes } = await import('node:fs/promises');
    await utimes(lock, old, old);
    await claim();
    expect((await readLog(root, ID)).length).toBe(1);
  });

  test('approver verdict comes from decision.md', async () => {
    await toReview();
    for (const k of REVIEWERS) {
      await writeReview(k, 'VERDICT: PASS');
      await appendEvent(root, ID, ev('agent.finished', { role: 'reviewer', key: k, round: 1 }));
    }
    await appendEvent(root, ID, ev('stage.entered', { stage: 'approve' }));
    await writeFile(join(jobDir(), 'decision.md'), 'APPROVE\n\nbecause\n');
    const snap = await appendEvent(root, ID, ev('agent.finished', { role: 'approver' }));
    expect(snap.decision).toBe('APPROVE');
  });

  test('a rejected verdict file writes nothing', async () => {
    await toReview();
    await writeReview('security', 'VERDICT: pass');
    const before = await readFile(join(jobDir(), 'events.jsonl'));
    await expect(appendEvent(root, ID, ev('agent.finished', { role: 'reviewer', key: 'security', round: 1 }))).rejects.toThrow('first line must be one of');
    expect((await readFile(join(jobDir(), 'events.jsonl'))).length).toBe(before.length);
  });
});

describe('truncated log', () => {
  test('appendEvent and rebuild both throw, file unchanged', async () => {
    await claim();
    const log = join(jobDir(), 'events.jsonl');
    await appendFile(log, '{"ts":"2026');
    const before = await readFile(log);
    await expect(appendEvent(root, ID, ev('stage.entered', { stage: 'spec' }))).rejects.toThrow(/line 2/);
    await expect(rebuild(root, ID)).rejects.toThrow(/line 2/);
    expect(Buffer.compare(await readFile(log), before)).toBe(0);
  });
});

describe('readVerdict', () => {
  const R = ['VERDICT: PASS', 'VERDICT: CHANGES'];
  test('missing file throws with the path', async () => {
    const p = join(root, 'nope.md');
    await expect(readVerdict(p, R)).rejects.toThrow(`${p}: missing`);
  });
  test('wrong case throws', async () => {
    const p = join(root, 'r.md');
    await writeFile(p, 'VERDICT: pass\n');
    await expect(readVerdict(p, R)).rejects.toThrow(`${p}: first line must be one of`);
  });
  test('skips leading blank lines', async () => {
    const p = join(root, 'r.md');
    await writeFile(p, '\n\n  VERDICT: PASS  \nrest\n');
    expect(await readVerdict(p, R)).toBe('PASS');
  });
  test('decision tokens', async () => {
    const p = join(root, 'decision.md');
    await writeFile(p, 'ESCALATE\n');
    expect(await readVerdict(p, ['APPROVE', 'ESCALATE'])).toBe('ESCALATE');
  });
});

describe('rebuild', () => {
  test('rebuilds only evented jobs; legacy dirs are untouched', async () => {
    await claim();
    await mkdir(jobDir('001-legacy'), { recursive: true });
    const legacy = '{"id":"001-legacy","stage":"merged"}\n';
    await writeFile(join(jobDir('001-legacy'), 'job.json'), legacy);
    await rm(join(jobDir(), 'job.json'));
    expect(await rebuild(root)).toEqual([ID]);
    expect(await readFile(join(jobDir('001-legacy'), 'job.json'), 'utf8')).toBe(legacy);
    expect(JSON.parse(await readFile(join(jobDir(), 'job.json'), 'utf8')).id).toBe(ID);
  });
});

describe('target', () => {
  test('a log without target projects target: null on append and rebuild; with one, it is kept', async () => {
    await claim();
    await appendEvent(root, ID, ev('stage.entered', { stage: 'spec' }));
    const read = async () => JSON.parse(await readFile(join(jobDir(), 'job.json'), 'utf8')).target;
    expect(await read()).toBeNull();
    await rm(join(jobDir(), 'job.json'));
    expect(await rebuild(root, ID)).toEqual([ID]);
    expect(await read()).toBeNull();

    const config = parseConfig(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')));
    const snap = await appendEvent(root, '020-other', parseEventInput('job.claimed', {}, { id: '020-other', config, target: 'develop' }));
    expect(snap.target).toBe('develop');
    expect((await readLog(root, '020-other'))[0]).toMatchObject({ type: 'job.claimed', target: 'develop' });
  });

  test('a hand-edited non-string target projects null on rebuild', async () => {
    await mkdir(jobDir(), { recursive: true });
    const line = { ts: '2026-10-23T14:00:00.000Z', type: 'job.claimed', schema: 'factory/v1', id: ID, maxRound: 2, brief: null, issue: null, target: 5 };
    await writeFile(join(jobDir(), 'events.jsonl'), `${JSON.stringify(line)}\n`);
    await rebuild(root, ID);
    expect(JSON.parse(await readFile(join(jobDir(), 'job.json'), 'utf8')).target).toBeNull();
  });
});

describe('job id', () => {
  test('a malformed id is rejected before touching disk', async () => {
    await expect(appendEvent(root, '../evil', ev('job.noted', { note: 'x' }))).rejects.toThrow('must match');
    expect(await readdir(root)).not.toContain('jobs');
  });
});

describe('hardening', () => {
  test('a legacy job (job.json, no log) is not modifiable, even by job.claimed', async () => {
    await mkdir(jobDir('001-legacy'), { recursive: true });
    const legacy = '{"id":"001-legacy","stage":"merged"}\n';
    const file = join(jobDir('001-legacy'), 'job.json');
    await writeFile(file, legacy);
    const config = parseConfig(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')));
    await expect(appendEvent(root, '001-legacy', parseEventInput('job.claimed', {}, { id: '001-legacy', config }))).rejects.toThrow('legacy job');
    await expect(appendEvent(root, '001-legacy', ev('job.noted', { note: 'x' }))).rejects.toThrow('legacy job');
    expect(await readFile(file, 'utf8')).toBe(legacy);
    expect((await readdir(jobDir('001-legacy'))).sort()).toEqual(['job.json']);
  });

  test('rebuild --all ignores stray entries in jobs/', async () => {
    await claim();
    await writeFile(join(root, 'jobs', '.DS_Store'), 'x');
    await mkdir(join(root, 'jobs', 'not-a-job'));
    await mkdir(join(root, 'jobs', '.worktrees'));
    expect(await rebuild(root)).toEqual([ID]);
  });

  test('non-claim events and rebuild on a missing job create nothing', async () => {
    await expect(appendEvent(root, ID, ev('job.noted', { note: 'x' }))).rejects.toThrow('no such job');
    await expect(rebuild(root, ID)).rejects.toThrow('no such job');
    expect(await readdir(root)).not.toContain('jobs');
  });

  test('a job dir without a log: non-claim is rejected and nothing is written', async () => {
    await mkdir(jobDir(), { recursive: true });
    await expect(appendEvent(root, ID, ev('job.noted', { note: 'x' }))).rejects.toThrow();
    expect(await readdir(jobDir())).toEqual([]);
  });

  test('a log whose tail lacks a newline is refused', async () => {
    await claim();
    const log = join(jobDir(), 'events.jsonl');
    const text = (await readFile(log, 'utf8')).trimEnd();
    await writeFile(log, text);
    await expect(appendEvent(root, ID, ev('stage.entered', { stage: 'spec' }))).rejects.toThrow('newline');
    expect(await readFile(log, 'utf8')).toBe(text);
  });
});

describe('job.abandoned (force)', () => {
  const files = async (): Promise<Record<string, string>> => ({
    log: await readFile(join(jobDir(), 'events.jsonl'), 'utf8'),
    snap: await readFile(join(jobDir(), 'job.json'), 'utf8'),
  });
  const abandon = ev('job.abandoned', { reason: 'dead end' });

  test('from a working stage, appendEvent rejects it without force and writes nothing; with force it lands', async () => {
    await toReview();
    const before = await files();
    await expect(appendEvent(root, ID, abandon)).rejects.toThrow(/force/);
    await expect(appendEvent(root, ID, abandon, undefined, { force: false })).rejects.toThrow(/force/);
    expect(await files()).toEqual(before);
    const snap = await appendEvent(root, ID, abandon, undefined, { force: true });
    expect(snap).toMatchObject({ stage: 'abandoned', note: 'dead end' });
    const last = (await readLog(root, ID)).at(-1);
    expect(last).toMatchObject({ type: 'job.abandoned', reason: 'dead end' });
    expect(last && 'force' in last).toBe(false); // force is never recorded
  });

  test('from needs-human it lands without force', async () => {
    await toReview();
    await appendEvent(root, ID, ev('job.escalated', { reason: 'stuck' }));
    expect((await appendEvent(root, ID, abandon)).stage).toBe('abandoned');
  });

  test('once abandoned, every event is rejected with or without force, and nothing is written', async () => {
    await toReview();
    await appendEvent(root, ID, abandon, undefined, { force: true });
    const before = await files();
    for (const e of [ev('job.noted', { note: 'x' }), ev('job.titled', { title: 'T' }), ev('agent.started', { role: 'builder' }),
      ev('job.reworked', { k: 1, maxRound: 3 }), ev('job.escalated', { reason: 'r' }), abandon]) {
      await expect(appendEvent(root, ID, e)).rejects.toThrow(/abandoned \(terminal\)/);
      await expect(appendEvent(root, ID, e, undefined, { force: true })).rejects.toThrow(/abandoned \(terminal\)/);
    }
    expect(await files()).toEqual(before);
  });
});

describe('claimJob (AC1–AC4)', () => {
  const cfg = async () => parseConfig(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')));
  const claimSlug = async (slug: string, fields: Record<string, unknown> = {}) => (await claimJob(root, slug, { fields, config: await cfg(), target: 'main' })).id;
  const seed = async (...ids: string[]) => {
    for (const id of ids) await mkdir(jobDir(id), { recursive: true });
  };
  const lock = () => join(root, 'jobs', '.claim.lock');

  test('numbers: none gives 001, after 004 gives 005, gaps are never filled', async () => {
    expect(await claimSlug('a')).toBe('001-a');
    await seed('004-b');
    expect(await claimSlug('c')).toBe('005-c');
    expect((await readdir(join(root, 'jobs'))).sort()).toEqual(['001-a', '004-b', '005-c']);
  });

  test('the first event is job.claimed with the picked id, fields, and target', async () => {
    const id = await claimSlug('x', { brief: 'b.md', issue: 'M1', maxRound: 4 });
    const [first] = await readLog(root, id);
    expect(first).toMatchObject({ type: 'job.claimed', id: '001-x', brief: 'b.md', issue: 'M1', maxRound: 4, target: 'main' });
  });

  test('concurrent claims in-process get distinct, consecutive numbers and leave no lock', async () => {
    const slugs = Array.from({ length: 20 }, (_, i) => `s-${i}`);
    const ids = await Promise.all(slugs.map((s) => claimSlug(s)));
    expect(ids.map((id) => id.slice(0, 3)).sort()).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(3, '0')));
    for (const [i, id] of ids.entries()) expect(id.slice(4)).toBe(slugs[i] ?? '');
    expect(await readdir(join(root, 'jobs'))).not.toContain('.claim.lock');
  });

  test('a .claim.lock older than 30 s is broken and the claim goes ahead', async () => {
    await mkdir(lock(), { recursive: true });
    const old = new Date(Date.now() - 60_000);
    await utimes(lock(), old, old);
    expect(await claimSlug('after-stale')).toBe('001-after-stale');
    expect(await readdir(join(root, 'jobs'))).toEqual(['001-after-stale']);
  });

  test('a fresh .claim.lock is waited on', async () => {
    await mkdir(lock(), { recursive: true });
    let done = false;
    const p = claimSlug('waits').then((id) => {
      done = true;
      return id;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(done).toBe(false);
    expect(await readdir(join(root, 'jobs'))).toEqual(['.claim.lock']);
    await rm(lock(), { recursive: true });
    expect(await p).toBe('001-waits');
  });

  test('refusals write nothing and release the lock', async () => {
    await seed('003-export-csv');
    await writeFile(join(jobDir('003-export-csv'), 'job.json'), JSON.stringify({ stage: 'review' }));
    await expect(claimSlug('export-csv')).rejects.toThrow('slug export-csv is live as 003-export-csv');
    await expect(claimSlug('Bad')).rejects.toThrow(/slug/);
    await seed('999-z');
    await expect(claimSlug('more')).rejects.toThrow(/999/);
    expect((await readdir(join(root, 'jobs'))).sort()).toEqual(['003-export-csv', '999-z']);
  });
});

describe('claimJob counts the archive (job 045, AC7)', () => {
  const cfg = async () => parseConfig(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')));
  const claimWith = async (slug: string, archived?: readonly string[]) =>
    (await claimJob(root, slug, { fields: {}, config: await cfg(), target: 'main' }, undefined, archived === undefined ? {} : { archived: async () => archived })).id;

  test('the next number is above the highest archived id when the archive is ahead of the job dirs', async () => {
    await mkdir(jobDir('002-local'), { recursive: true });
    expect(await claimWith('a', ['001-old', '007-gone', 'not-an-id'])).toBe('008-a');
  });

  test('job dirs ahead of the archive still win; an empty archive changes nothing', async () => {
    await mkdir(jobDir('010-local'), { recursive: true });
    expect(await claimWith('b', ['003-x'])).toBe('011-b');
    expect(await claimWith('c', [])).toBe('012-c');
    expect(await claimWith('d')).toBe('013-d');
  });

  test('an archived 999 refuses the claim and writes nothing', async () => {
    await expect(claimWith('e', ['999-last'])).rejects.toThrow(/999/);
    expect(await readdir(join(root, 'jobs'))).toEqual([]);
  });

  test('a failing archive read refuses the claim, writes nothing, and releases the lock', async () => {
    const config = await cfg();
    const archived = async (): Promise<readonly string[]> => {
      throw new Error('archive: git failed');
    };
    await expect(claimJob(root, 'f', { fields: {}, config, target: 'main' }, undefined, { archived })).rejects.toThrow('archive: git failed');
    expect(await readdir(join(root, 'jobs'))).toEqual([]);
  });
});

describe('parseLog', () => {
  test('parses log text exactly as readLog reads the file', async () => {
    await claim();
    await appendEvent(root, ID, ev('stage.entered', { stage: 'spec' }));
    const text = await readFile(join(jobDir(), 'events.jsonl'), 'utf8');
    expect(parseLog(text)).toEqual(await readLog(root, ID));
    expect(parseLog(text.slice(0, -1))).toEqual(await readLog(root, ID)); // no trailing newline
  });

  test('an empty text is no events; a torn or foreign line throws, naming the line', () => {
    expect(parseLog('')).toEqual([]);
    expect(() => parseLog('{"ts":"2026-01-01T00:00:00.000Z","type":"job.claimed"}\n{"ts":')).toThrow('events.jsonl line 2 is not valid JSON');
    expect(() => parseLog('{"a":1}\n')).toThrow('events.jsonl line 1 is not a factory event');
  });
});

// Copies of this repo's own jobs (a merge conflict, escalations, a rework from approve): the
// reducer must rebuild each stored job.json exactly (decision 3, job 087 AC2). They were written
// before usage was recorded: every stored key keeps its value, and the added usage keys read
// "not recorded" (093 AC4).
describe('rebuild over recorded jobs', () => {
  const fixtures = new URL('./fixtures/jobs/', import.meta.url).pathname;
  test('project(events.jsonl) keeps every key of the stored job.json for every fixture job', async () => {
    const ids = (await readdir(fixtures)).sort();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const log = parseLog(await readFile(join(fixtures, id, 'events.jsonl'), 'utf8'));
      const stored: unknown = JSON.parse(await readFile(join(fixtures, id, 'job.json'), 'utf8'));
      const snap: unknown = JSON.parse(JSON.stringify(project(log)));
      expect({ id, snapshot: snap }).toMatchObject({ id, snapshot: stored });
      if (typeof stored !== 'object' || stored === null || typeof snap !== 'object' || snap === null) throw new Error('not an object');
      expect(Object.keys(snap).filter((k) => !(k in stored))).toEqual(['usage']);
    }
  });

  test('AC4: spans and totals of a log written before usage read "not recorded", never "unavailable"', async () => {
    for (const id of (await readdir(fixtures)).sort()) {
      const snap = project(parseLog(await readFile(join(fixtures, id, 'events.jsonl'), 'utf8')));
      expect(snap.timing.agents.length).toBeGreaterThan(0);
      for (const a of snap.timing.agents) expect({ id, usage: a.usage, agentId: a.agentId }).toEqual({ id, usage: null, agentId: null });
      const totals = [snap.usage.job, ...snap.usage.stages.map((s) => s.total), ...snap.usage.rounds.map((r) => r.total)];
      if (snap.usage.orchestrator !== null && snap.usage.orchestrator.spans > 0) totals.push(snap.usage.orchestrator);
      for (const t of totals) expect({ id, status: t.status }).toEqual({ id, status: 'not recorded' });
      expect(formatShow(snap, new Date()).join('\n')).not.toContain('unavailable');
    }
  });
});

describe('usage on append (job 093)', () => {
  const c = (n: number) => ({ model: 'm', input: n, output: 0, cacheWrite: 0, cacheRead: 0 });
  // A fake harness reader: records what it was asked, answers with `answer`.
  function fake(answer: (what: string) => Promise<Usage>) {
    const calls: { what: string; ids?: readonly string[]; window: UsageWindow }[] = [];
    const reader: UsageReader = {
      agent: (agentId, window) => { calls.push({ what: `agent ${agentId}`, window }); return answer(`agent ${agentId}`); },
      orchestrator: (ids, window) => { calls.push({ what: 'orchestrator', ids, window }); return answer('orchestrator'); },
    };
    return { reader, calls };
  }
  const clock = (start: string) => {
    let t = Date.parse(start);
    return () => new Date((t += 60_000));
  };

  test('agent.finished reads the span [its start, its ts]; the stretch end reads [the stretch start, its ts] over the job agent ids', async () => {
    const now = clock('2026-11-02T10:00:00.000Z');
    const { reader, calls } = fake(async (what) => (what === 'orchestrator' ? c(7) : c(3)));
    const config = parseConfig(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')));
    await appendEvent(root, ID, parseEventInput('job.claimed', {}, { id: ID, config }), now);
    await appendEvent(root, ID, ev('agent.started', { role: 'spec-writer' }), now, { usage: reader });
    await appendEvent(root, ID, ev('agent.finished', { role: 'spec-writer', agentId: 'sp-1' }), now, { usage: reader });
    await appendEvent(root, ID, ev('job.escalated', { reason: 'q' }), now, { usage: reader });
    const log = await readLog(root, ID);
    expect(calls).toEqual([
      { what: 'agent sp-1', window: { from: log[1]?.ts ?? '', to: log[2]?.ts ?? '' } },
      { what: 'orchestrator', ids: ['sp-1'], window: { from: log[0]?.ts ?? '', to: log[3]?.ts ?? '' } },
    ]);
    expect(log[2]).toMatchObject({ agentId: 'sp-1', usage: c(3) });
    expect(log[3]).toMatchObject({ orchestrator: c(7) });
    // From needs-human with no open stretch, abandon records no orchestrator spend.
    await appendEvent(root, ID, ev('job.abandoned', { reason: 'x' }), now, { usage: reader });
    expect(calls).toHaveLength(2);
    expect((await readLog(root, ID))[4]).not.toHaveProperty('orchestrator');
  });

  test('a reader that throws is unavailable with a one-line reason, and the event still lands', async () => {
    const { reader } = fake(async () => { throw new Error('disk on fire\nsecond line'); });
    await claim();
    await appendEvent(root, ID, ev('agent.started', { role: 'builder', name: 'b' }));
    const snap = await appendEvent(root, ID, ev('agent.finished', { role: 'builder', name: 'b', agentId: 'x' }), undefined, { usage: reader });
    expect(snap.timing.agents[0]?.usage).toEqual({ unavailable: 'usage reader failed: disk on fire' });
  });

  test('a rejected event never asks the reader and writes nothing', async () => {
    const { reader, calls } = fake(async () => c(1));
    await claim();
    await expect(appendEvent(root, ID, ev('job.merged', { sha: 'abc' }), undefined, { usage: reader })).rejects.toThrow();
    expect(calls).toEqual([]);
    expect((await readLog(root, ID)).length).toBe(1);
  });

  test('without a reader nothing is recorded; an unsafe agentId is dropped either way', async () => {
    const { reader, calls } = fake(async () => c(1));
    await claim();
    await appendEvent(root, ID, ev('agent.started', { role: 'builder', name: 'b' }));
    await appendEvent(root, ID, ev('agent.finished', { role: 'builder', name: 'b', agentId: 'ok-1' }));
    await appendEvent(root, ID, ev('agent.started', { role: 'builder', name: 'b' }));
    await appendEvent(root, ID, ev('agent.finished', { role: 'builder', name: 'b', agentId: 'a/b' }));
    await appendEvent(root, ID, ev('agent.finished', { role: 'builder', name: 'c', agentId: 'a b' }), undefined, { usage: reader });
    await appendEvent(root, ID, ev('agent.finished', { role: 'builder', name: 'orphan', agentId: 'z' }), undefined, { usage: reader });
    const log = await readLog(root, ID);
    expect(log[2]).toMatchObject({ agentId: 'ok-1' });
    expect(log[2]).not.toHaveProperty('usage');
    expect(log[4]).not.toHaveProperty('agentId');
    expect(log[4]).not.toHaveProperty('usage');
    expect(log[5]).toMatchObject({ usage: { unavailable: 'agentId is not a safe id (want ^[A-Za-z0-9_-]+$)' } });
    expect(log[5]).not.toHaveProperty('agentId');
    expect(log[6]).toMatchObject({ agentId: 'z', usage: { unavailable: 'no open agent.started for this span' } });
    expect(calls).toEqual([]);
    expect(agentIdsOf(log)).toEqual(['ok-1', 'z']);
  });
});
