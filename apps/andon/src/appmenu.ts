// The Mac app's menu bar: Andon (Settings…, which opens the Settings window), the stock Edit menu,
// View (the status bar toggle), Window (Minimize, Zoom, Andon), and Help (the project on GitHub).
// The menu spec, its ids, the label for a status bar state, what a click does, how the stored status
// bar choice reads, and the Settings window's id, title, size, and page all live here,
// runtime-neutral; backend.ts sets the menu, opens the window, and carries out the actions.
import { serviceUrl } from './autostart';

/** The repo page Help → Factory on GitHub opens. One constant, easy to change at publication. */
export const GITHUB_URL = 'https://github.com/mattmccray/factory';

/** The event the Mac app pushes to the page with the status bar state (`{ hidden }`). */
export const STATUS_BAR_EVENT = 'statusbar';
/** The store key holding the status bar choice: `true` when hidden. */
export const STATUS_BAR_KEY = 'statusBarHidden';

// The ids of the clickable items.
export const SETTINGS_ID = 'settings';
export const STATUS_BAR_ID = 'statusbar';
export const MINIMIZE_ID = 'minimize';
export const ZOOM_ID = 'zoom';
export const SHOW_MAIN_ID = 'andon';
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
    { title: 'Help', role: 'help', items: [{ id: GITHUB_ID, label: 'Factory on GitHub' }] },
  ];
}

/** What a menu click does. */
export type MenuAction =
  | { kind: 'open-settings' }
  | { kind: 'toggle-status-bar' }
  | { kind: 'minimize' }
  | { kind: 'zoom' }
  | { kind: 'show-main' }
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
    case GITHUB_ID:
      return { kind: 'open', url: GITHUB_URL };
    default:
      return null;
  }
}

/** The stored status bar choice: exactly `true` is hidden; missing or anything else is shown. */
export const storedHidden = (value: unknown): boolean => value === true;

/** The payload of the status bar event. */
export const statusBarPayload = (hidden: boolean): { hidden: boolean } => ({ hidden });

// ---- the Settings window ----

/** The Settings window's id: Tiny's api meta names it, and only calls from it are answered. */
export const SETTINGS_WINDOW_ID = 'settings';
export const SETTINGS_TITLE = 'Settings';
/** Fixed: the window opens at this size and can't be resized. */
export const SETTINGS_SIZE = '480x260';
/** The query that tells the page it is the Settings view (in the Mac app). */
export const SETTINGS_QUERY = '?shell=mac&view=settings';

/** The Settings page: the same index.html the service serves at `/`, in its settings view. */
export const settingsUrl = (port: number): string => `${serviceUrl(port)}/${SETTINGS_QUERY}`;

/** How the Settings window opens: a standard titled frame (not the main window's frameless chrome),
 *  the settings page on the service's port, at its fixed size. */
export const settingsWindow = (port: number): { page: string; title: string; size: string; minSize: string; chrome: { frame: true } } => ({
  page: settingsUrl(port),
  title: SETTINGS_TITLE,
  size: SETTINGS_SIZE,
  minSize: SETTINGS_SIZE,
  chrome: { frame: true },
});
