import { describe, expect, test } from 'bun:test';
import type { EventInput, FactoryEvent, Session } from './contract';
import { project } from './project';

const BASE = Date.parse('2026-10-23T14:00:00.000Z');
const tsAt = (n: number): string => new Date(BASE + n * 60_000).toISOString();

// Stamp each input 1 minute after the previous one.
function log(inputs: EventInput[]): FactoryEvent[] {
  return inputs.map((e, i) => ({ ...e, ts: tsAt(i) }));
}

const claimed: EventInput = { type: 'job.claimed', schema: 'factory/v1', id: '019-example', maxRound: 2, brief: null, issue: 'M80' };
const REVIEWERS = ['security', 'ux', 'ui', 'code'];
const builder = (round?: number): EventInput[] => [
  { type: 'agent.started', role: 'builder', name: 'builder-019', ...(round ? { round } : {}) },
  { type: 'agent.finished', role: 'builder', name: 'builder-019', ...(round ? { round } : {}) },
];
const reviewer = (key: string, round: number, verdict: 'PASS' | 'CHANGES'): EventInput[] => [
  { type: 'agent.started', role: 'reviewer', key, round },
  { type: 'agent.finished', role: 'reviewer', key, round, verdict },
];

const twoRound: EventInput[] = [
  claimed,
  { type: 'stage.entered', stage: 'spec' },
  { type: 'job.titled', title: 'Example' },
  { type: 'stage.entered', stage: 'build' },
  ...builder(),
  { type: 'round.started', round: 1, reviewers: REVIEWERS },
  ...reviewer('security', 1, 'CHANGES'),
  ...reviewer('ux', 1, 'PASS'),
  ...reviewer('ui', 1, 'PASS'),
  ...reviewer('code', 1, 'PASS'),
  { type: 'stage.entered', stage: 'build' },
  ...builder(),
  { type: 'round.started', round: 2, reviewers: REVIEWERS },
  ...REVIEWERS.flatMap((k) => reviewer(k, 2, 'PASS')),
  { type: 'stage.entered', stage: 'approve' },
  { type: 'agent.started', role: 'approver' },
  { type: 'agent.finished', role: 'approver', verdict: 'APPROVE' },
  { type: 'job.merged', sha: 'abc123' },
];

describe('project', () => {
  test('throws unless the first event is job.claimed', () => {
    expect(() => project([])).toThrow();
    expect(() => project(log([{ type: 'job.noted', note: 'x' }]))).toThrow();
  });

  test('target comes from job.claimed; a log claimed before it existed projects null', () => {
    expect(project(log([{ ...claimed, target: 'master' }])).target).toBe('master');
    const legacy = project(log(twoRound));
    expect(legacy.target).toBeNull();
    expect(legacy.stage).toBe('merged'); // the transition rules are unchanged for a target-less log
  });

  test('a fresh claim has defaults', () => {
    const s = project(log([claimed]));
    expect(s).toMatchObject({
      schema: 'factory/v1', id: '019-example', title: '019-example', branch: 'factory/019-example',
      builder: null, stage: 'claimed', round: 0, maxRound: 2, reviews: {}, history: [], reworks: 0,
      decision: null, note: '', brief: null, issue: 'M80', startedAt: tsAt(0), stageEnteredAt: tsAt(0),
      endedAt: null, updated: tsAt(0), target: null,
    });
    expect(s.timing.stages).toEqual([{ stage: 'claimed', round: 0, enteredAt: tsAt(0), exitedAt: null, ms: null }]);
  });

  test('two-round happy path', () => {
    const events = log(twoRound);
    const s = project(events);
    const merged = events[events.length - 1];
    if (!merged) throw new Error('empty log');
    expect(s.stage).toBe('merged');
    expect(s.round).toBe(2);
    expect(s.title).toBe('Example');
    expect(s.builder).toBe('builder-019');
    expect(s.history).toEqual([{ round: 1, reviews: { security: 'CHANGES', ux: 'PASS', ui: 'PASS', code: 'PASS' } }]);
    expect(s.reviews).toEqual({ security: 'PASS', ux: 'PASS', ui: 'PASS', code: 'PASS' });
    expect(s.decision).toBe('APPROVE');
    expect(s.endedAt).toBe(merged.ts);
    expect(s.updated).toBe(merged.ts);
    expect(s.stageEnteredAt).toBe(merged.ts);
    expect(s.timing.stages.map((x) => x.stage)).toEqual([
      'claimed', 'spec', 'build', 'review', 'build', 'review', 'approve', 'merged',
    ]);
    expect(s.timing.stages.map((x) => x.round)).toEqual([0, 0, 0, 1, 1, 2, 2, 2]);
    for (const span of s.timing.stages.slice(0, -1)) {
      expect(span.exitedAt).not.toBeNull();
      expect(span.ms).toBe(Date.parse(span.exitedAt ?? '') - Date.parse(span.enteredAt));
    }
    const last = s.timing.stages[s.timing.stages.length - 1];
    expect(last?.exitedAt).toBeNull();
    expect(last?.ms).toBeNull();
  });

  test('round.started marks every listed reviewer pending', () => {
    const s = project(log([claimed, { type: 'stage.entered', stage: 'spec' }, { type: 'stage.entered', stage: 'build' },
      { type: 'round.started', round: 1, reviewers: REVIEWERS }, ...reviewer('ux', 1, 'PASS')]));
    expect(s.stage).toBe('review');
    expect(s.reviews).toEqual({ security: 'pending', ux: 'PASS', ui: 'pending', code: 'pending' });
    expect(s.history).toEqual([]);
  });

  test('parallel reviewers finishing out of order get per-key spans', () => {
    const inputs: EventInput[] = [
      claimed, { type: 'stage.entered', stage: 'spec' }, { type: 'stage.entered', stage: 'build' },
      { type: 'round.started', round: 1, reviewers: REVIEWERS },
      ...REVIEWERS.map((key): EventInput => ({ type: 'agent.started', role: 'reviewer', key, round: 1 })),
      { type: 'agent.finished', role: 'reviewer', key: 'ui', round: 1, verdict: 'PASS' },
      { type: 'agent.finished', role: 'reviewer', key: 'security', round: 1, verdict: 'CHANGES' },
      { type: 'agent.finished', role: 'reviewer', key: 'code', round: 1, verdict: 'PASS' },
      { type: 'agent.finished', role: 'reviewer', key: 'ux', round: 1, verdict: 'PASS' },
    ];
    const events = log(inputs);
    const s = project(events);
    expect(s.timing.agents).toHaveLength(4);
    const startIdx = events.findIndex((e) => e.type === 'agent.started');
    const finishAt: Record<string, number> = { ui: 4, security: 5, code: 6, ux: 7 };
    for (const [key, off] of Object.entries(finishAt)) {
      const span = s.timing.agents.find((a) => a.key === key);
      const startedMin = startIdx + REVIEWERS.indexOf(key);
      expect(span?.ms).toBe((startIdx + off - startedMin) * 60_000);
      expect(span?.startedAt).toBe(tsAt(startedMin));
      expect(span?.finishedAt).toBe(tsAt(startIdx + off));
    }
    expect(s.timing.agents.find((a) => a.key === 'security')?.verdict).toBe('CHANGES');
    expect(s.reviews).toEqual({ security: 'CHANGES', ux: 'PASS', ui: 'PASS', code: 'PASS' });
  });

  test('a resumed builder gets a second span, not one merged span', () => {
    const s = project(log(twoRound));
    const spans = s.timing.agents.filter((a) => a.role === 'builder');
    expect(spans).toHaveLength(2);
    expect(spans.every((a) => a.name === 'builder-019' && a.ms === 60_000)).toBe(true);
  });

  test('latest unmatched start is closed first', () => {
    const s = project(log([claimed,
      { type: 'agent.started', role: 'builder', name: 'b' },
      { type: 'agent.started', role: 'builder', name: 'b' },
      { type: 'agent.finished', role: 'builder', name: 'b' }]));
    expect(s.timing.agents.map((a) => a.finishedAt)).toEqual([null, tsAt(3)]);
  });

  test('builder is the latest builder name', () => {
    const s = project(log([claimed,
      { type: 'agent.started', role: 'builder', name: 'one' },
      { type: 'agent.started', role: 'builder', name: 'two' }]));
    expect(s.builder).toBe('two');
  });

  test('escalate, rework, round 3, human-approve, merge', () => {
    const inputs: EventInput[] = [
      claimed, { type: 'stage.entered', stage: 'spec' }, { type: 'stage.entered', stage: 'build' },
      { type: 'round.started', round: 1, reviewers: ['code'] },
      ...reviewer('code', 1, 'CHANGES'),
      { type: 'stage.entered', stage: 'build' },
      { type: 'round.started', round: 2, reviewers: ['code'] },
      ...reviewer('code', 2, 'PASS'),
      { type: 'stage.entered', stage: 'approve' },
      { type: 'agent.started', role: 'approver' },
      { type: 'agent.finished', role: 'approver', verdict: 'ESCALATE' },
      { type: 'job.escalated', reason: 'needs eyes' },
    ];
    const mid = project(log(inputs));
    expect(mid.stage).toBe('needs-human');
    expect(mid.decision).toBe('ESCALATE');

    const rest: EventInput[] = [
      { type: 'job.reworked', k: 1, maxRound: 3 },
      { type: 'round.started', round: 3, reviewers: ['code'] },
      ...reviewer('code', 3, 'PASS'),
      { type: 'stage.entered', stage: 'approve' },
      { type: 'job.escalated', reason: 'again' },
      { type: 'job.human-approved' },
      { type: 'job.merged', sha: 'deadbeef' },
    ];
    const reworkEvent: EventInput = { type: 'job.reworked', k: 1, maxRound: 3 };
    const reworked = project(log([...inputs, reworkEvent]));
    expect(reworked.stage).toBe('build');
    expect(reworked.decision).toBeNull();
    expect(reworked.reworks).toBe(1);
    expect(reworked.maxRound).toBe(3);
    expect(reworked.note).toBe('');

    const s = project(log([...inputs, ...rest]));
    expect(s.stage).toBe('merged');
    expect(s.round).toBe(3);
    expect(s.reworks).toBe(1);
    expect(s.maxRound).toBe(3);
    expect(s.decision).toBe('APPROVE (human)');
    expect(s.history.map((h) => h.round)).toEqual([1, 2]);
    expect(s.note).toBe('merged deadbeef');
  });

  test('job.merged records the merge sha in note', () => {
    const s = project(log(twoRound));
    expect(s.note).toBe('merged abc123');
  });

  test('a reviewer finish from another round does not touch the current round', () => {
    const toR2: EventInput[] = [
      claimed, { type: 'stage.entered', stage: 'spec' }, { type: 'stage.entered', stage: 'build' },
      { type: 'round.started', round: 1, reviewers: ['security', 'ux'] },
      ...reviewer('security', 1, 'PASS'), ...reviewer('ux', 1, 'CHANGES'),
      { type: 'stage.entered', stage: 'build' },
      { type: 'round.started', round: 2, reviewers: ['security', 'ux'] },
    ];
    const stale = project(log([...toR2, { type: 'agent.finished', role: 'reviewer', key: 'ux', round: 1, verdict: 'PASS' }]));
    expect(stale.reviews).toEqual({ security: 'pending', ux: 'pending' });
    expect(stale.history).toEqual([{ round: 1, reviews: { security: 'PASS', ux: 'CHANGES' } }]);
    const future = project(log([...toR2, { type: 'agent.finished', role: 'reviewer', key: 'ux', round: 3, verdict: 'PASS' }]));
    expect(future.reviews).toEqual({ security: 'pending', ux: 'pending' });
  });

  test('a reviewer finish for a key outside the current round adds no chip', () => {
    const s = project(log([claimed, { type: 'stage.entered', stage: 'spec' }, { type: 'stage.entered', stage: 'build' },
      { type: 'round.started', round: 1, reviewers: ['code'] },
      { type: 'agent.finished', role: 'reviewer', key: 'ux', round: 1, verdict: 'PASS' }]));
    expect(s.reviews).toEqual({ code: 'pending' });
    const inherited = project(log([claimed, { type: 'stage.entered', stage: 'spec' }, { type: 'stage.entered', stage: 'build' },
      { type: 'round.started', round: 1, reviewers: ['code'] },
      { type: 'agent.finished', role: 'reviewer', key: 'constructor', round: 1, verdict: 'PASS' }]));
    expect(Object.keys(inherited.reviews)).toEqual(['code']);
  });

  test('merge.failed straight from approve opens a needs-human span', () => {
    const events = log([claimed, { type: 'stage.entered', stage: 'spec' }, { type: 'stage.entered', stage: 'build' },
      { type: 'round.started', round: 1, reviewers: ['code'] }, ...reviewer('code', 1, 'PASS'),
      { type: 'stage.entered', stage: 'approve' }, { type: 'merge.failed', reason: 'conflict' }]);
    const s = project(events);
    const at = tsAt(events.length - 1);
    expect(s.stage).toBe('needs-human');
    expect(s.note).toBe('conflict');
    expect(s.stageEnteredAt).toBe(at);
    const spans = s.timing.stages;
    expect(spans.map((x) => x.stage).slice(-2)).toEqual(['approve', 'needs-human']);
    expect(spans[spans.length - 2]).toMatchObject({ exitedAt: at, ms: 60_000 });
    expect(spans[spans.length - 1]).toMatchObject({ enteredAt: at, exitedAt: null, ms: null });
  });

  test('an orphan finish (no matching start) is kept as a zero-length span', () => {
    const events = log([claimed, { type: 'agent.started', role: 'builder', name: 'a' },
      { type: 'agent.finished', role: 'builder', name: 'b' }]);
    const s = project(events);
    expect(s.timing.agents).toEqual([
      { role: 'builder', key: null, round: null, name: 'a', startedAt: tsAt(1), finishedAt: null, ms: null, verdict: null },
      { role: 'builder', key: null, round: null, name: 'b', startedAt: tsAt(2), finishedAt: tsAt(2), ms: 0, verdict: null },
    ]);
  });

  test('note and title are set from events; merge.failed does not open a new needs-human span', () => {
    const s = project(log([claimed, { type: 'job.noted', note: 'hello' }, { type: 'job.titled', title: 'T' },
      { type: 'stage.entered', stage: 'spec' }, { type: 'stage.entered', stage: 'build' },
      { type: 'round.started', round: 1, reviewers: ['code'] }, ...reviewer('code', 1, 'PASS'),
      { type: 'stage.entered', stage: 'approve' }, { type: 'job.escalated', reason: 'r' },
      { type: 'job.human-approved' }, { type: 'merge.failed', reason: 'conflict' }]));
    expect(s.note).toBe('conflict');
    expect(s.title).toBe('T');
    expect(s.stage).toBe('needs-human');
    expect(s.timing.stages.filter((x) => x.stage === 'needs-human')).toHaveLength(1);
  });

  test('job.escalated and merge.failed copy their reason into note', () => {
    const s = project(log([claimed, { type: 'job.noted', note: 'hello' }, { type: 'job.escalated', reason: 'stuck' }]));
    expect(s.note).toBe('stuck');
  });

  test('an early job.escalated closes every open agent span with a null verdict', () => {
    const events = log([claimed, { type: 'stage.entered', stage: 'spec' }, { type: 'stage.entered', stage: 'build' },
      ...builder(), { type: 'round.started', round: 1, reviewers: ['security', 'ux'] },
      { type: 'agent.started', role: 'reviewer', key: 'security', round: 1 },
      { type: 'agent.started', role: 'reviewer', key: 'ux', round: 1 },
      { type: 'agent.finished', role: 'reviewer', key: 'security', round: 1, verdict: 'PASS' },
      { type: 'job.escalated', reason: 'ux wrote no file' }]);
    const s = project(events);
    const at = tsAt(events.length - 1);
    expect(s.stage).toBe('needs-human');
    expect(s.note).toBe('ux wrote no file');
    const ux = s.timing.agents.find((a) => a.key === 'ux');
    expect(ux).toMatchObject({ finishedAt: at, verdict: null, ms: 120_000 });
    expect(s.reviews).toEqual({ security: 'PASS', ux: 'pending' });
    expect(s.timing.agents.every((a) => a.finishedAt !== null)).toBe(true);
    expect(s.timing.agents.find((a) => a.key === 'security')?.finishedAt).toBe(tsAt(events.length - 2));
  });

  test('stageEnteredAt is the entering event ts; an open agent has null finish and ms', () => {
    const events = log([claimed, { type: 'stage.entered', stage: 'spec' }, { type: 'stage.entered', stage: 'build' },
      { type: 'job.noted', note: 'later' }, { type: 'agent.started', role: 'builder', name: 'b' }]);
    const s = project(events);
    expect(s.stageEnteredAt).toBe(tsAt(2));
    expect(s.updated).toBe(tsAt(4));
    expect(s.timing.agents).toEqual([
      { role: 'builder', key: null, round: null, name: 'b', startedAt: tsAt(4), finishedAt: null, ms: null, verdict: null },
    ]);
  });

  test('is pure: same input, same output, input not mutated', () => {
    const events = log(twoRound);
    const copy = JSON.stringify(events);
    expect(project(events)).toEqual(project(events));
    expect(JSON.stringify(events)).toBe(copy);
  });

  test('a fresh claim has stoppedBy and stoppedFrom null', () => {
    const s = project(log([claimed]));
    expect(s.stoppedBy).toBeNull();
    expect(s.stoppedFrom).toBeNull();
    expect(Object.keys(s)).toContain('stoppedBy');
    expect(Object.keys(s)).toContain('stoppedFrom');
  });
});

const toReview: EventInput[] = [
  claimed, { type: 'stage.entered', stage: 'spec' }, { type: 'stage.entered', stage: 'build' },
  { type: 'round.started', round: 1, reviewers: ['code'] },
];
const toApprove: EventInput[] = [...toReview, ...reviewer('code', 1, 'PASS'), { type: 'stage.entered', stage: 'approve' }];

describe('why a job stopped (stoppedBy / stoppedFrom)', () => {
  test('an escalation from review: escalated / review', () => {
    const s = project(log([...toReview, { type: 'job.escalated', reason: 'stuck' }]));
    expect(s).toMatchObject({ stage: 'needs-human', stoppedBy: 'escalated', stoppedFrom: 'review' });
  });

  test('an escalation from each working stage records that stage', () => {
    expect(project(log([claimed, { type: 'job.escalated', reason: 'r' }])).stoppedFrom).toBe('claimed');
    expect(project(log([claimed, { type: 'stage.entered', stage: 'spec' }, { type: 'job.escalated', reason: 'r' }])).stoppedFrom).toBe('spec');
    expect(project(log([...toReview.slice(0, 3), { type: 'job.escalated', reason: 'r' }])).stoppedFrom).toBe('build');
    expect(project(log([...toApprove, { type: 'job.escalated', reason: 'r' }])).stoppedFrom).toBe('approve');
  });

  test('approve then merge.failed: merge-failed / approve', () => {
    const s = project(log([...toApprove, { type: 'merge.failed', reason: 'conflict' }]));
    expect(s).toMatchObject({ stage: 'needs-human', stoppedBy: 'merge-failed', stoppedFrom: 'approve' });
  });

  test('a later human-approved then merge.failed: merge-failed, stoppedFrom unchanged', () => {
    const escalated = [...toReview, { type: 'job.escalated', reason: 'r' } satisfies EventInput];
    const s = project(log([...escalated, { type: 'job.human-approved' }, { type: 'merge.failed', reason: 'conflict' }]));
    expect(s).toMatchObject({ stage: 'needs-human', stoppedBy: 'merge-failed', stoppedFrom: 'review' });
    const approved = project(log([...escalated, { type: 'job.human-approved' }]));
    expect(approved).toMatchObject({ stoppedBy: 'escalated', stoppedFrom: 'review' });
  });

  test('job.reworked resets both to null', () => {
    const s = project(log([...toApprove, { type: 'merge.failed', reason: 'c' }, { type: 'job.reworked', k: 1, maxRound: 3 }]));
    expect(s).toMatchObject({ stage: 'build', stoppedBy: null, stoppedFrom: null });
  });

  test('a job that never entered needs-human has both null, merged or not', () => {
    for (const s of [project(log(toReview)), project(log(twoRound))]) {
      expect(s.stoppedBy).toBeNull();
      expect(s.stoppedFrom).toBeNull();
    }
  });

  test('job.merged after a human approve keeps them', () => {
    const s = project(log([...toApprove, { type: 'job.escalated', reason: 'r' }, { type: 'job.human-approved' }, { type: 'job.merged', sha: 'a' }]));
    expect(s).toMatchObject({ stage: 'merged', stoppedBy: 'escalated', stoppedFrom: 'approve' });
  });
});

describe('job.abandoned', () => {
  test('from needs-human: stage abandoned, endedAt and note from the event, spans closed', () => {
    const events = log([...toReview, { type: 'job.escalated', reason: 'stuck' }, { type: 'job.abandoned', reason: 'dead end' }]);
    const s = project(events);
    const at = tsAt(events.length - 1);
    expect(s).toMatchObject({ stage: 'abandoned', endedAt: at, note: 'dead end', stageEnteredAt: at, updated: at });
    expect(s).toMatchObject({ stoppedBy: 'escalated', stoppedFrom: 'review' }); // kept
    const spans = s.timing.stages;
    expect(spans.map((x) => x.stage).slice(-2)).toEqual(['needs-human', 'abandoned']);
    expect(spans[spans.length - 2]).toMatchObject({ exitedAt: at, ms: 60_000 });
    expect(spans[spans.length - 1]).toMatchObject({ stage: 'abandoned', enteredAt: at, exitedAt: null, ms: null });
  });

  test('from build with an open builder span: every open agent span closes with a null verdict', () => {
    const events = log([...toReview.slice(0, 3), { type: 'agent.started', role: 'builder', name: 'builder-019' },
      { type: 'job.abandoned', reason: 'dead end' }]);
    const s = project(events);
    const at = tsAt(events.length - 1);
    expect(s).toMatchObject({ stage: 'abandoned', endedAt: at, note: 'dead end', stoppedBy: null, stoppedFrom: null });
    expect(s.timing.agents).toEqual([
      { role: 'builder', key: null, round: null, name: 'builder-019', startedAt: tsAt(3), finishedAt: at, ms: 60_000, verdict: null },
    ]);
    const spans = s.timing.stages;
    expect(spans.map((x) => x.stage).slice(-2)).toEqual(['build', 'abandoned']);
    expect(spans[spans.length - 2]).toMatchObject({ exitedAt: at, ms: 120_000 });
    expect(spans[spans.length - 1]).toMatchObject({ exitedAt: null, ms: null });
  });

  test('merge.failed and job.abandoned keep stoppedBy merge-failed', () => {
    const s = project(log([...toApprove, { type: 'merge.failed', reason: 'c' }, { type: 'job.abandoned', reason: 'x' }]));
    expect(s).toMatchObject({ stage: 'abandoned', stoppedBy: 'merge-failed', stoppedFrom: 'approve' });
  });
});

describe('session (latest wins)', () => {
  const A: Session = { app: 't3code', environment: 'env-1', thread: 'thread-A' };
  const B: Session = { app: 't3code', environment: 'env-2', thread: 'thread-B' };
  const toNeedsHuman: EventInput[] = [{ type: 'stage.entered', stage: 'spec' }, { type: 'job.escalated', reason: 'stuck' }];

  test('a claim with a session projects it; without one, null', () => {
    expect(project(log([{ ...claimed, session: A }])).session).toEqual(A);
    expect(project(log([claimed])).session).toBeNull();
    expect(project(log(twoRound)).session).toBeNull();
  });

  test('job.reworked with a session replaces it; without one keeps it; job.abandoned leaves it', () => {
    const base: EventInput[] = [{ ...claimed, session: A }, ...toNeedsHuman];
    expect(project(log([...base, { type: 'job.reworked', k: 1, maxRound: 3, session: B }])).session).toEqual(B);
    expect(project(log([...base, { type: 'job.reworked', k: 1, maxRound: 3 }])).session).toEqual(A);
    const abandoned = project(log([...base, { type: 'job.reworked', k: 1, maxRound: 3, session: B }, { type: 'job.escalated', reason: 'again' }, { type: 'job.abandoned', reason: 'done' }]));
    expect(abandoned.stage).toBe('abandoned');
    expect(abandoned.session).toEqual(B);
  });

  test('job.human-approved with a session replaces it; without one keeps it', () => {
    const base: EventInput[] = [{ ...claimed, session: A }, ...toNeedsHuman];
    expect(project(log([...base, { type: 'job.human-approved', session: B }])).session).toEqual(B);
    expect(project(log([...base, { type: 'job.human-approved' }])).session).toEqual(A);
    expect(project(log([...base, { type: 'job.human-approved', session: B }, { type: 'job.human-approved' }, { type: 'job.abandoned', reason: 'x' }])).session).toEqual(B);
    // a session first recorded after a claim without one
    expect(project(log([claimed, ...toNeedsHuman, { type: 'job.human-approved', session: B }])).session).toEqual(B);
  });

  test('a stored session that is not well-formed is ignored, not fatal', () => {
    expect(project(log([{ ...claimed, session: { ...A, environment: '' } }])).session).toBeNull();
    expect(project([...log([{ ...claimed, session: A }, ...toNeedsHuman]), { type: 'job.human-approved', session: { ...B, thread: '../x' }, ts: tsAt(9) }]).session).toEqual(A);
  });
});

describe('merge.conflicted and conflicts (job 051)', () => {
  const conflicted = (reason = 'conflict in a.ts'): EventInput => ({ type: 'merge.conflicted', reason });
  const A: Session = { app: 't3code', environment: 'env-1', thread: 'thread-A' };

  test('a log without the event projects conflicts 0, and JobSnapshot always has the key', () => {
    for (const s of [project(log([claimed])), project(log(twoRound)), project(log(toApprove))]) {
      expect(s.conflicts).toBe(0);
      expect(Object.keys(s)).toContain('conflicts');
    }
  });

  test('from approve at round r: build, maxRound r + 2, conflicts + 1, note, decision null; the rest unchanged', () => {
    const before = project(log([...toApprove, { type: 'agent.started', role: 'approver' }, { type: 'agent.finished', role: 'approver', verdict: 'APPROVE' }]));
    expect(before.decision).toBe('APPROVE');
    const events = log([...toApprove, { type: 'agent.started', role: 'approver' }, { type: 'agent.finished', role: 'approver', verdict: 'APPROVE' }, conflicted('x')]);
    const s = project(events);
    const at = tsAt(events.length - 1);
    expect(s).toMatchObject({
      stage: 'build', round: 1, maxRound: 3, conflicts: 1, note: 'x', decision: null,
      stoppedBy: before.stoppedBy, stoppedFrom: before.stoppedFrom, reworks: before.reworks, session: before.session,
      stageEnteredAt: at, updated: at,
    });
    expect(s.timing.stages.map((x) => x.stage).slice(-2)).toEqual(['approve', 'build']);
    expect(s.timing.agents).toEqual(before.timing.agents); // no span opened or closed
  });

  test('from needs-human after a human approval: stoppedBy, stoppedFrom, reworks, session unchanged', () => {
    const prior: EventInput[] = [{ ...claimed, session: A }, ...toApprove.slice(1), { type: 'job.escalated', reason: 'r' }, { type: 'job.human-approved' }];
    const before = project(log(prior));
    const s = project(log([...prior, conflicted('y')]));
    expect(before).toMatchObject({ stage: 'needs-human', decision: 'APPROVE (human)', stoppedBy: 'escalated', stoppedFrom: 'approve', session: A });
    expect(s).toMatchObject({ stage: 'build', maxRound: 3, conflicts: 1, note: 'y', decision: null, stoppedBy: 'escalated', stoppedFrom: 'approve', reworks: 0, session: A });
    expect(s.timing.stages.map((x) => x.stage).slice(-2)).toEqual(['needs-human', 'build']);
  });

  test('keeps an open agent span open (no agent runs during a merge)', () => {
    const s = project(log([...toApprove, { type: 'agent.started', role: 'builder', name: 'builder-019' }, conflicted()]));
    expect(s.timing.agents.at(-1)).toMatchObject({ role: 'builder', finishedAt: null, ms: null });
  });

  test('counts every merge.conflicted: a second one from round r + 2 gives maxRound r + 4', () => {
    const again: EventInput[] = [
      ...toApprove, conflicted('one'),
      { type: 'round.started', round: 2, reviewers: ['code'] }, ...reviewer('code', 2, 'CHANGES'), { type: 'stage.entered', stage: 'build' },
      { type: 'round.started', round: 3, reviewers: ['code'] }, ...reviewer('code', 3, 'PASS'), { type: 'stage.entered', stage: 'approve' },
      conflicted('two'),
    ];
    expect(project(log(again))).toMatchObject({ stage: 'build', round: 3, maxRound: 5, conflicts: 2, note: 'two' });
    expect(project(log([...again, { type: 'job.escalated', reason: 'r' }, { type: 'job.reworked', k: 1, maxRound: 6 }]))).toMatchObject({ conflicts: 2, reworks: 1 });
  });
});
