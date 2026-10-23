import { describe, expect, test } from 'bun:test';
import { landing, toJob } from './job';

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
