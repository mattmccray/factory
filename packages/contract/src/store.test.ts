import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEventInput, parseConfig } from './contract';
import type { EventInput } from './contract';
import { project } from './project';
import { appendEvent, claimJob, readLog, readVerdict, rebuild } from './store';

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
