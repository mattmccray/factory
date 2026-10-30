// The Mac app's menu bar: Andon (Settings…, which opens the Settings window), the stock Edit menu,
// View (the status bar toggle), Window (Minimize, Zoom, Andon), and Help (What's New, which shows the
// main window and asks the board to open its What's New sheet, and the project on GitHub).
// The menu spec, its ids, the label for a status bar state, what a click does, how the stored status
// bar choice reads, and the Settings window's id, title, size, page, and chrome all live here,
// runtime-neutral; backend.ts sets the menu, opens the window, and carries out the actions.
import { serviceUrl } from './autostart';

/** The repo page Help → Factory on GitHub opens. One constant, easy to change at publication. */
export const GITHUB_URL = 'https://github.com/mattmccray/factory';

/** The event the Mac app pushes to the page with the status bar state (`{ hidden }`). */
export const STATUS_BAR_EVENT = 'statusbar';
/** The event the Mac app pushes to the page when Help → What's New is chosen (`{}`): the page opens its whole What's New sheet. */
export const WHATS_NEW_EVENT = 'whatsnew';
/** The store key holding the status bar choice: `true` when hidden. */
export const STATUS_BAR_KEY = 'statusBarHidden';

// The ids of the clickable items.
export const SETTINGS_ID = 'settings';
export const STATUS_BAR_ID = 'statusbar';
export const MINIMIZE_ID = 'minimize';
export const ZOOM_ID = 'zoom';
export const SHOW_MAIN_ID = 'andon';
export const WHATS_NEW_ID = 'whatsnew';
export const GITHUB_ID = 'github';

/** One menu item, in the shape the menu bar takes. */
export interface MenuItem {
  id?: string;
  label?: string;
  /** ⌘ + this key */
  key?: string;
  /** false: grayed out */
  enabled?: boolean;
  separator?: boolean;
}

/** One menu in the bar: one of our own (a title and items), or a stock one by role. */
export interface Menu {
  title?: string;
  role?: 'app' | 'edit' | 'help';
  items?: MenuItem[];
}

/** The View menu's toggle label: it names what choosing it does. */
export const statusBarLabel = (hidden: boolean): string => (hidden ? 'Show Status Bar' : 'Hide Status Bar');

/** The whole menu bar, in bar order, for a status bar state. */
export function appMenu(hidden: boolean): Menu[] {
  return [
    { role: 'app', items: [{ id: SETTINGS_ID, label: 'Settings…', key: ',', enabled: true }] },
    { role: 'edit' },
    { title: 'View', items: [{ id: STATUS_BAR_ID, label: statusBarLabel(hidden), key: '/' }] },
    {
      title: 'Window',
      items: [{ id: MINIMIZE_ID, label: 'Minimize', key: 'm' }, { id: ZOOM_ID, label: 'Zoom' }, { separator: true }, { id: SHOW_MAIN_ID, label: 'Andon', key: '0' }],
    },
    { title: 'Help', role: 'help', items: [{ id: WHATS_NEW_ID, label: "What's New" }, { id: GITHUB_ID, label: 'Factory on GitHub' }] },
  ];
}

/** What a menu click does. */
export type MenuAction =
  | { kind: 'open-settings' }
  | { kind: 'toggle-status-bar' }
  | { kind: 'minimize' }
  | { kind: 'zoom' }
  | { kind: 'show-main' }
  | { kind: 'whats-new' } // show the main window, then push WHATS_NEW_EVENT: the page routes itself
  | { kind: 'open'; url: string };

/** The action for a clicked id; null for any id that isn't ours. */
export function menuAction(id: string): MenuAction | null {
  switch (id) {
    case SETTINGS_ID:
      return { kind: 'open-settings' };
    case STATUS_BAR_ID:
      return { kind: 'toggle-status-bar' };
    case MINIMIZE_ID:
      return { kind: 'minimize' };
    case ZOOM_ID:
      return { kind: 'zoom' };
    case SHOW_MAIN_ID:
      return { kind: 'show-main' };
    case WHATS_NEW_ID:
      return { kind: 'whats-new' };
    case GITHUB_ID:
      return { kind: 'open', url: GITHUB_URL };
    default:
      return null;
  }
}

/** The stored status bar choice: exactly `true` is hidden; missing or anything else is shown. */
export const storedHidden = (value: unknown): boolean => value === true;

/** The payload of the What's New event: nothing to carry, the page opens the whole sheet. */
export const whatsNewPayload = (): Record<string, never> => ({});

/** The payload of the status bar event. */
export const statusBarPayload = (hidden: boolean): { hidden: boolean } => ({ hidden });

// ---- the Settings window ----

/** The Settings window's id: Tiny's api meta names it, and only calls from it are answered. */
export const SETTINGS_WINDOW_ID = 'settings';
export const SETTINGS_TITLE = 'Settings';
/** Fixed: the window opens at this size and can't be resized. */
export const SETTINGS_SIZE = '480x360';
/** The query that tells the page it is the Settings view (in the Mac app). */
export const SETTINGS_QUERY = '?shell=mac&view=settings';

/** The Settings page: the same index.html the service serves at `/`, in its settings view. */
export const settingsUrl = (port: number): string => `${serviceUrl(port)}/${SETTINGS_QUERY}`;

/** The Settings window's options: what `settingsWindow` returns. */
export interface SettingsWindowOptions {
  page: string;
  title: string;
  size: string;
  minSize: string;
  chrome: { frame: true; windowControls: ['close'] };
  parent: 'main';
}

/** How the Settings window opens: a standard titled frame (not the main window's frameless chrome)
 *  with only the close button (a fixed-size settings window has nothing to minimize or zoom), the
 *  settings page on the service's port, at its fixed size, as a child of the main window: it stays
 *  above the board and moves, hides, and minimizes with it, while the board stays usable (not modal).
 *  `parent` is open-time only in Tiny, so it is here, not set afterward. */
export const settingsWindow = (port: number): SettingsWindowOptions => ({
  page: settingsUrl(port),
  title: SETTINGS_TITLE,
  size: SETTINGS_SIZE,
  minSize: SETTINGS_SIZE,
  chrome: { frame: true, windowControls: ['close'] },
  parent: 'main',
});
