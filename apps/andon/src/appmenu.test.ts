import { describe, expect, test } from 'bun:test';
import {
  GITHUB_ID,
  GITHUB_URL,
  MINIMIZE_ID,
  SETTINGS_ID,
  SETTINGS_SIZE,
  SETTINGS_TITLE,
  SETTINGS_WINDOW_ID,
  SHOW_MAIN_ID,
  STATUS_BAR_EVENT,
  STATUS_BAR_ID,
  WHATS_NEW_EVENT,
  WHATS_NEW_ID,
  ZOOM_ID,
  appMenu,
  menuAction,
  settingsUrl,
  settingsWindow,
  statusBarLabel,
  statusBarPayload,
  storedHidden,
  whatsNewPayload,
} from './appmenu';
import type { Menu } from './appmenu';

const expected = (toggle: string): Menu[] => [
  { role: 'app', items: [{ id: SETTINGS_ID, label: 'Settings…', key: ',', enabled: true }] },
  { role: 'edit' },
  { title: 'View', items: [{ id: STATUS_BAR_ID, label: toggle, key: '/' }] },
  {
    title: 'Window',
    items: [{ id: MINIMIZE_ID, label: 'Minimize', key: 'm' }, { id: ZOOM_ID, label: 'Zoom' }, { separator: true }, { id: SHOW_MAIN_ID, label: 'Andon', key: '0' }],
  },
  { title: 'Help', role: 'help', items: [{ id: WHATS_NEW_ID, label: "What's New" }, { id: GITHUB_ID, label: 'Factory on GitHub' }] },
];

describe('AC1: the menu spec', () => {
  test('shown: the bar is Andon, Edit, View (Hide Status Bar), Window, Help, exactly', () => {
    expect(appMenu(false)).toEqual(expected('Hide Status Bar'));
  });

  test('hidden: the same bar, with the toggle reading Show Status Bar', () => {
    expect(appMenu(true)).toEqual(expected('Show Status Bar'));
    expect(statusBarLabel(true)).toBe('Show Status Bar');
    expect(statusBarLabel(false)).toBe('Hide Status Bar');
  });

  test('every clickable item has a unique id', () => {
    const items = appMenu(false).flatMap((m) => m.items ?? []).filter((i) => i.separator !== true);
    const ids = items.map((i) => i.id);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(7);
  });
});

describe('AC2: clicks and the stored value', () => {
  test('each id maps to its action; unknown ids do nothing', () => {
    expect(menuAction(SETTINGS_ID)).toEqual({ kind: 'open-settings' });
    expect(menuAction(STATUS_BAR_ID)).toEqual({ kind: 'toggle-status-bar' });
    expect(menuAction(MINIMIZE_ID)).toEqual({ kind: 'minimize' });
    expect(menuAction(ZOOM_ID)).toEqual({ kind: 'zoom' });
    expect(menuAction(SHOW_MAIN_ID)).toEqual({ kind: 'show-main' });
    expect(menuAction(GITHUB_ID)).toEqual({ kind: 'open', url: 'https://github.com/mattmccray/factory' });
    expect(GITHUB_URL).toBe('https://github.com/mattmccray/factory');
    for (const id of ['about', 'SETTINGS', 'settings-window', 'show', 'quit', '', 'STATUSBAR']) expect({ id, action: menuAction(id) }).toEqual({ id, action: null });
  });

  test('only a stored true means hidden; missing or malformed means shown', () => {
    expect(storedHidden(true)).toBe(true);
    for (const v of [false, null, undefined, 'true', 1, 0, {}, [], { hidden: true }]) expect({ v, hidden: storedHidden(v) }).toEqual({ v, hidden: false });
  });

  test('the pushed event is `statusbar` carrying { hidden }', () => {
    expect(STATUS_BAR_EVENT).toBe('statusbar');
    expect(statusBarPayload(true)).toEqual({ hidden: true });
    expect(statusBarPayload(false)).toEqual({ hidden: false });
  });
});

describe('035 AC1: Settings… and the Settings window', () => {
  test('Settings… is enabled with ⌘, for either status bar state', () => {
    for (const hidden of [false, true]) {
      const item = appMenu(hidden)[0]?.items?.[0];
      expect(item).toEqual({ id: SETTINGS_ID, label: 'Settings…', key: ',', enabled: true });
    }
  });

  test('the window: id `settings`, titled Settings, a fixed size, a standard frame with only the close button, a child of main, the settings view on the port', () => {
    expect(SETTINGS_WINDOW_ID).toBe('settings');
    expect(SETTINGS_TITLE).toBe('Settings');
    expect(SETTINGS_SIZE).toMatch(/^\d+x\d+$/);
    expect(settingsUrl(8766)).toBe('http://127.0.0.1:8766/?shell=mac&view=settings');
    expect(settingsUrl(9123)).toBe('http://127.0.0.1:9123/?shell=mac&view=settings');
    expect(settingsWindow(9123)).toEqual({
      page: 'http://127.0.0.1:9123/?shell=mac&view=settings',
      title: 'Settings',
      size: SETTINGS_SIZE,
      minSize: SETTINGS_SIZE,
      chrome: { frame: true, windowControls: ['close'] },
      parent: 'main',
    });
  });
});

describe("059 AC8: Help → What's New", () => {
  test("Help lists What's New above Factory on GitHub, for either status bar state", () => {
    for (const hidden of [false, true]) {
      const help = appMenu(hidden).find((m) => m.title === 'Help');
      expect(help).toEqual({ title: 'Help', role: 'help', items: [{ id: WHATS_NEW_ID, label: "What's New" }, { id: GITHUB_ID, label: 'Factory on GitHub' }] });
    }
  });

  test('its id maps to the action that shows the main window and pushes the whatsnew event', () => {
    expect(WHATS_NEW_ID).toBe('whatsnew');
    expect(menuAction(WHATS_NEW_ID)).toEqual({ kind: 'whats-new' });
    expect(WHATS_NEW_EVENT).toBe('whatsnew');
    expect(whatsNewPayload()).toEqual({});
    for (const id of ['whats-new', 'WhatsNew', 'changelog']) expect({ id, action: menuAction(id) }).toEqual({ id, action: null });
  });
});
