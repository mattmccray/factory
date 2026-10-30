// The window's resizable panes (brief andon-resizable-panes): the sidebar's width, the job
// inspector's Files list height, and the inspector's width, each with its limits, its keyboard
// steps, its reset, and its value kept in localStorage. Pure: the components measure and render.
import { INSPECTOR_DEFAULT, clampWidth } from './inspector';
import type { KeyValueStore } from './projects';

/** A grip's keyboard step, the same as the inspector's edge grip: 16 px, 64 with Shift. */
export const PANE_STEP = 16;
export const PANE_STEP_BIG = 64;
export const paneStep = (shift: boolean): number => (shift ? PANE_STEP_BIG : PANE_STEP);

// ---- the sidebar's width ----

export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 320;
export const SIDEBAR_DEFAULT = 216;

/** A requested sidebar width, whole pixels within 180–320; anything not a number is the default. */
export const clampSidebar = (w: number): number => (Number.isFinite(w) ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(w))) : SIDEBAR_DEFAULT);

/** The width a key on the sidebar's grip asks for (← narrower, → wider, Home and End the limits), or null for any other key. */
export function sidebarKey(width: number, key: string, shift: boolean): number | null {
  switch (key) {
    case 'ArrowLeft':
      return clampSidebar(width - paneStep(shift));
    case 'ArrowRight':
      return clampSidebar(width + paneStep(shift));
    case 'Home':
      return SIDEBAR_MIN;
    case 'End':
      return SIDEBAR_MAX;
    default:
      return null;
  }
}

// ---- the Files list's height ----

/** About two file rows: the list's padding, its group heading, and two 24 px rows. */
export const FILES_MIN = 84;
/** What a dragged Files list always leaves the document below it. */
export const DOC_ROOM = 120;
/** Not dragged: the list fits its files, up to 38% of the inspector (the stylesheet's rule). */
export const FILES_FIT = null;

/**
 * A requested Files height, given `room`, the height the Files list and the document share in
 * the inspector body: whole pixels from `FILES_MIN` to `room - DOC_ROOM`, and the minimum wins
 * when the room is too small for both. Anything not a number is the minimum.
 */
export function clampFiles(h: number, room: number): number {
  const max = Number.isFinite(room) ? Math.round(room) - DOC_ROOM : FILES_MIN;
  const want = Number.isFinite(h) ? Math.round(h) : FILES_MIN;
  return Math.max(FILES_MIN, Math.min(max, want));
}

/** The height a key on the Files grip asks for (↑ shorter, ↓ taller), or null for any other key. */
export function filesKey(height: number, key: string, shift: boolean, room: number): number | null {
  switch (key) {
    case 'ArrowUp':
      return clampFiles(height - paneStep(shift), room);
    case 'ArrowDown':
      return clampFiles(height + paneStep(shift), room);
    default:
      return null;
  }
}

/** The height to render a kept Files height at: clamped to the room it has now (the kept value stays as is). */
export const filesShown = (kept: number | null, room: number): number | null => (kept === null ? null : room > 0 ? clampFiles(kept, room) : kept);

// ---- keeping the sizes ----

export const SIDEBAR_KEY = 'andon.sidebarWidth';
export const FILES_KEY = 'andon.filesHeight';
export const INSPECTOR_KEY = 'andon.inspectorWidth';

/** A stored size: a plain decimal number, or null when it is missing, empty, or doesn't parse. */
export function parseStored(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function read(store: KeyValueStore | null, key: string): number | null {
  try {
    return parseStored(store?.getItem(key));
  } catch {
    return null; // storage blocked
  }
}

export function loadSidebarWidth(store: KeyValueStore | null): number {
  const n = read(store, SIDEBAR_KEY);
  return n === null ? SIDEBAR_DEFAULT : clampSidebar(n);
}

export function loadInspectorWidth(store: KeyValueStore | null): number {
  const n = read(store, INSPECTOR_KEY);
  return n === null ? INSPECTOR_DEFAULT : clampWidth(n);
}

/** A kept Files height (at least `FILES_MIN`; its maximum is applied against the room when shown), or `FILES_FIT`. */
export function loadFilesHeight(store: KeyValueStore | null): number | null {
  const n = read(store, FILES_KEY);
  return n === null ? FILES_FIT : Math.max(FILES_MIN, Math.round(n));
}

/** Keeps a size under its key; `null` (the Files list reset to fit) is kept as empty, which loads as the default. */
export function savePane(store: KeyValueStore | null, key: string, value: number | null): void {
  try {
    store?.setItem(key, value === null ? '' : String(value));
  } catch {
    // storage blocked or full: the size just won't persist
  }
}
