// The Mac app's stored settings, runtime-neutral: the keys and their types, the snapshot the Settings
// window reads (built from the stored values), the validation for a change it asks for, and the
// window check both methods make first. backend.ts owns the stored values, answers the two methods
// only for the Settings window, and keeps the menu bar and every window in step.
import { STATUS_BAR_KEY, SETTINGS_WINDOW_ID, storedHidden } from './appmenu';
import { isRecord } from './state';

/** The two backend methods the Settings window calls (tinyjs.json's `api` gate names them). */
export const GET_SETTINGS_METHOD = 'getSettings';
export const SET_SETTING_METHOD = 'setSetting';

/** Every setting, by its store key, with its type. One for now: the status bar choice. */
export interface Settings {
  statusBarHidden: boolean;
}
export type SettingKey = keyof Settings;

/** The keys, in order. `statusBarHidden` is STATUS_BAR_KEY, so the choice stored before carries over. */
export const SETTING_KEYS: readonly SettingKey[] = [STATUS_BAR_KEY];

/** One change the Settings window may ask for: a known key and a value of its type. */
export type SettingChange = { key: 'statusBarHidden'; value: boolean };

/** The snapshot from the stored values: exactly `true` means hidden, anything else (or nothing) shown. */
export const settingsSnapshot = (stored: Readonly<Partial<Record<SettingKey, unknown>>>): Settings => ({
  statusBarHidden: storedHidden(stored.statusBarHidden),
});

/**
 * A "set" request, validated: a plain object with exactly `key` and `value`, a known key, and a value
 * of that key's type. Null for anything else (malformed, an unknown key, the wrong type, extra keys).
 */
export function settingChange(params: unknown): SettingChange | null {
  if (!isRecord(params)) return null;
  const keys = Object.keys(params);
  if (keys.length !== 2 || !keys.includes('key') || !keys.includes('value')) return null;
  const { key, value } = params;
  if (key === 'statusBarHidden' && typeof value === 'boolean') return { key, value };
  return null;
}

/** The call came from the Settings window: Tiny's api meta names its id. Anything else is refused. */
export const fromSettingsWindow = (meta: unknown): boolean => isRecord(meta) && meta.window === SETTINGS_WINDOW_ID;
