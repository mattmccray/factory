import { describe, expect, test } from 'bun:test';
import { initialKeys, reduceKey } from './keys';
import type { KeyAction, KeyInput, KeyState, Layers } from './keys';

const NONE: Layers = { sheet: false, inspector: false, searchText: false, searchFocused: false };
const ev = (key: string, opts: Partial<KeyInput> = {}): KeyInput => ({ key, mod: false, inField: false, ...opts });

/** Runs a sequence of events through the reducer and returns each action. */
function run(events: KeyInput[], layers: Layers = NONE): Array<KeyAction | null> {
  let s: KeyState = initialKeys();
  return events.map((e) => {
    const r = reduceKey(s, e, layers);
    s = r.state;
    return r.action;
  });
}

describe('single keys (AC2)', () => {
  test('/ focuses search, n toggles Needs Me, ? opens the shortcut sheet', () => {
    expect(run([ev('/'), ev('n'), ev('?')])).toEqual(['focus-search', 'toggle-needs', 'open-keys']);
  });

  test('other keys do nothing', () => {
    expect(run([ev('x'), ev('a'), ev('N'), ev('Enter')])).toEqual([null, null, null, null]);
  });

  test('ignored while focus is in a field', () => {
    expect(run(['/', 'n', '?', 'g', 'a'].map((k) => ev(k, { inField: true })))).toEqual([null, null, null, null, null]);
  });

  test('ignored while a modifier is held', () => {
    expect(run(['/', 'n', '?', 'g', 'a'].map((k) => ev(k, { mod: true })))).toEqual([null, null, null, null, null]);
    expect(run([ev('g'), ev('a', { mod: true })])).toEqual([null, null]);
  });

  test('ignored under an open sheet', () => {
    expect(run([ev('/'), ev('n'), ev('?')], { ...NONE, sheet: true })).toEqual([null, null, null]);
  });
});

describe('g then a (AC2)', () => {
  test('goes to All Projects', () => {
    expect(run([ev('g'), ev('a')])).toEqual([null, 'all-projects']);
  });

  test('g then any other key does nothing and resets', () => {
    expect(run([ev('g'), ev('x'), ev('a')])).toEqual([null, null, null]);
    expect(run([ev('g'), ev('n'), ev('n')])).toEqual([null, null, 'toggle-needs']);
    expect(run([ev('g'), ev('g'), ev('a')])).toEqual([null, null, null]);
    expect(run([ev('g'), ev('/', { inField: true }), ev('a')])).toEqual([null, null, null]);
  });

  test('a modifier key alone (Shift) does not break the sequence', () => {
    expect(run([ev('g'), ev('Shift'), ev('a')])).toEqual([null, null, 'all-projects']);
  });

  test('Esc resets it', () => {
    expect(run([ev('g'), ev('Escape'), ev('a')])).toEqual([null, null, null]);
  });
});

describe('Esc by layer order (AC2)', () => {
  const esc = (layers: Layers, inField = false): KeyAction | null => run([ev('Escape', { inField })], layers)[0] ?? null;
  const all: Layers = { sheet: true, inspector: true, searchText: true, searchFocused: true };

  test('sheet, then inspector, then clear search, then leave search', () => {
    expect(esc(all)).toBe('close-sheet');
    expect(esc({ ...all, sheet: false })).toBe('close-inspector');
    expect(esc({ ...all, sheet: false, inspector: false })).toBe('clear-search');
    expect(esc({ ...NONE, searchFocused: true })).toBe('leave-search');
    expect(esc(NONE)).toBeNull();
  });

  test('text in an unfocused search is still cleared', () => {
    expect(esc({ ...NONE, searchText: true })).toBe('clear-search');
  });

  test('works from inside a field, and with a modifier', () => {
    expect(esc(all, true)).toBe('close-sheet');
    expect(esc({ ...all, sheet: false }, true)).toBe('close-inspector');
    expect(esc({ ...NONE, searchText: true, searchFocused: true }, true)).toBe('clear-search');
    expect(esc({ ...NONE, searchFocused: true }, true)).toBe('leave-search');
    expect(run([ev('Escape', { mod: true })], { ...NONE, inspector: true })).toEqual(['close-inspector']);
  });

  test('three presses over a sheet over the inspector, with text in search, step down the layers (AC7)', () => {
    let layers: Layers = { sheet: true, inspector: true, searchText: true, searchFocused: false };
    const out: Array<KeyAction | null> = [];
    let s = initialKeys();
    for (let i = 0; i < 3; i++) {
      const r = reduceKey(s, ev('Escape', { inField: i === 0 }), layers);
      s = r.state;
      out.push(r.action);
      if (r.action === 'close-sheet') layers = { ...layers, sheet: false };
      else if (r.action === 'close-inspector') layers = { ...layers, inspector: false };
      else if (r.action === 'clear-search') layers = { ...layers, searchText: false };
    }
    expect(out).toEqual(['close-sheet', 'close-inspector', 'clear-search']);
  });
});
