import { describe, expect, test } from 'bun:test';
import type { EventInput, FactoryEvent } from './contract';
import { project } from './project';
import { compactTokens, formatShow, usageSummary } from './show';

const BASE = Date.parse('2026-10-23T14:00:00.000Z');
const log = (inputs: EventInput[]): FactoryEvent[] =>
  inputs.map((e, i) => ({ ...e, ts: new Date(BASE + i * 60_000).toISOString() }));
const claimed: EventInput = { type: 'job.claimed', schema: 'factory/v1', id: '019-x', maxRound: 2, brief: null, issue: null };
const toApprove: EventInput[] = [
  claimed, { type: 'stage.entered', stage: 'spec' }, { type: 'job.titled', title: 'X' },
  { type: 'stage.entered', stage: 'build' }, { type: 'round.started', round: 1, reviewers: ['code'] },
  { type: 'agent.started', role: 'reviewer', key: 'code', round: 1 },
  { type: 'agent.finished', role: 'reviewer', key: 'code', round: 1, verdict: 'PASS' },
  { type: 'stage.entered', stage: 'approve' },
];
const later = new Date(BASE + 3_600_000);

describe('formatShow', () => {
  test('the terminal merged stage is never shown as running', () => {
    const out = formatShow(project(log([...toApprove, { type: 'job.merged', sha: 'abc' }])), later);
    const merged = out.find((l) => l.startsWith('stage  merged'));
    expect(merged).toBe('stage  merged r1');
    expect(out.join('\n')).not.toContain('running');
  });
  test('open stages and agents show running time; closed ones their duration and verdict', () => {
    const out = formatShow(project(log([...toApprove, { type: 'agent.started', role: 'approver' }])), later);
    expect(out[0]).toBe('019-x  approve  X');
    expect(out).toContain('stage  review r1  3m 0s');
    expect(out).toContain('agent  reviewer code r1  1m 0s  PASS');
    expect(out.find((l) => l.startsWith('stage  approve'))).toMatch(/running/);
    expect(out.find((l) => l.startsWith('agent  approver'))).toMatch(/running/);
  });
});

describe('formatShow: abandoned', () => {
  test('the terminal abandoned stage is never shown as running, from needs-human', () => {
    const out = formatShow(project(log([...toApprove, { type: 'job.escalated', reason: 'r' }, { type: 'job.abandoned', reason: 'dead end' }])), later);
    expect(out[0]).toBe('019-x  abandoned  X');
    expect(out.find((l) => l.startsWith('stage  abandoned'))).toBe('stage  abandoned r1');
    expect(out.join('\n')).not.toContain('running');
  });
  test('from build with an open builder, nothing is shown as running', () => {
    const toBuild = toApprove.slice(0, 4);
    const out = formatShow(project(log([...toBuild, { type: 'agent.started', role: 'builder', name: 'b' }, { type: 'job.abandoned', reason: 'dead end' }])), later);
    expect(out).toContain('stage  abandoned');
    expect(out).toContain('agent  builder b  1m 0s');
    expect(out.join('\n')).not.toContain('running');
  });
});

describe('formatShow: the usage table (AC7)', () => {
  const c = (n: number) => ({ model: 'claude-opus-4-5', input: n, output: n * 10, cacheWrite: n * 100, cacheRead: n * 1000 });
  const withUsage: EventInput[] = [
    claimed, { type: 'stage.entered', stage: 'spec' }, { type: 'job.titled', title: 'X' },
    { type: 'agent.started', role: 'spec-writer' },
    { type: 'agent.finished', role: 'spec-writer', agentId: 'sp1', usage: c(1) },
    { type: 'stage.entered', stage: 'build' },
    { type: 'agent.started', role: 'builder', name: 'builder-019-x' },
    { type: 'agent.finished', role: 'builder', name: 'builder-019-x', agentId: 'b1', usage: c(1000) },
    { type: 'round.started', round: 1, reviewers: ['code'] },
    { type: 'agent.started', role: 'reviewer', key: 'code', round: 1 },
    { type: 'agent.finished', role: 'reviewer', key: 'code', round: 1, verdict: 'PASS', usage: { unavailable: 'no agentId on agent.finished' } },
    { type: 'stage.entered', stage: 'approve' },
    { type: 'job.merged', sha: 'abc', orchestrator: c(100) },
  ];

  test('a row per span, totals per stage, round, and job, and an orchestrator line; partial totals are lower bounds', () => {
    const out = formatShow(project(log(withUsage)), later);
    const start = out.indexOf('usage');
    expect(start).toBeGreaterThan(0);
    const table = out.slice(start + 1).map((l) => l.trim().split(/\s{2,}/));
    expect(table).toEqual([
      ['role', 'key', 'round', 'model', 'input', 'output', 'cache write', 'cache read'],
      ['spec-writer', '-', '-', 'claude-opus-4-5', '1', '10', '100', '1000'],
      ['builder', '-', '-', 'claude-opus-4-5', '1000', '10000', '100000', '1000000'],
      ['reviewer', 'code', '1', 'unavailable: no agentId on agent.finished', '-', '-', '-', '-'],
      ['stage spec', '= 1.1k', '1', '10', '100', '1000'],
      ['stage build', '= 1.1M', '1000', '10000', '100000', '1000000'],
      ['stage review', 'unavailable (1 span)', '-', '-', '-', '-'],
      ['round 0', '= 1.1M', '1001', '10010', '100100', '1001000'],
      ['round 1', 'unavailable (1 span)', '-', '-', '-', '-'],
      ['orchestrator', '= 111.1k', '100', '1000', '10000', '100000'],
      ['job', '≥ 1.2M, 1 span unknown', '≥ 1101', '≥ 11010', '≥ 110100', '≥ 1101000'],
    ]);
  });

  test('a running span, a not-recorded span, and a job in an epic', () => {
    const inEpic: EventInput = { ...claimed, epic: 'auth', kind: 'member' };
    const out = formatShow(project(log([inEpic, { type: 'agent.started', role: 'spec-writer' }, { type: 'agent.finished', role: 'spec-writer' }, { type: 'agent.started', role: 'builder', name: 'b' }])), later);
    const rows = out.slice(out.indexOf('usage') + 1).map((l) => l.trim().split(/\s{2,}/));
    expect(rows).toContainEqual(['spec-writer', '-', '-', 'not recorded', '-', '-', '-', '-']);
    expect(rows).toContainEqual(['builder', '-', '-', 'running', '-', '-', '-', '-']);
    expect(rows).toContainEqual(['orchestrator', 'in epic auth (epic show)']);
    expect(rows).toContainEqual(['job', 'not recorded', '-', '-', '-', '-']);
  });

  test('no table before any agent span or ended stretch', () => {
    expect(formatShow(project(log([claimed])), later)).not.toContain('usage');
  });
});

describe('compactTokens / usageSummary', () => {
  test('short forms and the four statuses', () => {
    expect([950, 1000, 12_345, 999_949, 999_950, 1_234_567].map(compactTokens)).toEqual(['950', '1.0k', '12.3k', '999.9k', '1.0M', '1.2M']);
    const t = { input: 1_000_000, output: 200_000, cacheWrite: 0, cacheRead: 0 };
    expect(usageSummary({ ...t, status: 'exact', spans: 2, unknown: 0 })).toBe('= 1.2M');
    expect(usageSummary({ ...t, status: 'partial', spans: 2, unknown: 1 })).toBe('≥ 1.2M, 1 span unknown');
    expect(usageSummary({ ...t, status: 'partial', spans: 4, unknown: 2 }, ['stretch', 'stretches'])).toBe('≥ 1.2M, 2 stretches unknown');
    expect(usageSummary({ ...t, status: 'unavailable', spans: 2, unknown: 2 })).toBe('unavailable (2 spans)');
    expect(usageSummary({ ...t, status: 'not recorded', spans: 2, unknown: 2 })).toBe('not recorded');
  });
});
