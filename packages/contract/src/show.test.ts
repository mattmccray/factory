import { describe, expect, test } from 'bun:test';
import type { EventInput, FactoryEvent } from './contract';
import { project } from './project';
import { formatShow } from './show';

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
