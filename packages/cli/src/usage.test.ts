// Token spend through the CLI (docs/contract/v1.md "Usage"): `event` and `epic event` read the
// Claude Code transcripts under a temp CLAUDE_CONFIG_DIR and record the spend on the log.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Fixture } from './epicfixture';
import { messageLines, projectDir, userLine, writeAgent, writeSession } from './transcriptfixture';
import type { FakeMessage } from './transcriptfixture';

let f: Fixture;
beforeEach(async () => {
  f = new Fixture();
  await f.setUp();
});
afterEach(async () => {
  await f.tearDown();
});

// A timestamp strictly between the CLI event before it and the one after it.
async function mark(): Promise<string> {
  await Bun.sleep(4);
  const t = new Date().toISOString();
  await Bun.sleep(4);
  return t;
}

const counts = (m: FakeMessage) => ({ model: m.model ?? 'claude-opus-4-5', input: m.input, output: m.output, cacheWrite: m.cacheWrite, cacheRead: m.cacheRead });
const msg = (id: string, at: string, n: number): FakeMessage => ({ id, at, input: n, output: n * 10, cacheWrite: n * 100, cacheRead: n * 1000 });
const project = (): string => projectDir(f.claudeDir, f.repo);

async function review(id: string, round: number, verdict: string): Promise<void> {
  await mkdir(join(f.root, 'jobs', id, `round-${round}`), { recursive: true });
  await writeFile(join(f.root, 'jobs', id, `round-${round}`, 'review-code.md'), `VERDICT: ${verdict}\n`);
}

const lastEvent = async (...rel: string[]): Promise<Record<string, unknown>> => {
  const all = await f.lines(...rel);
  const last = all[all.length - 1];
  if (last === undefined) throw new Error('empty log');
  return last;
};

describe('AC2: a builder resumed for round 2 records each span from the same transcript', () => {
  test('each agent.finished and its span carry their own window; rebuild needs no transcript', async () => {
    const [id = ''] = await f.ok('claim', 'solo');
    await f.ok('event', id, 'stage.entered', 'stage=spec');
    await f.ok('event', id, 'stage.entered', 'stage=build');
    await f.ok('event', id, 'agent.started', 'role=builder', `name=builder-${id}`);
    const r0 = msg('m_r0', await mark(), 1);
    await writeAgent(project(), 'sess-1', 'bld01', [userLine(r0.at, 'sess-1'), ...messageLines(r0, 'sess-1')]);
    await f.ok('event', id, 'agent.finished', 'role=builder', `name=builder-${id}`, 'agentId=bld01');
    await f.ok('event', id, 'round.started', 'round=1');
    await f.ok('event', id, 'agent.started', 'role=reviewer', 'key=code', 'round=1');
    await review(id, 1, 'CHANGES');
    await f.ok('event', id, 'agent.finished', 'role=reviewer', 'key=code', 'round=1');
    await f.ok('event', id, 'stage.entered', 'stage=build');
    await f.ok('event', id, 'agent.started', 'role=builder', `name=builder-${id}`, 'round=1');
    const r1 = msg('m_r1', await mark(), 2);
    await writeAgent(project(), 'sess-1', 'bld01', messageLines(r1, 'sess-1'));
    await f.ok('event', id, 'agent.finished', 'role=builder', `name=builder-${id}`, 'round=1', 'agentId=bld01');

    const builderFinishes = (await f.lines('jobs', id, 'events.jsonl')).filter((e) => e.type === 'agent.finished' && e.role === 'builder');
    expect(builderFinishes).toMatchObject([
      { agentId: 'bld01', usage: counts(r0) },
      { round: 1, agentId: 'bld01', usage: counts(r1) },
    ]);
    const snap = await f.json('jobs', id, 'job.json');
    expect(snap.timing).toMatchObject({
      agents: [
        { role: 'builder', round: null, agentId: 'bld01', usage: counts(r0) },
        { role: 'reviewer', key: 'code', round: 1, verdict: 'CHANGES', usage: { unavailable: 'no agentId on agent.finished' } },
        { role: 'builder', round: 1, agentId: 'bld01', usage: counts(r1) },
      ],
    });
    expect(snap.usage).toMatchObject({
      rounds: [
        { round: 0, total: { status: 'exact', input: 1, output: 10, cacheWrite: 100, cacheRead: 1000, spans: 1, unknown: 0 } },
        { round: 1, total: { status: 'partial', input: 2, output: 20, cacheWrite: 200, cacheRead: 2000, spans: 2, unknown: 1 } },
      ],
    });

    const before = await readFile(join(f.root, 'jobs', id, 'job.json'), 'utf8');
    await rm(join(f.claudeDir, 'projects'), { recursive: true, force: true });
    await rm(join(f.root, 'jobs', id, 'job.json'));
    expect(await f.ok('rebuild', id)).toEqual([`rebuilt 1: ${id}`]);
    expect(await readFile(join(f.root, 'jobs', id, 'job.json'), 'utf8')).toBe(before);
  });
});

describe('AC3: usage that cannot be read never blocks an event', () => {
  test('no agentId, an unsafe one, a missing transcript, an unknown format: exit 0, unavailable, partial totals, no new doctor failure', async () => {
    const doctorBefore = await f.cli('doctor');
    const [id = ''] = await f.ok('claim', 'solo');
    await f.ok('event', id, 'stage.entered', 'stage=spec');
    await f.ok('event', id, 'agent.started', 'role=spec-writer');
    const good = msg('g', await mark(), 3);
    await writeAgent(project(), 'sess-1', 'goodone', messageLines(good, 'sess-1'));
    await f.ok('event', id, 'agent.finished', 'role=spec-writer', 'agentId=goodone');
    await f.ok('event', id, 'stage.entered', 'stage=build');
    await f.ok('event', id, 'agent.started', 'role=builder', 'name=b');
    expect(await f.ok('event', id, 'agent.finished', 'role=builder', 'name=b')).toEqual(['build']);
    await f.ok('event', id, 'round.started', 'round=1');
    await f.ok('event', id, 'agent.started', 'role=reviewer', 'key=code', 'round=1');
    await review(id, 1, 'CHANGES');
    expect(await f.ok('event', id, 'agent.finished', 'role=reviewer', 'key=code', 'round=1', 'agentId=../../etc/passwd')).toEqual(['review']);
    await f.ok('event', id, 'stage.entered', 'stage=build');
    await f.ok('event', id, 'agent.started', 'role=builder', 'name=b', 'round=1');
    await f.ok('event', id, 'agent.finished', 'role=builder', 'name=b', 'round=1', 'agentId=ghost');
    await f.ok('event', id, 'round.started', 'round=2');
    await f.ok('event', id, 'agent.started', 'role=reviewer', 'key=code', 'round=2');
    await review(id, 2, 'PASS');
    await writeAgent(project(), 'sess-1', 'weird', ['{"foo":1}', 'not json at all']);
    await f.ok('event', id, 'agent.finished', 'role=reviewer', 'key=code', 'round=2', 'agentId=weird');

    const log = await readFile(join(f.root, 'jobs', id, 'events.jsonl'), 'utf8');
    expect(log).not.toContain('etc/passwd');
    const snap = await f.json('jobs', id, 'job.json');
    expect(snap.reviews).toEqual({ code: 'PASS' });
    expect(snap.history).toEqual([{ round: 1, reviews: { code: 'CHANGES' } }]);
    expect(snap.timing).toMatchObject({
      agents: [
        { role: 'spec-writer', usage: counts(good) },
        { role: 'builder', usage: { unavailable: 'no agentId on agent.finished' } },
        { role: 'reviewer', round: 1, verdict: 'CHANGES', agentId: null, usage: { unavailable: 'agentId is not a safe id (want ^[A-Za-z0-9_-]+$)' } },
        { role: 'builder', round: 1, agentId: 'ghost', usage: { unavailable: 'no Claude Code transcript for agent ghost' } },
        { role: 'reviewer', round: 2, verdict: 'PASS', agentId: 'weird', usage: { unavailable: 'Claude Code transcript format not recognized' } },
      ],
    });
    expect(snap.usage).toMatchObject({
      stages: [
        { stage: 'spec', total: { status: 'exact', spans: 1, unknown: 0 } },
        { stage: 'build', total: { status: 'unavailable', spans: 2, unknown: 2 } },
        { stage: 'review', total: { status: 'unavailable', spans: 2, unknown: 2 } },
      ],
      job: { status: 'partial', input: 3, output: 30, cacheWrite: 300, cacheRead: 3000, spans: 5, unknown: 4 },
    });
    const show = (await f.ok('show', id)).join('\n');
    expect(show).toContain('≥ 3.3k, 4 spans unknown');
    expect((await f.cli('doctor')).out.filter((l) => /fail/i.test(l))).toEqual(doctorBefore.out.filter((l) => /fail/i.test(l)));
  });

  test('a non-string agentId is refused, writing nothing; usage and orchestrator are never caller fields', async () => {
    const [id = ''] = await f.ok('claim', 'solo');
    await f.ok('event', id, 'agent.started', 'role=builder', 'name=b');
    const before = await f.state();
    expect((await f.cli('event', id, 'agent.finished', 'role=builder', 'name=b', 'agentId=null')).err).toEqual(["field 'agentId' must be a string"]);
    expect((await f.cli('event', id, 'agent.finished', 'role=builder', 'name=b', 'usage=x')).err).toEqual(["agent.finished: extra field: unknown key 'usage'"]);
    expect((await f.cli('event', id, 'job.escalated', 'reason=x', 'orchestrator=x')).err).toEqual(["job.escalated: extra field: unknown key 'orchestrator'"]);
    expect(await f.state()).toEqual(before);
  });
});

describe('AC5: the orchestrator slice of a standalone job', () => {
  test('each stretch-ending event records its own window; job.json sums them; no session id is stored', async () => {
    const [id = ''] = await f.ok('claim', 'solo');
    await f.ok('event', id, 'stage.entered', 'stage=spec');
    await f.ok('event', id, 'agent.started', 'role=spec-writer');
    const t1 = await mark();
    await writeAgent(project(), 'sess-orch-7f3a', 'spw1', messageLines(msg('s1', t1, 1), 'sess-orch-7f3a'));
    const o1 = msg('o1', t1, 5);
    await writeSession(project(), 'sess-orch-7f3a', [userLine(t1, 'sess-orch-7f3a'), ...messageLines(o1, 'sess-orch-7f3a')]);
    await f.ok('event', id, 'agent.finished', 'role=spec-writer', 'agentId=spw1');
    await f.ok('event', id, 'job.escalated', 'reason=open question');
    expect(await lastEvent('jobs', id, 'events.jsonl')).toMatchObject({ type: 'job.escalated', orchestrator: counts(o1) });

    // Between the escalation and the rework: outside every stretch.
    await writeSession(project(), 'sess-orch-7f3a', messageLines(msg('o_idle', await mark(), 50), 'sess-orch-7f3a'));
    await f.ok('event', id, 'job.reworked', 'k=1', 'maxRound=2');
    const o2 = msg('o2', await mark(), 7);
    await writeSession(project(), 'sess-orch-7f3a', messageLines(o2, 'sess-orch-7f3a'));
    await f.ok('event', id, 'stage.entered', 'stage=build');
    await f.ok('event', id, 'round.started', 'round=1');
    await review(id, 1, 'PASS');
    await f.ok('event', id, 'agent.finished', 'role=reviewer', 'key=code', 'round=1');
    await f.ok('event', id, 'stage.entered', 'stage=approve');
    await f.ok('event', id, 'job.merged', 'sha=0123abc');
    expect(await lastEvent('jobs', id, 'events.jsonl')).toMatchObject({ type: 'job.merged', orchestrator: counts(o2) });

    const snap = await f.json('jobs', id, 'job.json');
    expect(snap.usage).toMatchObject({ orchestrator: { status: 'exact', input: 12, output: 120, cacheWrite: 1200, cacheRead: 12000, spans: 2, unknown: 0 } });
    for (const file of ['events.jsonl', 'job.json']) expect(await readFile(join(f.root, 'jobs', id, file), 'utf8')).not.toContain('sess-orch');
    const show = await f.ok('show', id);
    expect(show.find((l) => l.trimStart().startsWith('orchestrator'))).toMatch(/^ {2}orchestrator\s+= 13\.3k\s+12\s+120\s+1200\s+12000$/);
  });

  test('a job in an epic records no orchestrator slice', async () => {
    await f.start('auth', ['a']);
    const a = await f.claimMember('auth', 'a');
    await f.ok('event', a, 'stage.entered', 'stage=spec');
    await f.ok('event', a, 'agent.started', 'role=spec-writer');
    const t = await mark();
    await writeAgent(project(), 'sess-e', 'spwA', messageLines(msg('s', t, 1), 'sess-e'));
    await writeSession(project(), 'sess-e', messageLines(msg('o', t, 9), 'sess-e'));
    await f.ok('event', a, 'agent.finished', 'role=spec-writer', 'agentId=spwA');
    await f.ok('event', a, 'job.escalated', 'reason=q');
    expect(await lastEvent('jobs', a, 'events.jsonl')).not.toHaveProperty('orchestrator');
    expect((await f.json('jobs', a, 'job.json')).usage).toMatchObject({ orchestrator: null, job: { status: 'exact', input: 1, spans: 1 } });
  });
});

describe('AC6: the epic records one orchestrator figure', () => {
  test('waiting and landing end stretches on the epic log; epic.json and epic show carry the sum; members only their agents', async () => {
    await f.start('auth', ['a']);
    const a = await f.claimMember('auth', 'a');
    await f.ok('event', a, 'stage.entered', 'stage=spec');
    await f.ok('event', a, 'agent.started', 'role=spec-writer');
    const t1 = await mark();
    const agentMsg = msg('s', t1, 2);
    await writeAgent(project(), 'sess-epic', 'spwE', messageLines(agentMsg, 'sess-epic'));
    const e1 = msg('e1', t1, 4);
    await writeSession(project(), 'sess-epic', messageLines(e1, 'sess-epic'));
    await f.ok('event', a, 'agent.finished', 'role=spec-writer', 'agentId=spwE');
    await f.ok('epic', 'event', 'auth', 'epic.waiting', 'reason=checkout is on dev');
    expect(await lastEvent('jobs', 'epics', 'auth', 'events.jsonl')).toMatchObject({ type: 'epic.waiting', orchestrator: counts(e1) });

    await writeSession(project(), 'sess-epic', messageLines(msg('idle', await mark(), 60), 'sess-epic'));
    await f.ok('epic', 'event', 'auth', 'epic.resumed');
    const e2 = msg('e2', await mark(), 6);
    await writeSession(project(), 'sess-epic', messageLines(e2, 'sess-epic'));
    await f.ok('event', a, 'stage.entered', 'stage=build');
    await f.ok('event', a, 'round.started', 'round=1');
    await review(a, 1, 'PASS');
    await f.ok('event', a, 'agent.finished', 'role=reviewer', 'key=code', 'round=1');
    await f.ok('event', a, 'stage.entered', 'stage=approve');
    await f.ok('event', a, 'job.merged', 'sha=0123abc');
    await f.ok('epic', 'event', 'auth', 'epic.landing');
    await f.ok('epic', 'event', 'auth', 'epic.landed', 'sha=0123456');
    expect(await lastEvent('jobs', 'epics', 'auth', 'events.jsonl')).toMatchObject({ type: 'epic.landed', orchestrator: counts(e2) });

    const epic = await f.json('jobs', 'epics', 'auth', 'epic.json');
    expect(epic.orchestrator).toEqual({ status: 'exact', input: 10, output: 100, cacheWrite: 1000, cacheRead: 10000, spans: 2, unknown: 0 });
    expect(await f.ok('epic', 'show', 'auth')).toContain('orchestrator usage: = 11.1k  (input 10, output 100, cache write 1000, cache read 10000)');
    const member = await f.json('jobs', a, 'job.json');
    expect(member.usage).toMatchObject({ orchestrator: null, job: { status: 'partial', input: 2, output: 20, cacheWrite: 200, cacheRead: 2000 } });
    for (const e of await f.lines('jobs', a, 'events.jsonl')) expect(e).not.toHaveProperty('orchestrator');
    expect(await readFile(join(f.root, 'jobs', 'epics', 'auth', 'events.jsonl'), 'utf8')).not.toContain('sess-epic');
  });
});
