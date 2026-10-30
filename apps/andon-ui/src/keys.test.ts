import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHORTCUTS, initialKeys, reduceKey, shortcutsFor, topSheet } from './keys';
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

describe("Esc closes What's New as the topmost sheet (059 AC5)", () => {
  const none = { whatsNew: false, keys: false, command: false, settled: false, backlog: false };

  test('What\'s New is a sheet layer: Esc closes it before the inspector, and no single key works under it', () => {
    const layers: Layers = { ...NONE, sheet: true, inspector: true };
    expect(run([ev('Escape')], layers)).toEqual(['close-sheet']);
    expect(run([ev('?'), ev('n'), ev('/')], layers)).toEqual([null, null, null]);
  });

  test('topmost first: What\'s New, then the shortcuts or a command sheet, then the Settled sheet', () => {
    expect(topSheet({ whatsNew: true, keys: true, command: true, settled: true, backlog: true })).toBe('whatsNew');
    expect(topSheet({ ...none, whatsNew: true, settled: true })).toBe('whatsNew');
    expect(topSheet({ ...none, keys: true, settled: true })).toBe('keys');
    expect(topSheet({ ...none, command: true, settled: true })).toBe('command');
    expect(topSheet({ ...none, settled: true })).toBe('settled');
    expect(topSheet(none)).toBeNull();
  });

  test('App.svelte counts it as a sheet and closes by topSheet', () => {
    const app = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8');
    expect(app).toContain('sheet: settledOpen || backlogOpen || whatsNewOpen || sheet !== null || keysOpen');
    expect(app).toContain('switch (topSheet({ whatsNew: whatsNewOpen, keys: keysOpen, command: sheet !== null, settled: settledOpen, backlog: backlogOpen }))');
  });
});

describe('063 AC7: the shortcut sheet lists the View menu shortcuts', () => {
  const menuKeys = ['⇧⌘N', '⇧⌘S', '⇧⌘B', '⌃⌘S', '⌥⌘I', '⌘/']; // ⇧⌘B: Show Backlog… (067 AC7), after Show Settled…

  test('SHORTCUTS lists ⇧⌘N, ⇧⌘S, ⇧⌘B, ⌃⌘S, ⌥⌘I, and ⌘/, in menu order, after the page keys', () => {
    expect(SHORTCUTS.filter((s) => s.menu === true).map((s) => s.keys)).toEqual(menuKeys.map((k) => [k]));
    expect(SHORTCUTS.slice(0, 6).every((s) => s.menu !== true)).toBe(true);
    expect(new Set(SHORTCUTS.map((s) => s.text)).size).toBe(SHORTCUTS.length); // the sheet keys its rows by text
  });

  test('the Mac app shows every row; a plain browser, only the page keys (nothing new appears)', () => {
    expect(shortcutsFor(true)).toEqual(SHORTCUTS);
    const browser = shortcutsFor(false);
    expect(browser.map((s) => s.keys.join(' '))).toEqual(['/', 'esc', '↑ ↓', 'g a', 'n', '?']);
    expect(browser.some((s) => menuKeys.includes(s.keys[0] ?? ''))).toBe(false);
    const sheet = readFileSync(join(import.meta.dir, 'ShortcutSheet.svelte'), 'utf8');
    expect(sheet).toContain('const rows = $derived(shortcutsFor(mac));');
    const app = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8');
    expect(app).toContain("<ShortcutSheet open={keysOpen} mac={mode === 'mac'} onclose={() => (keysOpen = false)} />");
  });

  test('n still toggles Needs Me, and the menu shortcuts (a modifier held) are never the page reducer\'s', () => {
    expect(run([ev('n')])).toEqual(['toggle-needs']);
    expect(run([ev('N', { mod: true }), ev('S', { mod: true }), ev('s', { mod: true }), ev('i', { mod: true }), ev('/', { mod: true })])).toEqual([null, null, null, null, null]);
  });
});

describe('067 AC7: the Backlog sheet in the layer order', () => {
  const none = { whatsNew: false, keys: false, command: false, settled: false, backlog: false };
  test('Esc closes it where the Settled sheet would be: under What\'s New, the shortcuts, and a command sheet', () => {
    expect(topSheet({ ...none, backlog: true })).toBe('backlog');
    expect(topSheet({ ...none, whatsNew: true, backlog: true })).toBe('whatsNew');
    expect(topSheet({ ...none, keys: true, backlog: true })).toBe('keys');
    expect(topSheet({ ...none, command: true, backlog: true })).toBe('command');
    const app = readFileSync(join(import.meta.dir, 'App.svelte'), 'utf8');
    expect(app).toMatch(/case 'backlog':\s*backlogOpen = false;/);
  });

  test('the shortcut sheet lists ⇧⌘B as a View menu row, in the Mac app only', () => {
    expect(SHORTCUTS.find((s) => s.keys[0] === '⇧⌘B')).toEqual({ keys: ['⇧⌘B'], text: 'Show the backlog (View menu)', menu: true });
    expect(shortcutsFor(false).some((s) => s.keys[0] === '⇧⌘B')).toBe(false);
  });
});
