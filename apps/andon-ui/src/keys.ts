// The keyboard map (design §10), as a pure reducer: a key event and the open layers in, an action
// out. App.svelte's one window handler feeds it and carries the action out. ↑ and ↓ between files
// stay with the inspector (Inspector.svelte), which already handles them.
//   /      focus search            g a   All Projects
//   n      toggle Needs Me         ?     the shortcut sheet
//   Esc    close the topmost layer: a sheet, then the inspector, then search (clear, then leave)
// Single-key shortcuts are ignored while focus is in a text field, while a modifier (Ctrl, Alt,
// or Cmd) is held, or while a sheet is open over the page. Only Esc works from inside a field.
// The Mac app's View menu shortcuts (063: ⇧⌘N, ⇧⌘S, ⌃⌘S, ⌥⌘I, ⌘/; 067: ⇧⌘B) are the menu's own, not this
// reducer's; the shortcut sheet lists them in the Mac app only.

export type KeyAction = 'focus-search' | 'toggle-needs' | 'open-keys' | 'all-projects' | 'close-sheet' | 'close-inspector' | 'clear-search' | 'leave-search';

export interface KeyInput {
  key: string; // KeyboardEvent.key
  mod: boolean; // Ctrl, Alt, or Cmd held (Shift is part of the key: `?`)
  inField: boolean; // focus is in an input, textarea, select, or editable element
}

export interface Layers {
  sheet: boolean; // any sheet: Settled, Backlog, What's New, Rework, Abandon, or shortcuts
  inspector: boolean;
  searchText: boolean; // the search field has text
  searchFocused: boolean;
}

/** The reducer's memory: whether the last key was the `g` of `g a`. */
export interface KeyState {
  pendingG: boolean;
}

export const initialKeys = (): KeyState => ({ pendingG: false });

/** Keys that are only modifiers: pressing them doesn't break a `g a` sequence. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'Fn']);

/** Esc's action by layer order, or null when nothing is open. */
export function escape(l: Layers): KeyAction | null {
  if (l.sheet) return 'close-sheet';
  if (l.inspector) return 'close-inspector';
  if (l.searchText) return 'clear-search';
  if (l.searchFocused) return 'leave-search';
  return null;
}

/** The sheets that can be open at once, by name. */
export interface OpenSheets {
  whatsNew: boolean;
  keys: boolean;
  command: boolean; // Rework…, Abandon…, or an epic's Abandon…
  settled: boolean;
  backlog: boolean; // the Backlog sheet: in the Settled sheet's place (the two never open together)
}

/**
 * Which sheet Esc's `close-sheet` closes: the topmost one. What's New is always on top when open:
 * Help → What's New (the Mac app) can open it over any sheet, and nothing opens over it (it is
 * modal, and single keys are off while a sheet is open). Then the shortcuts or a command sheet,
 * which open over the Settled sheet's place, then the Settled sheet, then the Backlog sheet (in the
 * same place: opening one closes the other).
 */
export function topSheet(o: OpenSheets): keyof OpenSheets | null {
  if (o.whatsNew) return 'whatsNew';
  if (o.keys) return 'keys';
  if (o.command) return 'command';
  if (o.settled) return 'settled';
  if (o.backlog) return 'backlog';
  return null;
}

/** One key event: the next state and the action to take (null: let the event be). */
export function reduceKey(s: KeyState, e: KeyInput, l: Layers): { state: KeyState; action: KeyAction | null } {
  if (e.key === 'Escape') return { state: initialKeys(), action: escape(l) };
  if (MODIFIERS.has(e.key)) return { state: s, action: null };
  if (e.mod || e.inField || l.sheet) return { state: initialKeys(), action: null };
  if (s.pendingG) return { state: initialKeys(), action: e.key === 'a' ? 'all-projects' : null };
  switch (e.key) {
    case 'g':
      return { state: { pendingG: true }, action: null };
    case '/':
      return { state: s, action: 'focus-search' };
    case 'n':
      return { state: s, action: 'toggle-needs' };
    case '?':
      return { state: s, action: 'open-keys' };
    default:
      return { state: s, action: null };
  }
}

/** One row of the shortcut sheet. `menu`: a Mac app View menu shortcut, listed only in the Mac app. */
export interface Shortcut {
  keys: string[];
  join?: 'then' | 'or';
  text: string;
  menu?: true;
}

/** The shortcut sheet's rows: the page's own, in the order §10 lists them, then the View menu's, in menu order. */
export const SHORTCUTS: readonly Shortcut[] = [
  { keys: ['/'], text: 'Search jobs' },
  { keys: ['esc'], text: 'Close the sheet, then the inspector, then clear or leave search' },
  { keys: ['↑', '↓'], join: 'or', text: 'Previous or next file in the inspector' },
  { keys: ['g', 'a'], join: 'then', text: 'All Projects' },
  { keys: ['n'], text: 'Show only what needs you' },
  { keys: ['?'], text: 'This list of shortcuts' },
  { keys: ['⇧⌘N'], text: 'Show only Needs Me, or all jobs (View menu)', menu: true },
  { keys: ['⇧⌘S'], text: 'Show the settled jobs (View menu)', menu: true },
  { keys: ['⇧⌘B'], text: 'Show the backlog (View menu)', menu: true },
  { keys: ['⌃⌘S'], text: 'Hide or show the sidebar (View menu)', menu: true },
  { keys: ['⌥⌘I'], text: 'Hide or show the inspector (View menu)', menu: true },
  { keys: ['⌘/'], text: 'Hide or show the status bar (View menu)', menu: true },
];

/** The rows the sheet shows: every row in the Mac app, and only the page's own in a browser (it has no View menu). */
export const shortcutsFor = (mac: boolean): readonly Shortcut[] => (mac ? SHORTCUTS : SHORTCUTS.filter((s) => s.menu !== true));
