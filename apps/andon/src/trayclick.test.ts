import { expect, test } from 'bun:test';
import { oneAtATime, trayClickAction } from './trayclick';

const ALL = [true, false];
/** Every combination of the visibility flags Tiny reports, for an ordinary window. */
const states = ALL.flatMap((visible) => ALL.flatMap((focused) => ALL.map((minimized) => ({ visible, focused, minimized, fullscreen: false, allSpaces: false }))));

test('AC1: a hidden window, or no state at all, is shown on the Space the user is on', () => {
  expect(trayClickAction(null)).toEqual({ restore: false, moveHere: true });
  expect(trayClickAction({ minimized: false, fullscreen: false, allSpaces: false })).toEqual({ restore: false, moveHere: true });
});

test('AC2 (rework 2): a left click never hides: every state is shown here, restored when minimized', () => {
  for (const s of states) expect(trayClickAction(s)).toEqual({ restore: s.minimized, moveHere: true });
});

test('rework 1: a fullscreen window keeps its own Space, and a window already on every Space is left there', () => {
  expect(trayClickAction({ minimized: false, fullscreen: true, allSpaces: false })).toEqual({ restore: false, moveHere: false });
  expect(trayClickAction({ minimized: true, fullscreen: false, allSpaces: true })).toEqual({ restore: true, moveHere: false });
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
