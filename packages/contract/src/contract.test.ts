import { describe, expect, test } from 'bun:test';
import { type EventInput, type FactoryEvent, type Session, archiveEnabled, checkEpicSlug, checkTransition, epicMaxParallel, isSession, mergeTarget, parseConfig, parseEventInput, parseSession } from './contract';
import { project } from './project';

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

describe('parseConfig: name', () => {
  test('accepts a display name with spaces, punctuation, and non-ASCII, up to 64 code points', () => {
    const long = 'é'.repeat(63) + '😀'; // 64 code points, 65 UTF-16 units
    for (const name of ['Minerva Admin', 'Café — Ops (v2)!', long]) {
      expect(parseConfig({ ...base, name }).name).toBe(name);
    }
  });

  test('absent: the result has no name', () => {
    expect('name' in parseConfig(base)).toBe(false);
  });

  test('rejects an empty, overlong, padded, control-character, or non-string name with a one-line reason naming name', () => {
    for (const name of ['', 'x'.repeat(65), ' Lead', 'Trail ', 'a\nb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 42, null]) {
      let reason = '';
      try {
        parseConfig({ ...base, name });
      } catch (e) {
        reason = e instanceof Error ? e.message : String(e);
      }
      expect(reason).toMatch(/\bname\b/);
      expect(reason).not.toContain('\n');
    }
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

describe('parseConfig: merge (target branch)', () => {
  test('accepts no merge, an empty merge, current, and a branch name, with the effective target', () => {
    const cases: Array<[unknown, string]> = [
      [undefined, 'current'],
      [{}, 'current'],
      [{ target: 'current' }, 'current'],
      [{ target: 'develop' }, 'develop'],
      [{ target: 'release/2.0' }, 'release/2.0'],
    ];
    for (const [merge, want] of cases) {
      const config = parseConfig(merge === undefined ? base : { ...base, merge });
      expect(mergeTarget(config)).toBe(want);
    }
    expect('merge' in parseConfig(base)).toBe(false);
    expect(parseConfig({ ...base, merge: { target: 'develop' } }).merge).toEqual({ target: 'develop' });
  });

  test('rejects an unknown key, a non-object merge, or a bad target with a one-line config: reason', () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ target: 'main', squash: true }, /^config\.merge: unknown key 'squash'/],
      ['main', /^config: merge must be an object/],
      [[], /^config: merge must be an object/],
      [null, /^config: merge must be an object/],
      [{ target: '' }, /^config: merge\.target must be/],
      [{ target: '  ' }, /^config: merge\.target must be/],
      [{ target: 1 }, /^config: merge\.target must be/],
      [{ target: null }, /^config: merge\.target must be/],
      [{ target: ' develop' }, /^config: merge\.target " develop" is not an allowed branch name/],
      [{ target: "a'b" }, /is not an allowed branch name/],
      [{ target: 'x$(id)' }, /is not an allowed branch name/],
      [{ target: 'a;b' }, /is not an allowed branch name/],
      [{ target: 'a b' }, /is not an allowed branch name/],
      [{ target: '-x' }, /is not an allowed branch name/],
      [{ target: 'a..b' }, /is not an allowed branch name/],
      [{ target: 'topic.lock' }, /is not an allowed branch name/],
      [{ target: 'a/' }, /is not an allowed branch name/],
    ];
    for (const [merge, want] of cases) {
      let message = '';
      try {
        parseConfig({ ...base, merge });
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toMatch(want);
      expect(message).not.toContain('\n');
    }
  });
});

describe('parseConfig: archive (job 045, AC6)', () => {
  test('accepts enabled true and false; no archive key means off', () => {
    expect(parseConfig({ ...base, archive: { enabled: true } }).archive).toEqual({ enabled: true });
    expect(parseConfig({ ...base, archive: { enabled: false } }).archive).toEqual({ enabled: false });
    expect('archive' in parseConfig(base)).toBe(false);
    expect(archiveEnabled(parseConfig(base))).toBe(false);
    expect(archiveEnabled(parseConfig({ ...base, archive: { enabled: false } }))).toBe(false);
    expect(archiveEnabled(parseConfig({ ...base, archive: { enabled: true } }))).toBe(true);
  });

  test('rejects a non-object, a missing or non-boolean enabled, and an extra key, in one line', () => {
    const cases: Array<[unknown, RegExp]> = [
      [true, /^config: archive must be an object/],
      ['on', /^config: archive must be an object/],
      [[], /^config: archive must be an object/],
      [null, /^config: archive must be an object/],
      [{}, /^config: archive\.enabled must be true or false/],
      [{ enabled: 'true' }, /^config: archive\.enabled must be true or false/],
      [{ enabled: 1 }, /^config: archive\.enabled must be true or false/],
      [{ enabled: null }, /^config: archive\.enabled must be true or false/],
      [{ enabled: true, push: true }, /^config\.archive: unknown key 'push'/],
    ];
    for (const [archive, want] of cases) {
      let message = '';
      try {
        parseConfig({ ...base, archive });
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toMatch(want);
      expect(message).not.toContain('\n');
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
  test('job.claimed takes target from ctx only; a caller-supplied target is an extra field', () => {
    const ctx = { id: '019-x', config: parseConfig(shipped), target: 'master' };
    expect(parseEventInput('job.claimed', {}, ctx)).toEqual({
      type: 'job.claimed', schema: 'factory/v1', id: '019-x', maxRound: 2, brief: null, issue: null, target: 'master',
    });
    expect(() => parseEventInput('job.claimed', { target: 'develop' }, ctx)).toThrow(/extra field 'target'|unknown key 'target'/);
    expect('target' in parseEventInput('job.claimed', {}, { id: '019-x', config: parseConfig(shipped) })).toBe(false);
    expect(() => parseEventInput('job.claimed', {}, { ...ctx, target: "x'; rm -rf ~" })).toThrow(/not an allowed branch name/);
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

describe('job.abandoned', () => {
  const abandon: EventInput = { type: 'job.abandoned', reason: 'dead end' };
  const spec = log(claimed, { type: 'stage.entered', stage: 'spec' });
  const review = [...toBuild, ...log(round1)];
  const approve = [...toBuild, ...log(round1, fin('security', 'PASS'), fin('ux', 'PASS'), { type: 'stage.entered', stage: 'approve' })];
  const human = [...approve, ...log({ type: 'job.escalated', reason: 'r' })];
  const abandoned = [...human, ...log(abandon)];
  const merged = [...human, ...log({ type: 'job.human-approved' }, { type: 'job.merged', sha: 'a' })];

  test('parses a non-empty reason only, and no other field', () => {
    expect(parseEventInput('job.abandoned', { reason: 'dead end' })).toEqual(abandon);
    expect(() => parseEventInput('job.abandoned', {})).toThrow(/reason/);
    expect(() => parseEventInput('job.abandoned', { reason: '' })).toThrow(/reason/);
    expect(() => parseEventInput('job.abandoned', { reason: 'x', force: 'true' })).toThrow(/extra field/);
    expect(() => parseEventInput('job.abandoned', { reason: 'x', note: 'y' })).toThrow(/extra field/);
  });

  test('is accepted from needs-human without force', () => {
    expect(() => checkTransition(human, abandon)).not.toThrow();
    expect(() => checkTransition(human, abandon, { force: true })).not.toThrow();
  });

  test('from a working stage, needs force', () => {
    for (const l of [log(claimed), spec, toBuild, review, approve]) {
      expect(() => checkTransition(l, abandon)).toThrow(/force/);
      expect(() => checkTransition(l, abandon, { force: false })).toThrow(/force/);
      expect(() => checkTransition(l, abandon, { force: true })).not.toThrow();
    }
  });

  test('is never accepted from merged or abandoned, with or without force', () => {
    for (const l of [merged, abandoned]) {
      expect(() => checkTransition(l, abandon)).toThrow(/terminal/);
      expect(() => checkTransition(l, abandon, { force: true })).toThrow(/terminal/);
    }
  });

  test('before the claim, it is rejected', () => {
    expect(() => checkTransition([], abandon, { force: true })).toThrow(/job.claimed/);
  });

  test('once abandoned, every event type is rejected, with or without force', () => {
    const every: EventInput[] = [
      claimed, { type: 'job.titled', title: 'T' }, { type: 'stage.entered', stage: 'build' }, round1,
      { type: 'agent.started', role: 'builder' }, { type: 'agent.finished', role: 'builder' },
      { type: 'job.noted', note: 'x' }, { type: 'job.escalated', reason: 'r' },
      { type: 'job.reworked', k: 1, maxRound: 3 }, { type: 'job.human-approved' },
      { type: 'merge.failed', reason: 'r' }, { type: 'job.merged', sha: 'a' }, abandon,
    ];
    for (const e of every) {
      expect(() => checkTransition(abandoned, e)).toThrow(/abandoned \(terminal\)/);
      expect(() => checkTransition(abandoned, e, { force: true })).toThrow(/abandoned \(terminal\)/);
    }
  });

  test('force changes nothing for any other event', () => {
    expect(() => checkTransition(toBuild, { type: 'stage.entered', stage: 'approve' }, { force: true })).toThrow();
    expect(() => checkTransition(human, { type: 'job.merged', sha: 'a' }, { force: true })).toThrow();
  });
});

describe('session (parseSession and the three events)', () => {
  const config = parseConfig(base);
  const ctx = { id: '001-x', config };
  const A: Session = { app: 't3code', environment: 'env-1', thread: 'thread-A' };
  const id64 = 'a'.repeat(64);
  const MALFORMED = [
    'codex:env-1/thread-A', // another app
    'T3CODE:env-1/thread-A',
    'env-1/thread-A', // no ':'
    't3code:env-1', // no '/'
    't3code:/thread-A', // empty environment
    't3code:env-1/', // empty thread
    't3code:', // both empty
    `t3code:${'a'.repeat(65)}/thread-A`, // 65 characters
    `t3code:env-1/${'b'.repeat(65)}`,
    't3code:env-1/thread/A', // more than one '/'
    't3code:env.1/thread-A',
    't3code:env-1/thread_A',
    't3code:env 1/thread-A',
    't3code:env-1/thread-A ',
    't3code:env-1/thread:A',
    't3code:env-1/thréad',
    't3code:env-1/thread-A\nx',
  ];

  test('parses t3code:<environmentId>/<threadId>, ids up to 64 letters, digits, and -', () => {
    expect(parseSession('t3code:env-1/thread-A')).toEqual({ app: 't3code', environment: 'env-1', thread: 'thread-A' });
    expect(parseSession(`t3code:${id64}/${id64}`)).toEqual({ app: 't3code', environment: id64, thread: id64 });
    expect(parseSession('t3code:A/0')).toEqual({ app: 't3code', environment: 'A', thread: '0' });
  });

  test('refuses a malformed session with a one-line reason naming session', () => {
    for (const v of [...MALFORMED, null, 42, { app: 't3code' }]) {
      let reason = '';
      try {
        parseSession(v);
      } catch (e) {
        reason = e instanceof Error ? e.message : String(e);
      }
      expect(reason).toContain("'session'");
      expect(reason).not.toContain('\n');
    }
  });

  test('job.claimed, job.reworked, and job.human-approved take an optional session', () => {
    expect(parseEventInput('job.claimed', { session: 't3code:env-1/thread-A' }, ctx)).toMatchObject({ type: 'job.claimed', session: A });
    expect('session' in parseEventInput('job.claimed', {}, ctx)).toBe(false);
    expect(parseEventInput('job.reworked', { k: 1, maxRound: 3, session: 't3code:env-1/thread-A' })).toEqual({ type: 'job.reworked', k: 1, maxRound: 3, session: A });
    expect(parseEventInput('job.reworked', { k: 1, maxRound: 3 })).toEqual({ type: 'job.reworked', k: 1, maxRound: 3 });
    expect(parseEventInput('job.human-approved', { session: 't3code:env-1/thread-A' })).toEqual({ type: 'job.human-approved', session: A });
    expect(parseEventInput('job.human-approved', {})).toEqual({ type: 'job.human-approved' });
  });

  test('the three events refuse a malformed session', () => {
    for (const session of MALFORMED) {
      expect(() => parseEventInput('job.claimed', { session }, ctx)).toThrow(/session/);
      expect(() => parseEventInput('job.reworked', { k: 1, maxRound: 3, session })).toThrow(/session/);
      expect(() => parseEventInput('job.human-approved', { session })).toThrow(/session/);
    }
  });

  test('every other event refuses session as an extra field', () => {
    const session = 't3code:env-1/thread-A';
    const others: [string, Record<string, unknown>][] = [
      ['job.titled', { title: 't' }],
      ['stage.entered', { stage: 'spec' }],
      ['round.started', { round: 1, reviewers: ['ux'] }],
      ['agent.started', { role: 'builder' }],
      ['agent.finished', { role: 'builder' }],
      ['job.noted', { note: 'n' }],
      ['job.escalated', { reason: 'r' }],
      ['merge.failed', { reason: 'r' }],
      ['job.merged', { sha: 'abc' }],
      ['job.abandoned', { reason: 'r' }],
    ];
    for (const [type, fields] of others) {
      expect(() => parseEventInput(type, { ...fields, session }, ctx)).toThrow(/extra field.*'session'/);
    }
  });

  test('human-approved with a session stays idempotent while needs-human', () => {
    const prior: FactoryEvent[] = [
      { type: 'job.claimed', schema: 'factory/v1', id: '001-x', maxRound: 2, brief: null, issue: null, ts: 't0' },
      { type: 'job.escalated', reason: 'r', ts: 't1' },
      { type: 'job.human-approved', session: A, ts: 't2' },
    ];
    expect(() => checkTransition(prior, { type: 'job.human-approved', session: { app: 't3code', environment: 'e', thread: 'B' } })).not.toThrow();
  });

  test('isSession accepts only a well-formed stored session', () => {
    expect(isSession(A)).toBe(true);
    for (const v of [null, 'x', { ...A, app: 'codex' }, { ...A, thread: '' }, { ...A, thread: 'a/b' }, { app: 't3code', environment: 'e' }, { ...A, extra: 1 }]) {
      expect(isSession(v)).toBe(false);
    }
  });
});

describe('merge.conflicted (job 051)', () => {
  const conflicted: EventInput = { type: 'merge.conflicted', reason: 'conflict in a.ts' };
  const spec = log(claimed, { type: 'stage.entered', stage: 'spec' });
  const review = [...toBuild, ...log(round1)];
  const approve = [...toBuild, ...log(round1, fin('security', 'PASS'), fin('ux', 'PASS'), { type: 'stage.entered', stage: 'approve' })];
  const human = [...approve, ...log({ type: 'job.escalated', reason: 'r' })];
  const approved = [...human, ...log({ type: 'job.human-approved' })];
  const merged = [...approved, ...log({ type: 'job.merged', sha: 'a' })];
  const abandoned = [...human, ...log({ type: 'job.abandoned', reason: 'x' })];
  // From approve at round r: conflict, rounds r+1 and r+2, approve again.
  const resolved = (prior: FactoryEvent[], r: number): FactoryEvent[] => [
    ...prior, ...log(conflicted, { ...round1, round: r + 1 }, fin('security', 'PASS', r + 1), fin('ux', 'PASS', r + 1),
      { type: 'stage.entered', stage: 'approve' }),
  ];

  test('parses a non-empty reason only, like merge.failed', () => {
    expect(parseEventInput('merge.conflicted', { reason: 'conflict in a.ts' })).toEqual(conflicted);
    expect(() => parseEventInput('merge.conflicted', {})).toThrow(/reason/);
    expect(() => parseEventInput('merge.conflicted', { reason: '' })).toThrow(/reason/);
    for (const extra of ['maxRound', 'round', 'k', 'conflicts', 'session', 'target']) {
      expect(() => parseEventInput('merge.conflicted', { reason: 'x', [extra]: 1 })).toThrow(new RegExp(`extra field.*'${extra}'`));
    }
  });

  test('is accepted from approve, and from needs-human after job.human-approved', () => {
    expect(() => checkTransition(approve, conflicted)).not.toThrow();
    expect(() => checkTransition(approved, conflicted)).not.toThrow();
    const failedThenApproved = [...approve, ...log({ type: 'merge.failed', reason: 'refused' }, { type: 'job.human-approved' })];
    expect(() => checkTransition(failedThenApproved, conflicted)).not.toThrow();
  });

  test('is rejected from every other stage, and from needs-human without that approval', () => {
    for (const l of [log(claimed), spec, toBuild, review, human]) expect(() => checkTransition(l, conflicted)).toThrow(/not allowed from stage/);
    const failedAfterApproval = [...approved, ...log({ type: 'merge.failed', reason: 'refused' })];
    expect(() => checkTransition(failedAfterApproval, conflicted)).toThrow(/not allowed from stage 'needs-human'/);
    for (const l of [merged, abandoned]) expect(() => checkTransition(l, conflicted)).toThrow(/terminal/);
  });

  test('a third merge.conflicted is refused with one line naming merge.failed; merge.failed is still accepted', () => {
    const twice = resolved(resolved(approve, 1), 2);
    expect(() => checkTransition(twice, conflicted)).toThrow(/merge\.failed/);
    let reason = '';
    try {
      checkTransition(twice, conflicted);
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
    expect(reason).not.toContain('\n');
    expect(() => checkTransition(twice, { type: 'merge.failed', reason: 'third conflict' })).not.toThrow();
    // The limit holds from needs-human after a human approval too.
    const twiceHuman = [...twice, ...log({ type: 'job.escalated', reason: 'r' }, { type: 'job.human-approved' })];
    expect(() => checkTransition(twiceHuman, conflicted)).toThrow(/merge\.failed/);
    expect(() => checkTransition(twiceHuman, { type: 'merge.failed', reason: 'third conflict' })).not.toThrow();
    // One conflict leaves room for a second.
    expect(() => checkTransition(resolved(approve, 1), conflicted)).not.toThrow();
  });

  test('moves the job to build: the next round is r + 1, and build again is allowed up to round r + 2', () => {
    const back = [...approve, ...log(conflicted)]; // round 1, maxRound 2 -> maxRound 3
    expect(() => checkTransition(back, { ...round1, round: 3 })).toThrow(/previous \+ 1 \(2\)/);
    expect(() => checkTransition(back, { ...round1, round: 2 })).not.toThrow();
    const r2 = [...back, ...log({ ...round1, round: 2 }, fin('security', 'CHANGES', 2), fin('ux', 'PASS', 2))];
    expect(() => checkTransition(r2, { type: 'stage.entered', stage: 'build' })).not.toThrow();
    const r3 = [...r2, ...log({ type: 'stage.entered', stage: 'build' }, { ...round1, round: 3 }, fin('security', 'PASS', 3), fin('ux', 'PASS', 3))];
    expect(() => checkTransition(r3, { type: 'stage.entered', stage: 'build' })).toThrow(/maxRound 3/);
    expect(() => checkTransition(r3, { type: 'stage.entered', stage: 'approve' })).not.toThrow();
  });

  test('clears the human approval: a later needs-human merge needs a new job.human-approved', () => {
    const back = [...approved, ...log(conflicted, { ...round1, round: 2 }, { type: 'job.escalated', reason: 'approver escalated' })];
    expect(() => checkTransition(back, { type: 'job.merged', sha: 'a' })).toThrow(/human-approved/);
    expect(() => checkTransition(back, conflicted)).toThrow(/not allowed from stage 'needs-human'/);
    const again = [...back, ...log({ type: 'job.human-approved' })];
    expect(() => checkTransition(again, { type: 'job.merged', sha: 'a' })).not.toThrow();
  });

  test('a job sent back by a conflict can still escalate from build', () => {
    expect(() => checkTransition([...approve, ...log(conflicted)], { type: 'job.escalated', reason: 'r' })).not.toThrow();
  });
});

describe('epics (job 052)', () => {
  test('AC6: parseConfig accepts epic.maxParallel; no key or {} means 3; anything else is rejected', () => {
    expect(epicMaxParallel(parseConfig(base))).toBe(3);
    expect(parseConfig({ ...base, epic: {} }).epic).toEqual({});
    expect(epicMaxParallel(parseConfig({ ...base, epic: {} }))).toBe(3);
    expect(epicMaxParallel(parseConfig({ ...base, epic: { maxParallel: 5 } }))).toBe(5);
    expect(() => parseConfig({ ...base, epic: { maxParallel: 0 } })).toThrow('config: epic.maxParallel must be a positive integer');
    expect(() => parseConfig({ ...base, epic: { maxParallel: -2 } })).toThrow(/positive integer/);
    expect(() => parseConfig({ ...base, epic: { maxParallel: 1.5 } })).toThrow(/positive integer/);
    expect(() => parseConfig({ ...base, epic: { maxParallel: '2' } })).toThrow(/positive integer/);
    expect(() => parseConfig({ ...base, epic: { maxParallel: 2, conflictLimit: 3 } })).toThrow("config.epic: unknown key 'conflictLimit'");
    expect(() => parseConfig({ ...base, epic: 3 })).toThrow('config: epic must be an object { maxParallel? }');
    expect(() => parseConfig({ ...base, epic: null })).toThrow(/epic must be an object/);
  });

  test('an epic slug is a job slug that does not look like a job id', () => {
    expect(() => checkEpicSlug('auth-rework')).not.toThrow();
    expect(() => checkEpicSlug('052-epic')).toThrow(/must not look like a job id/);
    expect(() => checkEpicSlug('../x')).toThrow(/must match/);
    expect(() => checkEpicSlug('a'.repeat(41))).toThrow(/41 characters/);
  });

  const config = parseConfig(base);
  const claim = (fields: Record<string, unknown>, target?: string) => parseEventInput('job.claimed', fields, { id: '001-x', config, ...(target === undefined ? {} : { target }) });

  test('AC3: job.claimed records epic and kind (member by default)', () => {
    expect(claim({ epic: 'e', brief: 'factory/briefs/a.md' }, 'factory/epic/e')).toMatchObject({ epic: 'e', kind: 'member', brief: 'factory/briefs/a.md', target: 'factory/epic/e' });
    expect(claim({ epic: 'e', kind: 'member', brief: 'factory/briefs/a.md' })).toMatchObject({ epic: 'e', kind: 'member' });
    expect(claim({ epic: 'e', kind: 'sync' })).toMatchObject({ epic: 'e', kind: 'sync', brief: null });
    expect(claim({ epic: 'e', kind: 'fix' })).toMatchObject({ epic: 'e', kind: 'fix' });
    const plain = claim({});
    expect('epic' in plain || 'kind' in plain).toBe(false);
  });

  test('AC3: kind without epic, a brief on sync/fix, a member without a brief, a bad kind or slug, a foreign target', () => {
    expect(() => claim({ kind: 'sync' })).toThrow('job.claimed: kind=sync needs epic=<slug>');
    expect(() => claim({ epic: 'e', kind: 'sync', brief: 'factory/briefs/a.md' })).toThrow('job.claimed: a sync job takes no brief=');
    expect(() => claim({ epic: 'e', kind: 'fix', brief: 'factory/briefs/a.md' })).toThrow('job.claimed: a fix job takes no brief=');
    expect(() => claim({ epic: 'e' })).toThrow(/a member claim needs brief=/);
    expect(() => claim({ epic: 'e', kind: 'other' })).toThrow("field 'kind' must be one of member|sync|fix");
    expect(() => claim({ epic: '001-e', kind: 'sync' })).toThrow(/must not look like a job id/);
    expect(() => claim({ epic: 'e', kind: 'sync' }, 'main')).toThrow('job.claimed: a job in epic e targets factory/epic/e, not main');
    expect(() => claim({ epic: 'e', kind: 'sync', target: 'factory/epic/e' })).toThrow(/extra field/);
  });

  test('an epic event through the job path names epic event', () => {
    expect(() => parseEventInput('epic.waiting', { reason: 'r' })).toThrow('epic.waiting is an epic event, not a job event: run epic event <slug> epic.waiting …');
  });

  test('AC3: job.json has epic and kind; null for a standalone job and for logs written before them', () => {
    const ts = '2026-10-29T10:00:00.000Z';
    const old: FactoryEvent[] = [{ ts, type: 'job.claimed', schema: 'factory/v1', id: '001-x', maxRound: 2, brief: null, issue: null }];
    expect(project(old)).toMatchObject({ epic: null, kind: null });
    const member: FactoryEvent[] = [{ ts, ...claim({ epic: 'e', brief: 'factory/briefs/a.md' }) }];
    expect(project(member)).toMatchObject({ epic: 'e', kind: 'member' });
    const sync: FactoryEvent[] = [{ ts, ...claim({ epic: 'e', kind: 'sync' }) }];
    expect(project(sync)).toMatchObject({ epic: 'e', kind: 'sync' });
  });
});
