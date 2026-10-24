import { expect, test } from 'bun:test';
import { oneAtATime, toggleAction } from './toggle';
import type { WindowFlags } from './toggle';

const w = (visible: boolean, minimized: boolean, focused: boolean, more: Partial<WindowFlags> = {}): WindowFlags => ({
  visible,
  minimized,
  focused,
  fullscreen: false,
  allSpaces: false,
  ...more,
});

test('AC1: a hidden window, or no state at all, is shown, on the Space the user is on', () => {
  expect(toggleAction(null)).toEqual({ kind: 'show', restore: false, moveHere: true });
  expect(toggleAction(w(false, false, false))).toEqual({ kind: 'show', restore: false, moveHere: true });
  expect(toggleAction(w(false, false, true))).toEqual({ kind: 'show', restore: false, moveHere: true });
});

test('AC2: only a visible, unminimized, focused window is hidden', () => {
  expect(toggleAction(w(true, false, true))).toEqual({ kind: 'hide' });
});

test('AC2: a visible window behind others (or on another Space) is brought to the front here', () => {
  expect(toggleAction(w(true, false, false))).toEqual({ kind: 'show', restore: false, moveHere: true });
});

test('AC2: a minimized window is restored and shown, with or without focus', () => {
  for (const visible of [true, false]) {
    for (const focused of [true, false]) expect(toggleAction(w(visible, true, focused))).toEqual({ kind: 'show', restore: true, moveHere: true });
  }
});

test('rework 1: a fullscreen window keeps its own Space, and a window already on every Space is left there', () => {
  expect(toggleAction(w(true, false, false, { fullscreen: true }))).toEqual({ kind: 'show', restore: false, moveHere: false });
  expect(toggleAction(w(false, false, false, { allSpaces: true }))).toEqual({ kind: 'show', restore: false, moveHere: false });
});

test('rework 1: a click that lands while the last one is still being handled is dropped', async () => {
  let release = (): void => {};
  let runs = 0;
  const run = oneAtATime(async () => {
    runs++;
    await new Promise<void>((r) => (release = r));
  });
  const first = run();
  await run(); // dropped: resolves at once
  expect(runs).toBe(1);
  release();
  await first;
  const third = run();
  expect(runs).toBe(2);
  release();
  await third;
});

test('rework 1: a failed run does not jam later clicks', async () => {
  let runs = 0;
  const run = oneAtATime(async () => {
    runs++;
    throw new Error('boom');
  });
  await expect(run()).rejects.toThrow('boom');
  await expect(run()).rejects.toThrow('boom');
  expect(runs).toBe(2);
});
