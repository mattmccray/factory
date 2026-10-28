import { describe, expect, test } from 'bun:test';
import { landing, toJob } from './job';
import type { WorkingStage } from './job';

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
