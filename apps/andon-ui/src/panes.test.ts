import { describe, expect, test } from 'bun:test';
import { INSPECTOR_DEFAULT, INSPECTOR_MAX, INSPECTOR_MIN } from './inspector';
import {
  DOC_ROOM,
  FILES_FIT,
  FILES_KEY,
  FILES_MIN,
  INSPECTOR_KEY,
  PANE_STEP,
  PANE_STEP_BIG,
  SIDEBAR_DEFAULT,
  SIDEBAR_KEY,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampFiles,
  clampSidebar,
  filesKey,
  filesShown,
  loadFilesHeight,
  loadInspectorWidth,
  loadSidebarWidth,
  parseStored,
  savePane,
  sidebarKey,
} from './panes';
import type { KeyValueStore } from './projects';

/** A fake `KeyValueStore` over a map, recording every write. */
function fakeStore(init: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (key: string): string | null => data.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      data.set(key, value);
    },
  };
}
const blocked: KeyValueStore = {
  getItem: (): string | null => {
    throw new Error('blocked');
  },
  setItem: (): void => {
    throw new Error('blocked');
  },
};

describe('AC1: the sidebar width model', () => {
  test('limits 180–320, default 216', () => {
    expect([SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT]).toEqual([180, 320, 216]);
  });

  test('a requested width is whole pixels clamped to 180–320', () => {
    expect(clampSidebar(250.6)).toBe(251);
    expect(clampSidebar(100)).toBe(180);
    expect(clampSidebar(999)).toBe(320);
    expect(clampSidebar(180)).toBe(180);
    expect(clampSidebar(320)).toBe(320);
  });

  test('non-numbers give the default, 216', () => {
    expect(clampSidebar(Number.NaN)).toBe(216);
    expect(clampSidebar(Number.POSITIVE_INFINITY)).toBe(216);
    expect(clampSidebar(Number('wide'))).toBe(216);
  });

  test('← and → step it by the inspector grip\'s step (16, 64 with Shift), Home gives 180, End gives 320', () => {
    expect([PANE_STEP, PANE_STEP_BIG]).toEqual([16, 64]);
    expect(sidebarKey(216, 'ArrowLeft', false)).toBe(200);
    expect(sidebarKey(216, 'ArrowRight', false)).toBe(232);
    expect(sidebarKey(216, 'ArrowRight', true)).toBe(280);
    expect(sidebarKey(190, 'ArrowLeft', false)).toBe(180);
    expect(sidebarKey(310, 'ArrowRight', true)).toBe(320);
    expect(sidebarKey(250, 'Home', false)).toBe(180);
    expect(sidebarKey(250, 'End', false)).toBe(320);
    expect(sidebarKey(250, 'ArrowUp', false)).toBeNull();
    expect(sidebarKey(250, 'a', false)).toBeNull();
  });
});

describe('AC2: the Files height model', () => {
  test('a height is clamped between the two-row minimum and the room minus about 120 px', () => {
    expect(DOC_ROOM).toBe(120);
    expect(FILES_MIN).toBeGreaterThanOrEqual(2 * 24);
    expect(FILES_MIN).toBeLessThan(120);
    const room = 600;
    expect(clampFiles(300, room)).toBe(300);
    expect(clampFiles(300.4, room)).toBe(300);
    expect(clampFiles(10, room)).toBe(FILES_MIN);
    expect(clampFiles(900, room)).toBe(room - DOC_ROOM);
    expect(clampFiles(room - DOC_ROOM, room)).toBe(480);
  });

  test('the minimum wins when the room is too small for both', () => {
    expect(clampFiles(150, 150)).toBe(FILES_MIN);
    expect(clampFiles(10, 0)).toBe(FILES_MIN);
    expect(clampFiles(Number.NaN, 600)).toBe(FILES_MIN);
    expect(clampFiles(300, Number.NaN)).toBe(FILES_MIN);
  });

  test('↑ and ↓ step it within its limits; other keys are not its', () => {
    expect(filesKey(200, 'ArrowUp', false, 600)).toBe(184);
    expect(filesKey(200, 'ArrowDown', false, 600)).toBe(216);
    expect(filesKey(200, 'ArrowDown', true, 600)).toBe(264);
    expect(filesKey(470, 'ArrowDown', true, 600)).toBe(480);
    expect(filesKey(FILES_MIN, 'ArrowUp', false, 600)).toBe(FILES_MIN);
    expect(filesKey(200, 'ArrowLeft', false, 600)).toBeNull();
    expect(filesKey(200, 'Home', false, 600)).toBeNull();
  });

  test('reset is "not dragged" (null): the list fits its files, up to 38%', () => {
    expect(FILES_FIT).toBeNull();
    expect(filesShown(FILES_FIT, 600)).toBeNull();
  });

  test('a kept height larger than the current room is clamped when shown, and kept as is', () => {
    expect(filesShown(700, 600)).toBe(480);
    expect(filesShown(300, 600)).toBe(300);
    expect(filesShown(300, 0)).toBe(300); // not measured yet
  });
});

describe('AC3: keeping the sizes', () => {
  test('parsing a stored size', () => {
    expect(parseStored('250')).toBe(250);
    expect(parseStored(' 250.5 ')).toBe(250.5);
    expect(parseStored('-4')).toBe(-4);
    for (const bad of [null, undefined, '', '  ', 'wide', '250px', '0x10', '1e3', 'NaN', 'Infinity']) expect(parseStored(bad)).toBeNull();
  });

  test('an in-range value loads as stored', () => {
    const s = fakeStore({ [SIDEBAR_KEY]: '260', [FILES_KEY]: '300', [INSPECTOR_KEY]: '480' });
    expect(loadSidebarWidth(s)).toBe(260);
    expect(loadFilesHeight(s)).toBe(300);
    expect(loadInspectorWidth(s)).toBe(480);
  });

  test('an out-of-range number is clamped into its limits', () => {
    const low = fakeStore({ [SIDEBAR_KEY]: '10', [FILES_KEY]: '-5', [INSPECTOR_KEY]: '100' });
    expect(loadSidebarWidth(low)).toBe(SIDEBAR_MIN);
    expect(loadFilesHeight(low)).toBe(FILES_MIN);
    expect(loadInspectorWidth(low)).toBe(INSPECTOR_MIN);
    const high = fakeStore({ [SIDEBAR_KEY]: '9000', [FILES_KEY]: '9000', [INSPECTOR_KEY]: '9000' });
    expect(loadSidebarWidth(high)).toBe(SIDEBAR_MAX);
    expect(loadFilesHeight(high)).toBe(9000); // its maximum is the room, applied when shown
    expect(loadInspectorWidth(high)).toBe(INSPECTOR_MAX);
  });

  test('empty, missing, or non-numeric strings give the defaults (216, not dragged, 392)', () => {
    for (const raw of ['', 'wide', '12px', 'null']) {
      const s = fakeStore({ [SIDEBAR_KEY]: raw, [FILES_KEY]: raw, [INSPECTOR_KEY]: raw });
      expect([loadSidebarWidth(s), loadFilesHeight(s), loadInspectorWidth(s)]).toEqual([216, null, INSPECTOR_DEFAULT]);
    }
    const none = fakeStore();
    expect([loadSidebarWidth(none), loadFilesHeight(none), loadInspectorWidth(none)]).toEqual([216, null, 392]);
    expect([loadSidebarWidth(null), loadFilesHeight(null), loadInspectorWidth(null)]).toEqual([216, null, 392]);
  });

  test('a storage that throws gives the defaults', () => {
    expect([loadSidebarWidth(blocked), loadFilesHeight(blocked), loadInspectorWidth(blocked)]).toEqual([216, null, 392]);
  });

  test('saving writes fixed andon.* keys; a reset Files height is kept as empty and loads as not dragged', () => {
    expect([SIDEBAR_KEY, FILES_KEY, INSPECTOR_KEY]).toEqual(['andon.sidebarWidth', 'andon.filesHeight', 'andon.inspectorWidth']);
    const s = fakeStore();
    savePane(s, SIDEBAR_KEY, 240);
    savePane(s, FILES_KEY, 300);
    savePane(s, INSPECTOR_KEY, 450);
    expect(Object.fromEntries(s.data)).toEqual({ 'andon.sidebarWidth': '240', 'andon.filesHeight': '300', 'andon.inspectorWidth': '450' });
    expect([loadSidebarWidth(s), loadFilesHeight(s), loadInspectorWidth(s)]).toEqual([240, 300, 450]);
    savePane(s, FILES_KEY, FILES_FIT);
    expect(s.data.get(FILES_KEY)).toBe('');
    expect(loadFilesHeight(s)).toBeNull();
  });

  test('saving swallows storage errors', () => {
    expect(() => savePane(blocked, SIDEBAR_KEY, 240)).not.toThrow();
    expect(() => savePane(null, SIDEBAR_KEY, 240)).not.toThrow();
  });
});
