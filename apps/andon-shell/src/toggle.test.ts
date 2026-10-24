import { expect, test } from 'bun:test';
import { toggleAction } from './toggle';
import type { WindowFlags } from './toggle';

const w = (visible: boolean, minimized: boolean, focused: boolean): WindowFlags => ({ visible, minimized, focused });

test('AC1: a hidden window, or no state at all, is shown', () => {
  expect(toggleAction(null)).toEqual({ kind: 'show', restore: false });
  expect(toggleAction(w(false, false, false))).toEqual({ kind: 'show', restore: false });
  expect(toggleAction(w(false, false, true))).toEqual({ kind: 'show', restore: false });
});

test('AC2: only a visible, unminimized, focused window is hidden', () => {
  expect(toggleAction(w(true, false, true))).toEqual({ kind: 'hide' });
});

test('AC2: a visible window behind others is brought to the front', () => {
  expect(toggleAction(w(true, false, false))).toEqual({ kind: 'show', restore: false });
});

test('AC2: a minimized window is restored and shown, with or without focus', () => {
  for (const visible of [true, false]) {
    for (const focused of [true, false]) expect(toggleAction(w(visible, true, focused))).toEqual({ kind: 'show', restore: true });
  }
});
