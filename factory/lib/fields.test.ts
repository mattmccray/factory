import { describe, expect, test } from 'bun:test';
import { parseFields } from './fields';

describe('parseFields', () => {
  test('integer keys', () => {
    expect(parseFields(['round=2', 'maxRound=3', 'k=1'])).toEqual({ round: 2, maxRound: 3, k: 1 });
  });
  test('non-integer values for integer keys are rejected', () => {
    expect(() => parseFields(['round=2.5'])).toThrow('integer');
    expect(() => parseFields(['k=abc'])).toThrow('integer');
  });
  test('reviewers is a JSON array', () => {
    expect(parseFields(['reviewers=["a","b"]'])).toEqual({ reviewers: ['a', 'b'] });
    expect(() => parseFields(['reviewers=a,b'])).toThrow('JSON array');
    expect(() => parseFields(['reviewers={"a":1}'])).toThrow('JSON array');
  });
  test('null literal and string passthrough', () => {
    expect(parseFields(['brief=null', 'sha=1234567', 'x=3e45678', 'title=404', 'note=true'])).toEqual({
      brief: null, sha: '1234567', x: '3e45678', title: '404', note: 'true',
    });
  });
  test('value containing =', () => {
    expect(parseFields(['note=a=b=c'])).toEqual({ note: 'a=b=c' });
  });
  test('missing = is rejected', () => {
    expect(() => parseFields(['oops'])).toThrow('key=value');
  });
});
