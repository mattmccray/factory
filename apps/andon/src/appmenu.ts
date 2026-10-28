// The Mac app's menu bar: Andon (a disabled Settings… placeholder), the stock Edit menu, View (the
// status bar toggle), Window (Minimize, Zoom, Andon), and Help (the project on GitHub). The menu
// spec, its ids, the label for a status bar state, what a click does, and how the stored status bar
// choice reads all live here, runtime-neutral; backend.ts sets the menu and carries out the actions.

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
    { role: 'app', items: [{ id: SETTINGS_ID, label: 'Settings…', key: ',', enabled: false }] },
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
export type MenuAction = { kind: 'toggle-status-bar' } | { kind: 'minimize' } | { kind: 'zoom' } | { kind: 'show-main' } | { kind: 'open'; url: string };

/** The action for a clicked id; null for Settings… (a placeholder) and any id that isn't ours. */
export function menuAction(id: string): MenuAction | null {
  switch (id) {
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
