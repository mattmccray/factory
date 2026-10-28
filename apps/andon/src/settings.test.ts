import { describe, expect, test } from 'bun:test';
import { SETTINGS_WINDOW_ID, STATUS_BAR_KEY } from './appmenu';
import { GET_SETTINGS_METHOD, SETTING_KEYS, SET_SETTING_METHOD, fromSettingsWindow, settingChange, settingsSnapshot } from './settings';

describe('035 AC3: the settings keys and the snapshot', () => {
  test('one key, statusBarHidden, the same name as the status bar store key', () => {
    expect(SETTING_KEYS).toEqual(['statusBarHidden']);
    expect(STATUS_BAR_KEY).toBe('statusBarHidden');
    expect(GET_SETTINGS_METHOD).toBe('getSettings');
    expect(SET_SETTING_METHOD).toBe('setSetting');
  });

  test('the snapshot: exactly true is hidden; missing or anything else is shown', () => {
    expect(settingsSnapshot({ statusBarHidden: true })).toEqual({ statusBarHidden: true });
    for (const v of [false, null, undefined, 'true', 1, {}, []]) expect({ v, s: settingsSnapshot({ statusBarHidden: v }) }).toEqual({ v, s: { statusBarHidden: false } });
    expect(settingsSnapshot({})).toEqual({ statusBarHidden: false });
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
