import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEventInput, parseConfig } from './contract';
import type { EventInput } from './contract';
import { project } from './project';
import { appendEvent, readLog, readVerdict, rebuild } from './store';

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
