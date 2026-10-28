import { describe, expect, test } from 'bun:test';
import { SETTINGS_WINDOW_ID, STATUS_BAR_KEY } from './appmenu';
import { DEFAULT_HANDOFF_MODE, GET_SETTINGS_METHOD, HANDOFF_MODES, SETTING_KEYS, SET_SETTING_METHOD, T3_HANDOFF_KEY, fromSettingsWindow, settingChange, settingsSnapshot, storedMode } from './settings';

describe('035 AC3: the settings keys and the snapshot', () => {
  test('two keys: statusBarHidden, the same name as the status bar store key, and t3Handoff (036)', () => {
    expect(SETTING_KEYS).toEqual(['statusBarHidden', 't3Handoff']);
    expect(T3_HANDOFF_KEY).toBe('t3Handoff');
    expect(STATUS_BAR_KEY).toBe('statusBarHidden');
    expect(GET_SETTINGS_METHOD).toBe('getSettings');
    expect(SET_SETTING_METHOD).toBe('setSetting');
  });

  test('the snapshot: exactly true is hidden; missing or anything else is shown', () => {
    expect(settingsSnapshot({ statusBarHidden: true }, false)).toEqual({ statusBarHidden: true, t3Handoff: 'draft', t3Found: false });
    for (const v of [false, null, undefined, 'true', 1, {}, []]) expect({ v, s: settingsSnapshot({ statusBarHidden: v }, false).statusBarHidden }).toEqual({ v, s: false });
    expect(settingsSnapshot({}, false)).toEqual({ statusBarHidden: false, t3Handoff: 'draft', t3Found: false });
  });
});

describe('036 AC5: the T3 Code setting in the snapshot', () => {
  test('a stored draft, send, or copy is kept; anything else (or nothing) is draft; t3Found is passed through', () => {
    expect(HANDOFF_MODES).toEqual(['draft', 'send', 'copy']);
    expect(DEFAULT_HANDOFF_MODE).toBe('draft');
    for (const m of HANDOFF_MODES) expect(settingsSnapshot({ t3Handoff: m }, true)).toEqual({ statusBarHidden: false, t3Handoff: m, t3Found: true });
    for (const v of [null, undefined, '', 'Draft', 'SEND', 'auto', 1, true, {}, ['send']]) expect({ v, m: storedMode(v) }).toEqual({ v, m: 'draft' });
    expect(settingsSnapshot({ statusBarHidden: true, t3Handoff: 'nope' }, true)).toEqual({ statusBarHidden: true, t3Handoff: 'draft', t3Found: true });
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
