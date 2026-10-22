import { describe, expect, test } from 'bun:test';
import { type EventInput, type FactoryEvent, checkTransition, parseConfig, parseEventInput } from './contract';

const shipped: unknown = await Bun.file(new URL('../config.json', import.meta.url)).json();
const base = { schema: 'factory/v1', reviewers: ['security', 'ux'], maxRound: 2, dashboard: { settleAfterHours: 24 } };

describe('parseConfig', () => {
  test('accepts the shipped config', () => {
    expect(parseConfig(shipped).reviewers).toEqual(['security', 'ux', 'ui', 'code']);
  });
  test('rejects violations', () => {
    expect(() => parseConfig({ ...base, reviewers: [] })).toThrow();
    expect(() => parseConfig({ reviewers: [] })).toThrow();
    expect(() => parseConfig({ ...base, reviewers: ['builder'] })).toThrow(/reserved/);
    expect(() => parseConfig({ ...base, reviewers: ['ux', 'ux'] })).toThrow(/duplicate/);
    expect(() => parseConfig({ ...base, reviewers: ['UX'] })).toThrow();
    expect(() => parseConfig({ ...base, foo: 1 })).toThrow(/foo/);
    expect(() => parseConfig({ ...base, maxRound: 0 })).toThrow();
    expect(() => parseConfig({ ...base, dashboard: { settleAfterHours: -1 } })).toThrow();
    expect(() => parseConfig({ ...base, dashboard: { settleAfterHours: 1, x: 1 } })).toThrow();
    expect(() => parseConfig(null)).toThrow();
  });
});

describe('parseEventInput', () => {
  test('accepts valid input', () => {
    expect(parseEventInput('agent.finished', { role: 'reviewer', key: 'ux', round: 1 })).toEqual({
      type: 'agent.finished', role: 'reviewer', key: 'ux', round: 1,
    });
    expect(parseEventInput('stage.entered', { stage: 'build' })).toEqual({ type: 'stage.entered', stage: 'build' });
  });
  test('rejects bad input', () => {
    expect(() => parseEventInput('stage.entered', { stage: 'merged' })).toThrow();
    expect(() => parseEventInput('job.exploded', {})).toThrow(/unknown/);
    expect(() => parseEventInput('job.noted', {})).toThrow(/note/);
    expect(() => parseEventInput('job.noted', { note: 'x', extra: 1 })).toThrow(/extra/);
    expect(() => parseEventInput('agent.finished', { role: 'reviewer', key: 'ux', round: 1, verdict: 'PASS' })).toThrow(/verdict/);
    expect(() => parseEventInput('agent.started', { role: 'reviewer', round: 1 })).toThrow(/key/);
    expect(() => parseEventInput('round.started', { round: 1, reviewers: [] })).toThrow();
  });
  test('job.claimed takes brief/issue/maxRound from the caller, id/schema from ctx', () => {
    const ctx = { id: '019-x', config: parseConfig(shipped) };
    expect(parseEventInput('job.claimed', { issue: 'M1' }, ctx)).toEqual({
      type: 'job.claimed', schema: 'factory/v1', id: '019-x', maxRound: 2, brief: null, issue: 'M1',
    });
    expect(() => parseEventInput('job.claimed', {}, undefined)).toThrow();
    expect(() => parseEventInput('job.claimed', { id: 'x' }, ctx)).toThrow(/id/);
  });
  test('round.started fills reviewers from config when omitted', () => {
    const ctx = { id: '019-x', config: parseConfig(shipped) };
    expect(parseEventInput('round.started', { round: 1 }, ctx)).toEqual({
      type: 'round.started', round: 1, reviewers: ['security', 'ux', 'ui', 'code'],
    });
    expect(parseEventInput('round.started', { round: 1, reviewers: ['ux'] }, ctx)).toEqual({
      type: 'round.started', round: 1, reviewers: ['ux'],
    });
    expect(() => parseEventInput('round.started', { round: 1 })).toThrow(/reviewers/);
  });
});

let n = 0;
const at = (e: EventInput): FactoryEvent => ({ ...e, ts: `2026-10-23T00:00:${String(n++).padStart(2, '0')}.000Z` });
const claimed: EventInput = { type: 'job.claimed', schema: 'factory/v1', id: '019-x', maxRound: 2, brief: null, issue: null };
const log = (...e: EventInput[]) => e.map(at);
const toBuild = log(claimed, { type: 'stage.entered', stage: 'spec' }, { type: 'stage.entered', stage: 'build' });
const round1: EventInput = { type: 'round.started', round: 1, reviewers: ['security', 'ux'] };
const fin = (key: string, verdict: 'PASS' | 'CHANGES', round = 1): EventInput =>
  ({ type: 'agent.finished', role: 'reviewer', key, round, verdict });

describe('checkTransition', () => {
  test('claim rules', () => {
    expect(() => checkTransition([], claimed)).not.toThrow();
    expect(() => checkTransition([], { type: 'stage.entered', stage: 'spec' })).toThrow();
    expect(() => checkTransition(log(claimed), claimed)).toThrow();
  });
  test('linear stages', () => {
    expect(() => checkTransition(log(claimed), { type: 'stage.entered', stage: 'spec' })).not.toThrow();
    expect(() => checkTransition(log(claimed), { type: 'stage.entered', stage: 'build' })).toThrow();
    expect(() => checkTransition(toBuild, round1)).not.toThrow();
    expect(() => checkTransition(toBuild, { ...round1, round: 2 })).toThrow(/previous/);
  });
  test('WAIT FOR ALL', () => {
    const l = [...toBuild, ...log(round1, { type: 'agent.finished', role: 'reviewer', key: 'security', round: 1, verdict: 'PASS' })];
    expect(() => checkTransition(l, { type: 'stage.entered', stage: 'approve' })).toThrow(/ux/);
    const l2 = [...l, ...log(fin('ux', 'CHANGES'))];
    expect(() => checkTransition(l2, { type: 'stage.entered', stage: 'approve' })).not.toThrow();
    expect(() => checkTransition(l2, { type: 'stage.entered', stage: 'build' })).not.toThrow();
  });
  test('round budget', () => {
    const r1 = [...toBuild, ...log(round1, fin('security', 'PASS'), fin('ux', 'PASS'), { type: 'stage.entered', stage: 'build' })];
    const r2 = [...r1, ...log({ ...round1, round: 2 }, fin('security', 'PASS', 2), fin('ux', 'PASS', 2))];
    expect(() => checkTransition(r2, { type: 'stage.entered', stage: 'build' })).toThrow(/maxRound/);
    expect(() => checkTransition(r2, { type: 'stage.entered', stage: 'approve' })).not.toThrow();
    expect(() => checkTransition(r1, { ...round1, round: 3 })).toThrow(/previous/);
    expect(() => checkTransition(r1, { ...round1, round: 2 })).not.toThrow();
  });
  test('terminal and human paths', () => {
    const approve = [...toBuild, ...log(round1, fin('security', 'PASS'), fin('ux', 'PASS'), { type: 'stage.entered', stage: 'approve' })];
    const merged = [...approve, ...log({ type: 'job.merged', sha: 'abc' })];
    expect(() => checkTransition(merged, { type: 'job.noted', note: 'x' })).toThrow(/merged/);
    expect(() => checkTransition(approve, { type: 'job.reworked', k: 1, maxRound: 2 })).toThrow();
    const human = [...approve, ...log({ type: 'job.escalated', reason: 'r' })];
    expect(() => checkTransition(human, { type: 'job.human-approved' })).not.toThrow();
    expect(() => checkTransition(human, { type: 'job.reworked', k: 1, maxRound: 3 })).not.toThrow();
    expect(() => checkTransition(human, { type: 'job.merged', sha: 'abc' })).toThrow();
    const ok = [...human, ...log({ type: 'job.human-approved' })];
    expect(() => checkTransition(ok, { type: 'job.merged', sha: 'abc' })).not.toThrow();
  });
  test('job.escalated from any working stage, not from needs-human or merged', () => {
    const esc: EventInput = { type: 'job.escalated', reason: 'r' };
    const spec = log(claimed, { type: 'stage.entered', stage: 'spec' });
    const review = [...toBuild, ...log(round1)];
    for (const l of [log(claimed), spec, toBuild, review]) expect(() => checkTransition(l, esc)).not.toThrow();
    const human = [...review, ...log(esc)];
    expect(() => checkTransition(human, esc)).toThrow(/needs-human/);
    const merged = [...human, ...log({ type: 'job.human-approved' }, { type: 'job.merged', sha: 'a' })];
    expect(() => checkTransition(merged, esc)).toThrow(/merged/);
  });
  test('rework after an early escalation leads to the next round', () => {
    const early = [...toBuild, ...log({ type: 'job.escalated', reason: 'r' }, { type: 'job.reworked', k: 1, maxRound: 2 })];
    expect(() => checkTransition(early, round1)).not.toThrow();
    const midReview = [...toBuild, ...log(round1, fin('security', 'PASS'), { type: 'job.escalated', reason: 'r' },
      { type: 'job.reworked', k: 1, maxRound: 3 })];
    expect(() => checkTransition(midReview, { ...round1, round: 2 })).not.toThrow();
  });
  test('human-approved again after a failed human merge', () => {
    const approve = [...toBuild, ...log(round1, fin('security', 'PASS'), fin('ux', 'PASS'), { type: 'stage.entered', stage: 'approve' })];
    const failed = [...approve, ...log({ type: 'job.escalated', reason: 'r' }, { type: 'job.human-approved' },
      { type: 'merge.failed', reason: 'conflict' })];
    expect(() => checkTransition(failed, { type: 'job.merged', sha: 'a' })).toThrow(/human-approved/);
    expect(() => checkTransition(failed, { type: 'job.human-approved' })).not.toThrow();
  });
  test('job.human-approved is idempotent while needs-human', () => {
    const approve = [...toBuild, ...log(round1, fin('security', 'PASS'), fin('ux', 'PASS'), { type: 'stage.entered', stage: 'approve' })];
    const ok = [...approve, ...log({ type: 'job.escalated', reason: 'r' }, { type: 'job.human-approved' })];
    expect(() => checkTransition(ok, { type: 'job.human-approved' })).not.toThrow();
    const twice = [...ok, ...log({ type: 'job.human-approved' })];
    expect(() => checkTransition(twice, { type: 'job.merged', sha: 'a' })).not.toThrow();
    expect(() => checkTransition(approve, { type: 'job.human-approved' })).toThrow(/approve/);
  });
  test('notes and agent events in any non-terminal stage, not before the claim', () => {
    expect(() => checkTransition(toBuild, { type: 'job.noted', note: 'x' })).not.toThrow();
    expect(() => checkTransition(toBuild, { type: 'agent.started', role: 'builder' })).not.toThrow();
    expect(() => checkTransition([], { type: 'job.noted', note: 'x' })).toThrow();
    expect(() => checkTransition(toBuild, { type: 'job.titled', title: 'T' })).not.toThrow();
  });
});
