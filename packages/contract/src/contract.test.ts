import { describe, expect, test } from 'bun:test';
import { type EventInput, type FactoryEvent, checkTransition, parseConfig, parseEventInput } from './contract';

const shipped: unknown = await Bun.file(new URL('./fixtures/config.json', import.meta.url)).json();
const base = { schema: 'factory/v1', reviewers: ['security', 'ux'], maxRound: 2, dashboard: { settleAfterHours: 24 } };

describe('parseConfig', () => {
  test('accepts the shipped config', () => {
    expect(parseConfig(shipped).reviewers).toEqual(['security', 'code', 'contract', 'ui']);
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

describe('parseConfig: gate', () => {
  test('accepts an ordered gate, and a config without one', () => {
    expect(parseConfig({ ...base, gate: ['bun test', 'tsc --noEmit'] }).gate).toEqual(['bun test', 'tsc --noEmit']);
    const none = parseConfig(base);
    expect(none.gate).toBeUndefined();
    expect('gate' in none).toBe(false);
  });

  test('rejects a malformed gate with a one-line reason', () => {
    for (const gate of [[], [''], ['  '], 'bun test', ['bun test', 1], [null], {}, null]) {
      let message = '';
      try {
        parseConfig({ ...base, gate });
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toMatch(/^config: gate/);
      expect(message).not.toContain('\n');
    }
  });

  test('still rejects unknown keys alongside a gate', () => {
    expect(() => parseConfig({ ...base, gate: ['bun test'], gates: ['x'] })).toThrow(/'gates'/);
  });
});

describe('parseConfig: roles', () => {
  const withCode = { ...base, reviewers: ['code', 'ux'] };
  const message = (raw: unknown): string => {
    try {
      parseConfig(raw);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
    return '';
  };

  test('accepts roles for fixed roles and configured reviewer keys', () => {
    const roles = { builder: { runner: 'claude', model: 'sonnet' }, code: { runner: 'claude' } };
    expect(parseConfig({ ...withCode, roles }).roles).toEqual({
      builder: { runner: 'claude', model: 'sonnet' },
      code: { runner: 'claude' },
    });
    const none = parseConfig(withCode);
    expect('roles' in none).toBe(false);
  });

  test('accepts an empty roles object and pattern-valid models', () => {
    expect(parseConfig({ ...withCode, roles: {} }).roles).toEqual({});
    for (const model of ['opus', 'claude-sonnet-4-5', 'claude-opus-4-1[1m]', 'gpt-5.1:high', 'A_b']) {
      expect(parseConfig({ ...withCode, roles: { approver: { runner: 'claude', model } } }).roles).toEqual({
        approver: { runner: 'claude', model },
      });
    }
  });

  test('rejects malformed roles with a one-line config: reason naming the role', () => {
    const cases: Array<[unknown, RegExp]> = [
      [[], /^config: roles must be an object/],
      ['builder', /^config: roles must be an object/],
      [null, /^config: roles must be an object/],
      [{ reviewer: { runner: 'claude' } }, /^config: roles\.reviewer: unknown role/],
      [{ security: { runner: 'claude' } }, /^config: roles\.security: unknown role/],
      [{ builder: 'claude' }, /^config: roles\.builder: must be an object/],
      [{ builder: { runner: 'claude', tools: 'x' } }, /^config: roles\.builder: unknown key 'tools'/],
      [{ builder: {} }, /^config: roles\.builder: runner is required/],
      [{ builder: { model: 'sonnet' } }, /^config: roles\.builder: runner is required/],
      [{ code: { runner: 'codex' } }, /^config: roles\.code: runner must be "claude"/],
      [{ code: { runner: 1 } }, /^config: roles\.code: runner must be "claude"/],
      [{ builder: { runner: 'claude', model: '' } }, /^config: roles\.builder: model/],
      [{ builder: { runner: 'claude', model: 'son net' } }, /^config: roles\.builder: model/],
      [{ builder: { runner: 'claude', model: 'sonnet\nx: y' } }, /^config: roles\.builder: model/],
      [{ builder: { runner: 'claude', model: 'sonnet#x' } }, /^config: roles\.builder: model/],
      [{ builder: { runner: 'claude', model: '-sonnet' } }, /^config: roles\.builder: model/],
      [{ builder: { runner: 'claude', model: 3 } }, /^config: roles\.builder: model/],
    ];
    for (const [roles, want] of cases) {
      const m = message({ ...withCode, roles });
      expect(m).toMatch(want);
      expect(m).not.toContain('\n');
    }
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
      type: 'round.started', round: 1, reviewers: ['security', 'code', 'contract', 'ui'],
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
