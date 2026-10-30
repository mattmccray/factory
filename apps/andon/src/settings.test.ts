import { describe, expect, test } from 'bun:test';
import { SETTINGS_WINDOW_ID, STATUS_BAR_KEY } from './appmenu';
import { DEFAULT_HANDOFF_MODE, GET_SETTINGS_METHOD, HANDOFF_MODES, SETTING_KEYS, SET_SETTING_METHOD, T3_HANDOFF_KEY, VIEW_STATE_METHOD, fromSettingsWindow, settingChange, settingsSnapshot, storedMode, viewStateParams } from './settings';

describe('035 AC3: the settings keys and the snapshot', () => {
  test('three keys: statusBarHidden, the same name as the status bar store key, t3Handoff (036), and mergedHidden (063)', () => {
    expect(SETTING_KEYS).toEqual(['statusBarHidden', 't3Handoff', 'mergedHidden']);
    expect(T3_HANDOFF_KEY).toBe('t3Handoff');
    expect(STATUS_BAR_KEY).toBe('statusBarHidden');
    expect(GET_SETTINGS_METHOD).toBe('getSettings');
    expect(SET_SETTING_METHOD).toBe('setSetting');
  });

  test('the snapshot: exactly true is hidden; missing or anything else is shown', () => {
    expect(settingsSnapshot({ statusBarHidden: true }, false)).toEqual({ statusBarHidden: true, t3Handoff: 'draft', mergedHidden: false, t3Found: false });
    for (const v of [false, null, undefined, 'true', 1, {}, []]) expect({ v, s: settingsSnapshot({ statusBarHidden: v }, false).statusBarHidden }).toEqual({ v, s: false });
    expect(settingsSnapshot({}, false)).toEqual({ statusBarHidden: false, t3Handoff: 'draft', mergedHidden: false, t3Found: false });
  });
});

describe('036 AC5: the T3 Code setting in the snapshot', () => {
  test('a stored draft, send, or copy is kept; anything else (or nothing) is draft; t3Found is passed through', () => {
    expect(HANDOFF_MODES).toEqual(['draft', 'send', 'copy']);
    expect(DEFAULT_HANDOFF_MODE).toBe('draft');
    for (const m of HANDOFF_MODES) expect(settingsSnapshot({ t3Handoff: m }, true)).toEqual({ statusBarHidden: false, t3Handoff: m, mergedHidden: false, t3Found: true });
    for (const v of [null, undefined, '', 'Draft', 'SEND', 'auto', 1, true, {}, ['send']]) expect({ v, m: storedMode(v) }).toEqual({ v, m: 'draft' });
    expect(settingsSnapshot({ statusBarHidden: true, t3Handoff: 'nope' }, true)).toEqual({ statusBarHidden: true, t3Handoff: 'draft', mergedHidden: false, t3Found: true });
  });

  test('a t3Handoff change is accepted only for draft, send, or copy', () => {
    for (const value of HANDOFF_MODES) expect(settingChange({ key: 't3Handoff', value })).toEqual({ key: 't3Handoff', value });
    for (const value of ['', 'Draft', 'auto', 'run', true, 1, null, undefined, ['send'], { mode: 'send' }]) expect({ value, c: settingChange({ key: 't3Handoff', value }) }).toEqual({ value, c: null });
    expect(settingChange({ key: 't3Handoff', value: 'send', extra: 1 })).toBeNull();
    expect(settingChange({ key: 't3Found', value: true })).toBeNull();
    expect(settingChange({ key: 'statusBarHidden', value: 'send' })).toBeNull();
  });
});

describe('035 AC3: validating a "set"', () => {
  test('a known key with a boolean value is accepted', () => {
    expect(settingChange({ key: 'statusBarHidden', value: true })).toEqual({ key: 'statusBarHidden', value: true });
    expect(settingChange({ key: 'statusBarHidden', value: false })).toEqual({ key: 'statusBarHidden', value: false });
  });

  test('malformed params, an unknown key, the wrong type, or extra keys are rejected', () => {
    const bad: unknown[] = [
      null,
      undefined,
      true,
      'statusBarHidden',
      [],
      ['statusBarHidden', true],
      {},
      { key: 'statusBarHidden' },
      { value: true },
      { key: 'statusBarHidden', value: 'yes' },
      { key: 'statusBarHidden', value: 1 },
      { key: 'statusBarHidden', value: null },
      { key: 'nope', value: true },
      { key: 'STATUSBARHIDDEN', value: true },
      { key: '__proto__', value: true },
      { key: 'statusBarHidden', value: true, extra: 1 },
      { key: 'statusBarHidden', value: true, window: 'settings' },
    ];
    for (const p of bad) expect({ p, change: settingChange(p) }).toEqual({ p, change: null });
  });
});

describe('035 AC2: only the Settings window is answered', () => {
  test("meta.window must be the Settings window's id", () => {
    expect(SETTINGS_WINDOW_ID).toBe('settings');
    expect(fromSettingsWindow({ window: 'settings' })).toBe(true);
    expect(fromSettingsWindow({ window: 'settings', origin: 'http://127.0.0.1:8766' })).toBe(true);
    for (const meta of [{ window: 'main' }, { window: 'Settings' }, { window: '' }, {}, null, undefined, 'settings', { window: ['settings'] }]) {
      expect({ meta, ok: fromSettingsWindow(meta) }).toEqual({ meta, ok: false });
    }
  });
});

describe('063 AC2: the Merged column setting', () => {
  test('the snapshot: exactly true is hidden; missing or anything else is shown', () => {
    expect(settingsSnapshot({ mergedHidden: true }, false)).toEqual({ statusBarHidden: false, t3Handoff: 'draft', mergedHidden: true, t3Found: false });
    for (const v of [false, null, undefined, 'true', 1, 0, {}, [], { hidden: true }]) expect({ v, m: settingsSnapshot({ mergedHidden: v }, false).mergedHidden }).toEqual({ v, m: false });
    expect(settingsSnapshot({}, true).mergedHidden).toBe(false);
  });

  test('a mergedHidden change is accepted only with a boolean value and nothing else', () => {
    expect(settingChange({ key: 'mergedHidden', value: true })).toEqual({ key: 'mergedHidden', value: true });
    expect(settingChange({ key: 'mergedHidden', value: false })).toEqual({ key: 'mergedHidden', value: false });
    const bad: unknown[] = [
      { key: 'mergedHidden', value: 'true' },
      { key: 'mergedHidden', value: 1 },
      { key: 'mergedHidden', value: null },
      { key: 'mergedHidden' },
      { key: 'mergedHidden', value: true, extra: 1 },
      { key: 'MergedHidden', value: true },
      { key: 'merged', value: true },
      { key: 'mergedShown', value: true },
    ];
    for (const p of bad) expect({ p, change: settingChange(p) }).toEqual({ p, change: null });
  });
});

describe('063 AC6: the view-state params', () => {
  test('the method is setViewState', () => {
    expect(VIEW_STATE_METHOD).toBe('setViewState');
  });

  test('exactly the three booleans are accepted', () => {
    for (const needsMe of [false, true]) {
      for (const sidebarShown of [false, true]) {
        for (const inspectorOpen of [false, true]) expect(viewStateParams({ needsMe, sidebarShown, inspectorOpen })).toEqual({ needsMe, sidebarShown, inspectorOpen });
      }
    }
  });

  test('anything else is refused: malformed, a key missing or extra, or a value not a boolean', () => {
    const ok = { needsMe: true, sidebarShown: false, inspectorOpen: true };
    const bad: unknown[] = [
      null,
      undefined,
      true,
      'needsMe',
      [],
      [true, false, true],
      {},
      { needsMe: true, sidebarShown: false },
      { needsMe: true, inspectorOpen: true },
      { sidebarShown: true, inspectorOpen: true },
      { ...ok, extra: 1 },
      { ...ok, window: 'main' },
      { ...ok, needsMe: 'true' },
      { ...ok, sidebarShown: 1 },
      { ...ok, inspectorOpen: null },
      { needsMe: true, sidebarShown: false, inspector: true },
      { needs: true, sidebarShown: false, inspectorOpen: true },
    ];
    for (const p of bad) expect({ p, v: viewStateParams(p) }).toEqual({ p, v: null });
  });
});
