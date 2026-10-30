// The Mac app's Settings window: its page is this UI's settings view (`?shell=mac&view=settings`,
// see sidebar.ts `appView`). The settings are the Mac app's (its backend stores them and keeps the
// menu bar and every window in step); the page reads them and asks for one change at a time, through
// the two settings methods it may call, which the backend answers only for the Settings window. The
// page hears changes made elsewhere (the View menu, ⌘/) through the pushed status bar and Merged
// column events. "Show Merged column" (063) shows or hides the board's Merged column. The T3
// Code choice (036) says what the needs-human box's Approve and the sheets' Copy do besides copying;
// the answer also says whether the Mac app found `t3`, and without it the choices are grayed out.
// In a browser nothing here does anything. Nothing here touches the DOM; Settings.svelte lays it out.
import { isRecord } from './job';
import type { ShellMode } from './sidebar';

/** The two Mac app backend methods the settings view calls (tinyjs.json's `api` gate enables them by name). */
export const GET_SETTINGS_METHOD = 'getSettings';
export const SET_SETTING_METHOD = 'setSetting';

/** What the Mac app does with a needs-human command besides copying it: open a draft in T3 Code,
 *  send it in T3 Code right away, or copy only. */
export type HandoffMode = 'draft' | 'send' | 'copy';

/** The T3 Code section's choices, in order, with their labels. */
export const HANDOFF_CHOICES: readonly { mode: HandoffMode; label: string }[] = [
  { mode: 'draft', label: 'Open a draft in T3 Code' },
  { mode: 'send', label: 'Send in T3 Code right away' },
  { mode: 'copy', label: 'Copy only' },
];

const isHandoffMode = (v: unknown): v is HandoffMode => HANDOFF_CHOICES.some((c) => c.mode === v);

/** The Mac app's settings, as the backend answers them: the stored choices, and whether `t3` was found. */
export interface Settings {
  statusBarHidden: boolean;
  t3Handoff: HandoffMode;
  mergedHidden: boolean;
  t3Found: boolean;
}

/** The settings in a backend answer, or null for anything malformed (or a refused call's null). */
export function narrowSettings(data: unknown): Settings | null {
  if (!isRecord(data)) return null;
  const { statusBarHidden, t3Handoff, mergedHidden, t3Found } = data;
  if (typeof statusBarHidden !== 'boolean' || !isHandoffMode(t3Handoff) || typeof mergedHidden !== 'boolean' || typeof t3Found !== 'boolean') return null;
  return { statusBarHidden, t3Handoff, mergedHidden, t3Found };
}

/** "Show status bar" is checked when the status bar isn't hidden. */
export const showsStatusBar = (s: Settings): boolean => !s.statusBarHidden;

/** "Show Merged column" is checked when the Merged column isn't hidden. */
export const showsMerged = (s: Settings): boolean => !s.mergedHidden;

export interface SettingsApi {
  /** The current settings; null when the backend refuses or fails. */
  get(): Promise<Settings | null>;
  /** Set whether the status bar is hidden; resolves with the settings after, or null. */
  setStatusBarHidden(hidden: boolean): Promise<Settings | null>;
  /** Set the T3 Code choice; resolves with the settings after, or null. */
  setT3Handoff(mode: HandoffMode): Promise<Settings | null>;
  /** Set whether the Merged column is hidden; resolves with the settings after, or null. */
  setMergedHidden(hidden: boolean): Promise<Settings | null>;
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
    setT3Handoff: (mode) => answer(() => Reflect.apply(call, api, [SET_SETTING_METHOD, { key: 't3Handoff', value: mode }])),
    setMergedHidden: (hidden) => answer(() => Reflect.apply(call, api, [SET_SETTING_METHOD, { key: 'mergedHidden', value: hidden }])),
  };
}
