import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { landing, toEpic, toJob, toProjects } from './job';
import type { UsageTotal, WorkingStage } from './job';

describe('toJob: target', () => {
  test('reads a recorded target; null or absent is null', () => {
    expect(toJob({ id: '014-x', branch: 'factory/014-x', target: 'develop' })?.target).toBe('develop');
    expect(toJob({ id: '014-x', target: null })?.target).toBeNull();
    expect(toJob({ id: '014-x' })?.target).toBeNull();
    expect(toJob({ id: '014-x', target: 3 })?.target).toBeNull();
    expect(toJob({ id: '014-x', target: '' })?.target).toBeNull();
  });
});

describe('landing (the drawer branch line)', () => {
  test('shows factory/<id> → <target>, and nothing when the target is not recorded', () => {
    const at = (fields: Record<string, unknown>) => {
      const j = toJob({ id: '014-x', branch: 'factory/014-x', ...fields });
      if (j === null) throw new Error('no job');
      return landing(j);
    };
    expect(at({ target: 'develop' })).toBe('factory/014-x → develop');
    expect(at({ target: null })).toBeNull();
    expect(at({})).toBeNull();
    expect(at({ branch: undefined, target: 'master' })).toBe('factory/014-x → master');
  });
});

describe('toJob: stoppedBy and stoppedFrom (025 AC1)', () => {
  test('reads the contract values; a missing key or any other value is null', () => {
    expect(toJob({ id: '014-x', stoppedBy: 'escalated', stoppedFrom: 'review' })).toMatchObject({ stoppedBy: 'escalated', stoppedFrom: 'review' });
    expect(toJob({ id: '014-x', stoppedBy: 'merge-failed', stoppedFrom: 'approve' })).toMatchObject({ stoppedBy: 'merge-failed', stoppedFrom: 'approve' });
    const working: WorkingStage[] = ['claimed', 'spec', 'build', 'review', 'approve'];
    for (const stage of working) expect(toJob({ id: '014-x', stoppedFrom: stage })?.stoppedFrom).toBe(stage);
    expect(toJob({ id: '014-x' })).toMatchObject({ stoppedBy: null, stoppedFrom: null });
    expect(toJob({ id: '014-x', stoppedBy: null, stoppedFrom: null })).toMatchObject({ stoppedBy: null, stoppedFrom: null });
    for (const bad of ['', 'ESCALATED', 'abandoned', 3, true, {}, ['escalated']]) expect(toJob({ id: '014-x', stoppedBy: bad })?.stoppedBy).toBeNull();
    for (const bad of ['', 'needs-human', 'merged', 'abandoned', 'Review', 2, {}]) expect(toJob({ id: '014-x', stoppedFrom: bad })?.stoppedFrom).toBeNull();
  });
});

describe('toProjects: release (059)', () => {
  test('a well-formed release is kept; a missing or malformed one leaves the entry without it', () => {
    const out = toProjects({
      projects: [
        { id: 'a', name: 'A', root: '/a', release: { installed: '0.1.0', state: 'behind' } },
        { id: 'b', name: 'B', root: '/b', release: { installed: null, state: 'unknown' } },
        { id: 'c', name: 'C', root: '/c' },
        { id: 'd', name: 'D', root: '/d', release: { installed: '0.1.0', state: 'later' } },
        { id: 'e', name: 'E', root: '/e', release: null },
      ],
    });
    expect(out).toEqual([
      { id: 'a', name: 'A', root: '/a', release: { installed: '0.1.0', state: 'behind' } },
      { id: 'b', name: 'B', root: '/b', release: { installed: null, state: 'unknown' } },
      { id: 'c', name: 'C', root: '/c' },
      { id: 'd', name: 'D', root: '/d' },
      { id: 'e', name: 'E', root: '/e' },
    ]);
    for (const p of out.slice(2)) expect('release' in p).toBe(false);
  });
});

describe('toJob/toEpic: token spend (094 AC1)', () => {
  const counts = { model: 'claude-opus-5-5', input: 10, output: 20, cacheWrite: 30, cacheRead: 40 };
  const total: UsageTotal = { status: 'partial', input: 1, output: 2, cacheWrite: 3, cacheRead: 4, spans: 3, unknown: 1 };
  const span = (usage: unknown, extra: Record<string, unknown> = {}) => ({ role: 'builder', startedAt: '2026-10-22T10:00:00.000Z', finishedAt: '2026-10-22T11:00:00.000Z', ...(usage === undefined ? {} : { usage }), ...extra });
  const usageOf = (usage: unknown) => toJob({ id: '094-x', startedAt: '2026-10-22T10:00:00.000Z', timing: { stages: [], agents: [span(usage)] } })?.timing?.agents[0]?.usage;

  test('span usage: the counts and { unavailable } survive', () => {
    expect(usageOf(counts)).toEqual(counts);
    expect(usageOf({ ...counts, model: null })).toEqual({ ...counts, model: null });
    expect(usageOf({ unavailable: 'transcript not found' })).toEqual({ unavailable: 'transcript not found' });
    expect(usageOf(null)).toBeNull();
  });

  test('span usage: a missing key, a malformed value, or an extra key reads as not recorded', () => {
    expect(usageOf(undefined)).toBeNull();
    const { cacheRead: _, ...missing } = counts;
    for (const bad of [missing, { ...counts, extra: 1 }, { ...counts, input: -1 }, { ...counts, input: 1.5 }, { ...counts, input: '1' }, { ...counts, model: 3 }, { unavailable: '' }, { unavailable: 3 }, { unavailable: 'x', input: 1 }, 'x', 3, [counts]]) {
      expect(usageOf(bad)).toBeNull();
    }
  });

  test('job usage: the job and orchestrator totals survive; a malformed job total drops the rollup, a malformed orchestrator is null', () => {
    const at = (usage: unknown) => toJob({ id: '094-x', usage })?.usage;
    expect(at({ stages: [], rounds: [], job: total, orchestrator: total })).toEqual({ job: total, orchestrator: total });
    expect(at({ stages: [], rounds: [], job: total, orchestrator: null })).toEqual({ job: total, orchestrator: null });
    expect(at({ job: total, orchestrator: { ...total, extra: 1 } })).toEqual({ job: total, orchestrator: null });
    expect(at(undefined)).toBeNull();
    for (const bad of [null, 3, {}, { job: { ...total, extra: 1 } }, { job: { ...total, status: 'close enough' } }, { job: { ...total, spans: 0 } }, { job: { ...total, input: -1 } }, { job: { status: 'exact' } }]) {
      expect(at(bad)).toBeNull();
    }
  });

  test('epic orchestrator: the total survives; a missing or malformed one is null', () => {
    expect(toEpic({ slug: 'auth', orchestrator: total })?.orchestrator).toEqual(total);
    expect(toEpic({ slug: 'auth' })?.orchestrator).toBeNull();
    for (const bad of [null, {}, { ...total, extra: 1 }, { ...total, unknown: 'x' }]) expect(toEpic({ slug: 'auth', orchestrator: bad })?.orchestrator).toBeNull();
  });

  test('the drift checks cover the usage fields', () => {
    const src = readFileSync(join(import.meta.dir, 'job.ts'), 'utf8');
    for (const check of ["Assignable<JobSnapshot['usage'], Job['usage']>", "Assignable<ContractAgentSpan['usage'], AgentSpan['usage']>", "Assignable<EpicSnapshot['orchestrator'], EpicCore['orchestrator']>"]) expect(src).toContain(check);
  });
});
