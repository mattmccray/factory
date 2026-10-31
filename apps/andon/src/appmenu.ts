// The Mac app's menu bar: Andon (About Andon, which opens the About window in place of the stock
// About panel, and Settings…, which opens the Settings window), File (Close Window, ⌘W, which closes
// Settings or About or hides the main window, whichever is focused), the stock Edit menu,
// View (the board's view toggles: Needs Me, the Settled and Backlog sheets, the sidebar, the inspector, the status
// bar, and the Merged column; labels flip, Finder-style, to name what choosing them does), Window (Minimize, Zoom, Andon), and Help (What's New, which shows the
// main window and asks the board to open its What's New sheet, and the project on GitHub).
// File also leads with New Exploration… (⌘N), which shows the main window and asks its page to
// open the New exploration sheet (the `startwork` event, a request only: the page checks it).
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
// the page toggles Needs Me, opens the Settled sheet, opens the Backlog sheet, toggles the sidebar,
// or toggles the inspector.
export const NEEDS_ME_EVENT = 'needsme';
export const SETTLED_EVENT = 'settled';
export const BACKLOG_EVENT = 'backlog';
export const SIDEBAR_EVENT = 'sidebar';
export const INSPECTOR_EVENT = 'inspector';
/** The event the Mac app pushes to ask the main window's page to start work: File → New
 *  Exploration… and a project's right-click New Exploration… and Run Next. Its payload is a request
 *  only (`StartWorkPush`): the page checks it, and `startWork` stays the one path that builds a command. */
export const START_WORK_EVENT = 'startwork';
/** The startwork event's payload: open the New exploration sheet (for a project, or, with null, the
 *  one the page picks), or Run next on a project. Nothing else is ever sent. */
export type StartWorkPush = { action: 'new-exploration'; project: string | null } | { action: 'next'; project: string };
/** The payload of the startwork event: exactly the action and the project, nothing else carried. */
export const startWorkPayload = (push: StartWorkPush): StartWorkPush =>
  push.action === 'next' ? { action: 'next', project: push.project } : { action: 'new-exploration', project: push.project };
/** A View menu action the page carries out: one of the five events above. */
export type PageEvent = typeof NEEDS_ME_EVENT | typeof SETTLED_EVENT | typeof BACKLOG_EVENT | typeof SIDEBAR_EVENT | typeof INSPECTOR_EVENT;

// The ids of the clickable items.
/** Tiny's reserved id for the app menu's About item: with tinyjs.json `"about": "menu"`, a click on
 *  it fires here instead of showing the stock About panel. */
export const ABOUT_ID = 'about';
export const SETTINGS_ID = 'settings';
export const CLOSE_WINDOW_ID = 'closewindow';
export const NEW_EXPLORATION_ID = 'newexploration';
export const STATUS_BAR_ID = 'statusbar';
export const NEEDS_ME_ID = 'needsme';
export const SETTLED_ID = 'settled';
export const BACKLOG_ID = 'backlog';
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
/** "Show Backlog…" opens the Backlog sheet; its label never flips either. */
export const BACKLOG_LABEL = 'Show Backlog…';

/** The View menu, in order, for a state. Tiny's key spelling: an uppercase letter carries its own
 *  shift ('N' is ⇧⌘N), and `alt+`/`ctrl+` add ⌥/⌃ to ⌘. */
export function viewMenu(s: MenuState): MenuItem[] {
  return [
    { id: NEEDS_ME_ID, label: needsMeLabel(s.view.needsMe), key: 'N' },
    { id: SETTLED_ID, label: SETTLED_LABEL, key: 'S' },
    { id: BACKLOG_ID, label: BACKLOG_LABEL, key: 'B' },
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

/** The File menu, in order: New Exploration… (⌘N), then Close Window (⌘W). New items go in this list (no other menu moves). */
export function fileMenu(): MenuItem[] {
  return [
    { id: NEW_EXPLORATION_ID, label: 'New Exploration…', key: 'n' },
    { id: CLOSE_WINDOW_ID, label: 'Close Window', key: 'w' },
  ];
}

/** The whole menu bar, in bar order, for a state. */
export function appMenu(s: MenuState): Menu[] {
  return [
    { role: 'app', items: [{ id: SETTINGS_ID, label: 'Settings…', key: ',', enabled: true }] },
    { title: 'File', items: fileMenu() },
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
  | { kind: 'close-window' } // close the focused Settings or About window, or hide the focused main window
  | { kind: 'toggle-status-bar' }
  | { kind: 'toggle-merged' }
  | { kind: 'page'; event: PageEvent; show: boolean } // push `event` to the page; `show`: show the main window first
  | { kind: 'minimize' }
  | { kind: 'zoom' }
  | { kind: 'show-main' }
  | { kind: 'whats-new' } // show the main window, then push WHATS_NEW_EVENT: the page routes itself
  | { kind: 'start-work'; payload: StartWorkPush } // show the main window, then push START_WORK_EVENT with `payload`
  | { kind: 'open'; url: string };

/** The action for a clicked id; null for any id that isn't ours. */
export function menuAction(id: string): MenuAction | null {
  switch (id) {
    case ABOUT_ID:
      return { kind: 'open-about' };
    case SETTINGS_ID:
      return { kind: 'open-settings' };
    case NEW_EXPLORATION_ID:
      return { kind: 'start-work', payload: startWorkPayload({ action: 'new-exploration', project: null }) }; // the page picks the project
    case CLOSE_WINDOW_ID:
      return { kind: 'close-window' };
    case STATUS_BAR_ID:
      return { kind: 'toggle-status-bar' };
    case MERGED_ID:
      return { kind: 'toggle-merged' };
    case NEEDS_ME_ID:
      return { kind: 'page', event: NEEDS_ME_EVENT, show: false };
    case SETTLED_ID:
      return { kind: 'page', event: SETTLED_EVENT, show: true }; // a sheet: show the board, as What's New does
    case BACKLOG_ID:
      return { kind: 'page', event: BACKLOG_EVENT, show: true }; // a sheet, as Settled
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

/** What Close Window does to a window: `close` Settings or About, `hide` the main window (as its
 *  close button does: Andon never quits from it). */
export interface CloseStep {
  id: string;
  step: 'close' | 'hide';
}

/** Close Window's target, from the ids of the open windows that report focus: the one Andon window
 *  among them (main, Settings, or About). None, or more than one, is null: nothing happens, never a
 *  guess. */
export function closeWindowStep(focused: readonly string[]): CloseStep | null {
  const ours = focused.filter((id) => id === 'main' || id === SETTINGS_WINDOW_ID || id === ABOUT_WINDOW_ID);
  const [id] = ours;
  if (ours.length !== 1 || id === undefined) return null;
  return { id, step: id === 'main' ? 'hide' : 'close' };
}

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
  /** The top-left, from `placeOnMain`: an explicit position beats the one Tiny remembers. */
  x?: number;
  y?: number;
}

/** How the Settings window opens: a standard titled frame (not the main window's frameless chrome)
 *  with only the close button (a fixed-size settings window has nothing to minimize or zoom), the
 *  settings page on the service's port, at its fixed size, as a child of the main window: it stays
 *  above the board and moves, hides, and minimizes with it, while the board stays usable (not modal).
 *  `parent` is open-time only in Tiny, so it is here, not set afterward. */
export const settingsWindow = (port: number, at: Point | null = null): SettingsWindowOptions => {
  const base: SettingsWindowOptions = {
    page: settingsUrl(port),
    title: SETTINGS_TITLE,
    size: SETTINGS_SIZE,
    minSize: SETTINGS_SIZE,
    chrome: { frame: true, windowControls: ['close'] },
    parent: 'main',
  };
  return at === null ? base : { ...base, x: at.x, y: at.y };
};

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
  chrome: { frame: false; windowControls: ['close'] };
  parent: 'main';
  /** The top-left, from `placeOnMain`, as Settings has. */
  x?: number;
  y?: number;
}

/** How the About window opens: frameless, so the art runs to the top edge (its page makes the art
 *  band the drag area), with only the close button, at Tiny's default spot over the art (nothing to
 *  minimize or zoom in a fixed-size window); the about page on the service's port, at its fixed
 *  size, as a child of the main window, as Settings is: it stays above the board and moves, hides,
 *  and minimizes with it. `parent` is open-time only in Tiny, so it is here, not set afterward. */
export const aboutWindow = (port: number, at: Point | null = null): AboutWindowOptions => {
  const base: AboutWindowOptions = {
    page: aboutUrl(port),
    title: ABOUT_TITLE,
    size: ABOUT_SIZE,
    minSize: ABOUT_SIZE,
    chrome: { frame: false, windowControls: ['close'] },
    parent: 'main',
  };
  return at === null ? base : { ...base, x: at.x, y: at.y };
};

// ---- where About and Settings open ----
// Tiny's `rememberWindows` applies to every window id, so About and Settings would reopen wherever
// they were last left. Both are fixed-size children of the main window: each open passes an explicit
// x/y (which always beats a remembered one), centered on the main window and kept on its screen.

/** A rect in Tiny's top-left screen coordinates, in points. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** A width and height, in points. */
export interface Size {
  width: number;
  height: number;
}
/** A top-left, in Tiny's screen coordinates, in points. */
export interface Point {
  x: number;
  y: number;
}

/** A `'WxH'` size (as `ABOUT_SIZE` and `SETTINGS_SIZE` are) in points; null for anything else. */
export function parseSize(size: string): Size | null {
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (m === null) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** One axis: the start that centers `len` on `[mainAt, mainAt + mainLen]`, clamped to
 *  `[screenAt, screenAt + screenLen - len]`, in whole points. Longer than the screen: the screen's start. */
function placeAxis(mainAt: number, mainLen: number, screenAt: number, screenLen: number, len: number): number {
  const lo = Math.ceil(screenAt);
  const hi = Math.floor(screenAt + screenLen - len);
  if (hi < lo) return lo;
  return Math.min(Math.max(Math.round(mainAt + (mainLen - len) / 2), lo), hi);
}

/** Where a fixed-size child window opens: its top-left, centered on the main window's frame, then
 *  clamped so its whole `child` rect stays inside `screen` (the full frame, not its visible area). A
 *  child larger than the screen, on an axis, is pinned to the screen's top or left edge. Whole points. */
export function childPosition(main: Rect, screen: Rect, child: Size): Point {
  return {
    x: placeAxis(main.x, main.width, screen.x, screen.width, child.width),
    y: placeAxis(main.y, main.height, screen.y, screen.height, child.height),
  };
}

/** The fields of the main window's state (as the window state reports it) the placement reads. */
export interface MainPlacementState {
  x: number;
  y: number;
  outer: { width: number; height: number };
  screen: { width: number; height: number };
  local: { x: number; y: number };
}

/** The main window's frame (its outer footprint: `x`, `y`, `outer`) and its screen's frame (the
 *  screen `getState` reports, whose origin is `x - local.x`, `y - local.y`). Null when a number
 *  isn't finite, or a size isn't positive: nothing to place by. */
export function mainFrames(state: MainPlacementState): { main: Rect; screen: Rect } | null {
  const nums = [state.x, state.y, state.outer.width, state.outer.height, state.screen.width, state.screen.height, state.local.x, state.local.y];
  if (!nums.every(Number.isFinite)) return null;
  if (state.outer.width <= 0 || state.outer.height <= 0 || state.screen.width <= 0 || state.screen.height <= 0) return null;
  return {
    main: { x: state.x, y: state.y, width: state.outer.width, height: state.outer.height },
    screen: { x: state.x - state.local.x, y: state.y - state.local.y, width: state.screen.width, height: state.screen.height },
  };
}

/** Where a child window of `size` (`'WxH'`) opens, for the main window's state: `childPosition` over
 *  `mainFrames`. The child's footprint is its fixed size (its outer size isn't known before it opens).
 *  Null when the state or the size gives nothing to place by. */
export function placeOnMain(state: MainPlacementState, size: string): Point | null {
  const frames = mainFrames(state);
  const child = parseSize(size);
  if (frames === null || child === null) return null;
  return childPosition(frames.main, frames.screen, child);
}
