// The Mac app's Settings window: its page is this UI's settings view (`?shell=mac&view=settings`,
// see sidebar.ts `appView`). The settings are the Mac app's (its backend stores them and keeps the
// menu bar and every window in step); the page reads them and asks for one change at a time, through
// the two backend methods it may call, which the backend answers only for the Settings window. The
// page hears changes made elsewhere (the View menu, ⌘/) through the pushed status bar event.
// In a browser nothing here does anything. Nothing here touches the DOM; Settings.svelte lays it out.
import { isRecord } from './job';
import type { ShellMode } from './sidebar';

/** The two Mac app backend methods the settings view calls (tinyjs.json's `api` gate enables them by name). */
export const GET_SETTINGS_METHOD = 'getSettings';
export const SET_SETTING_METHOD = 'setSetting';

/** The Mac app's settings, as the backend answers them. */
export interface Settings {
  statusBarHidden: boolean;
}

/** The settings in a backend answer, or null for anything malformed (or a refused call's null). */
export function narrowSettings(data: unknown): Settings | null {
  return isRecord(data) && typeof data.statusBarHidden === 'boolean' ? { statusBarHidden: data.statusBarHidden } : null;
}

/** "Show status bar" is checked when the status bar isn't hidden. */
export const showsStatusBar = (s: Settings): boolean => !s.statusBarHidden;

export interface SettingsApi {
  /** The current settings; null when the backend refuses or fails. */
  get(): Promise<Settings | null>;
  /** Set whether the status bar is hidden; resolves with the settings after, or null. */
  setStatusBarHidden(hidden: boolean): Promise<Settings | null>;
}

/**
 * How the settings view talks to the Mac app: Tiny's backend call, found by narrowing the page's
 * `window.tiny` (passed in as `unknown`), and only ever with the two fixed method names. Null in a
 * browser, or when it isn't there.
 */
export function settingsCaller(mode: ShellMode, host: unknown): SettingsApi | null {
  if (mode !== 'mac' || !isRecord(host) || !isRecord(host.api)) return null;
  const api = host.api;
  const call = api.call;
  if (typeof call !== 'function') return null;
  /** The answer of one call, narrowed; null when it throws or rejects. */
  const answer = async (send: () => unknown): Promise<Settings | null> => {
    try {
      const r: unknown = await send();
      return narrowSettings(r);
    } catch {
      return null;
    }
  };
  return {
    get: () => answer(() => Reflect.apply(call, api, [GET_SETTINGS_METHOD, null])),
    setStatusBarHidden: (hidden) => answer(() => Reflect.apply(call, api, [SET_SETTING_METHOD, { key: 'statusBarHidden', value: hidden }])),
  };
}
