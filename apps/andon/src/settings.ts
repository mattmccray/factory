// The Mac app's stored settings, runtime-neutral: the keys and their types, the snapshot the Settings
// window reads (built from the stored values, plus whether `t3` was found), the validation for a
// change it asks for, and the window check both methods make first. backend.ts owns the stored
// values, answers the two methods only for the Settings window, and keeps the menu bar and every
// window in step.
import { STATUS_BAR_KEY, SETTINGS_WINDOW_ID, storedHidden } from './appmenu';
import { isRecord } from './state';

/** The two backend methods the Settings window calls (tinyjs.json's `api` gate names them). */
export const GET_SETTINGS_METHOD = 'getSettings';
export const SET_SETTING_METHOD = 'setSetting';

/** What the needs-human box's Approve and the sheets' Copy do besides copying (036): open a draft in
 *  T3 Code, send it in T3 Code right away, or copy only. */
export type HandoffMode = 'draft' | 'send' | 'copy';
export const HANDOFF_MODES: readonly HandoffMode[] = ['draft', 'send', 'copy'];
export const DEFAULT_HANDOFF_MODE: HandoffMode = 'draft';
/** The T3 Code setting's store key. */
export const T3_HANDOFF_KEY = 't3Handoff';

const isHandoffMode = (v: unknown): v is HandoffMode => HANDOFF_MODES.some((m) => m === v);

/** A stored hand-off mode: one of the three, else (nothing stored, or anything else) the default. */
export const storedMode = (v: unknown): HandoffMode => (isHandoffMode(v) ? v : DEFAULT_HANDOFF_MODE);

/** Every stored setting, by its store key, with its type. */
export interface StoredSettings {
  statusBarHidden: boolean;
  t3Handoff: HandoffMode;
}
export type SettingKey = keyof StoredSettings;

/** What the Settings window reads: the stored settings, and whether the Mac app found `t3`. */
export interface Settings extends StoredSettings {
  t3Found: boolean;
}

/** The keys, in order. `statusBarHidden` is STATUS_BAR_KEY, so the choice stored before carries over. */
export const SETTING_KEYS: readonly SettingKey[] = [STATUS_BAR_KEY, T3_HANDOFF_KEY];

/** One change the Settings window may ask for: a known key and a value of its type. */
export type SettingChange = { key: 'statusBarHidden'; value: boolean } | { key: 't3Handoff'; value: HandoffMode };

/** The snapshot from the stored values: exactly `true` means hidden, anything else (or nothing)
 *  shown; a hand-off mode that isn't one of the three is the default, draft. */
export const settingsSnapshot = (stored: Readonly<Partial<Record<SettingKey, unknown>>>, t3Found: boolean): Settings => ({
  statusBarHidden: storedHidden(stored.statusBarHidden),
  t3Handoff: storedMode(stored.t3Handoff),
  t3Found,
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
  if (key === 't3Handoff' && isHandoffMode(value)) return { key, value };
  return null;
}

/** The call came from the Settings window: Tiny's api meta names its id. Anything else is refused. */
export const fromSettingsWindow = (meta: unknown): boolean => isRecord(meta) && meta.window === SETTINGS_WINDOW_ID;
