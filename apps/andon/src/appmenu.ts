// The Mac app's menu bar: Andon (About Andon, which opens the About window in place of the stock
// About panel, and Settings…, which opens the Settings window), the stock Edit menu,
// View (the board's view toggles: Needs Me, the Settled sheet, the sidebar, the inspector, the status
// bar, and the Merged column; labels flip, Finder-style, to name what choosing them does), Window (Minimize, Zoom, Andon), and Help (What's New, which shows the
// main window and asks the board to open its What's New sheet, and the project on GitHub).
// The menu spec, its ids, the label for a status bar state, what a click does, how the stored status
// bar choice reads, and the Settings and About windows' ids, titles, sizes, pages, and chrome all live here,
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
/** The event the Mac app pushes to the page with the Merged column state (`{ hidden }`). */
export const MERGED_EVENT = 'merged';
/** The store key holding the Merged column choice: `true` when hidden. */
export const MERGED_KEY = 'mergedHidden';
// The events the Mac app pushes to the main window's page for the View menu's page actions (`{}`):
// the page toggles Needs Me, opens the Settled sheet, toggles the sidebar, or toggles the inspector.
export const NEEDS_ME_EVENT = 'needsme';
export const SETTLED_EVENT = 'settled';
export const SIDEBAR_EVENT = 'sidebar';
export const INSPECTOR_EVENT = 'inspector';
/** A View menu action the page carries out: one of the four events above. */
export type PageEvent = typeof NEEDS_ME_EVENT | typeof SETTLED_EVENT | typeof SIDEBAR_EVENT | typeof INSPECTOR_EVENT;

// The ids of the clickable items.
/** Tiny's reserved id for the app menu's About item: with tinyjs.json `"about": "menu"`, a click on
 *  it fires here instead of showing the stock About panel. */
export const ABOUT_ID = 'about';
export const SETTINGS_ID = 'settings';
export const STATUS_BAR_ID = 'statusbar';
export const NEEDS_ME_ID = 'needsme';
export const SETTLED_ID = 'settled';
export const SIDEBAR_ID = 'sidebar';
export const INSPECTOR_ID = 'inspector';
export const MERGED_ID = 'merged';
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

/** The main window's view state, as its page reports it (the view-state method): whether Needs Me
 *  is on, whether the sidebar is shown (the effective state, the narrow-window rule included), and
 *  whether the inspector is open. Not stored: the page reports it again after every load. */
export interface ViewState {
  needsMe: boolean;
  sidebarShown: boolean;
  inspectorOpen: boolean;
}

/** The page's view on load, before it reports: everything, the sidebar shown, no inspector. */
export const DEFAULT_VIEW: Readonly<ViewState> = { needsMe: false, sidebarShown: true, inspectorOpen: false };

/** Everything the menu bar's labels depend on: the two stored choices and the page's view state. */
export interface MenuState {
  statusBarHidden: boolean;
  mergedHidden: boolean;
  view: ViewState;
}

// The View menu's toggle labels: each names what choosing it does.
export const statusBarLabel = (hidden: boolean): string => (hidden ? 'Show Status Bar' : 'Hide Status Bar');
export const mergedLabel = (hidden: boolean): string => (hidden ? 'Show Merged Column' : 'Hide Merged Column');
export const needsMeLabel = (on: boolean): string => (on ? 'Show All Jobs' : 'Show Only Needs Me');
export const sidebarLabel = (shown: boolean): string => (shown ? 'Hide Sidebar' : 'Show Sidebar');
export const inspectorLabel = (open: boolean): string => (open ? 'Hide Inspector' : 'Show Inspector');
/** "Show Settled…" opens the sheet; its label never flips. */
export const SETTLED_LABEL = 'Show Settled…';

/** The View menu, in order, for a state. Tiny's key spelling: an uppercase letter carries its own
 *  shift ('N' is ⇧⌘N), and `alt+`/`ctrl+` add ⌥/⌃ to ⌘. */
export function viewMenu(s: MenuState): MenuItem[] {
  return [
    { id: NEEDS_ME_ID, label: needsMeLabel(s.view.needsMe), key: 'N' },
    { id: SETTLED_ID, label: SETTLED_LABEL, key: 'S' },
    { separator: true },
    { id: SIDEBAR_ID, label: sidebarLabel(s.view.sidebarShown), key: 'ctrl+s' },
    { id: INSPECTOR_ID, label: inspectorLabel(s.view.inspectorOpen), key: 'alt+i' },
    { separator: true },
    { id: STATUS_BAR_ID, label: statusBarLabel(s.statusBarHidden), key: '/' },
    { id: MERGED_ID, label: mergedLabel(s.mergedHidden) },
  ];
}

/** The labels a view state change touches: each item whose boolean differs, with its new label. */
export function viewLabelUpdates(prev: ViewState, next: ViewState): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  if (prev.needsMe !== next.needsMe) out.push({ id: NEEDS_ME_ID, label: needsMeLabel(next.needsMe) });
  if (prev.sidebarShown !== next.sidebarShown) out.push({ id: SIDEBAR_ID, label: sidebarLabel(next.sidebarShown) });
  if (prev.inspectorOpen !== next.inspectorOpen) out.push({ id: INSPECTOR_ID, label: inspectorLabel(next.inspectorOpen) });
  return out;
}

/** The whole menu bar, in bar order, for a state. */
export function appMenu(s: MenuState): Menu[] {
  return [
    { role: 'app', items: [{ id: SETTINGS_ID, label: 'Settings…', key: ',', enabled: true }] },
    { role: 'edit' },
    { title: 'View', items: viewMenu(s) },
    {
      title: 'Window',
      items: [{ id: MINIMIZE_ID, label: 'Minimize', key: 'm' }, { id: ZOOM_ID, label: 'Zoom' }, { separator: true }, { id: SHOW_MAIN_ID, label: 'Andon', key: '0' }],
    },
    { title: 'Help', role: 'help', items: [{ id: WHATS_NEW_ID, label: "What's New" }, { id: GITHUB_ID, label: 'Factory on GitHub' }] },
  ];
}

/** What a menu click does. */
export type MenuAction =
  | { kind: 'open-about' }
  | { kind: 'open-settings' }
  | { kind: 'toggle-status-bar' }
  | { kind: 'toggle-merged' }
  | { kind: 'page'; event: PageEvent; show: boolean } // push `event` to the page; `show`: show the main window first
  | { kind: 'minimize' }
  | { kind: 'zoom' }
  | { kind: 'show-main' }
  | { kind: 'whats-new' } // show the main window, then push WHATS_NEW_EVENT: the page routes itself
  | { kind: 'open'; url: string };

/** The action for a clicked id; null for any id that isn't ours. */
export function menuAction(id: string): MenuAction | null {
  switch (id) {
    case ABOUT_ID:
      return { kind: 'open-about' };
    case SETTINGS_ID:
      return { kind: 'open-settings' };
    case STATUS_BAR_ID:
      return { kind: 'toggle-status-bar' };
    case MERGED_ID:
      return { kind: 'toggle-merged' };
    case NEEDS_ME_ID:
      return { kind: 'page', event: NEEDS_ME_EVENT, show: false };
    case SETTLED_ID:
      return { kind: 'page', event: SETTLED_EVENT, show: true }; // a sheet: show the board, as What's New does
    case SIDEBAR_ID:
      return { kind: 'page', event: SIDEBAR_EVENT, show: false };
    case INSPECTOR_ID:
      return { kind: 'page', event: INSPECTOR_EVENT, show: false };
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

/** The payload of the Merged column event. */
export const mergedPayload = (hidden: boolean): { hidden: boolean } => ({ hidden });

/** The payload of a page action event: nothing to carry, the page toggles (or opens) on its own state. */
export const pageEventPayload = (): Record<string, never> => ({});

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

// ---- the About window ----

/** The About window's id: Tiny's api meta names it, and only calls from it are answered (about.ts). */
export const ABOUT_WINDOW_ID = 'about';
export const ABOUT_TITLE = 'About Andon';
/** Fixed: the window opens at this size and can't be resized. The art (2:1) spans its width. */
export const ABOUT_SIZE = '440x400';
/** The query that tells the page it is the about view (in the Mac app). */
export const ABOUT_QUERY = '?shell=mac&view=about';

/** The About page: the same index.html the service serves at `/`, in its about view. */
export const aboutUrl = (port: number): string => `${serviceUrl(port)}/${ABOUT_QUERY}`;

/** The About window's options: what `aboutWindow` returns. */
export interface AboutWindowOptions {
  page: string;
  title: string;
  size: string;
  minSize: string;
  chrome: { frame: true; windowControls: ['close'] };
}

/** How the About window opens: a standard titled frame with only the close button (nothing to
 *  minimize or zoom in a fixed-size window), the about page on the service's port, at its fixed
 *  size. Not a child of the main window: it stands on its own, and the main window is unaffected. */
export const aboutWindow = (port: number): AboutWindowOptions => ({
  page: aboutUrl(port),
  title: ABOUT_TITLE,
  size: ABOUT_SIZE,
  minSize: ABOUT_SIZE,
  chrome: { frame: true, windowControls: ['close'] },
});
