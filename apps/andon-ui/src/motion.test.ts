import { describe, expect, test } from 'bun:test';
import { motionMs, reducedMotion } from './motion';

describe('motion (025 AC7)', () => {
  test('a transition lasts its time, or nothing under prefers-reduced-motion', () => {
    expect(motionMs(250, false)).toBe(250);
    expect(motionMs(250, true)).toBe(0);
  });

  test('with no matchMedia there is no reduced-motion preference', () => {
    expect(reducedMotion()).toBe(false);
    expect(motionMs(250)).toBe(250);
  });
});
