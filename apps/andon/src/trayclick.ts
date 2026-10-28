// The tray icon's left click: show the main window in front, decided from the window's state.
// It never hides the window (closing it does). Also Settings…'s first step: bring a hidden or
// minimized main window back, since the Settings window is its child. Runtime-neutral; backend.ts
// reads the state and carries out the action.

/** The fields of the window's state the rule reads. */
export interface WindowFlags {
  minimized: boolean;
  fullscreen: boolean;
  /** Already on every Space (the Mac app never sets this). */
  allSpaces: boolean;
}

/** `restore`: un-minimize first. `moveHere`: bring the window to the Space the user is on instead
 *  of switching to its Space. */
export interface ShowAction {
  restore: boolean;
  moveHere: boolean;
}

/** Always show. No state (`null`) is treated as a hidden, ordinary window. A fullscreen window
 *  lives on its own Space, so it is not moved; nor is a window that is already on every Space. */
export function trayClickAction(s: WindowFlags | null): ShowAction {
  if (s === null) return { restore: false, moveHere: true };
  return { restore: s.minimized, moveHere: !s.fullscreen && !s.allSpaces };
}

/** The fields of the main window's state Settings…'s bring-back step reads. */
export interface MainFlags {
  minimized: boolean;
  visible: boolean;
}

/** `restore`: un-minimize. `show`: show the window. Both false: it is already up, leave it. */
export interface BringBack {
  restore: boolean;
  show: boolean;
}

/** Settings… brings the main window back first: its child, the Settings window, hides and minimizes
 *  with it. A minimized window is restored and shown; a hidden one is shown; a visible one is left
 *  alone. No state (`null`) is treated as hidden: shown, not restored. No Space move here. */
export function bringBackAction(s: MainFlags | null): BringBack {
  if (s === null) return { restore: false, show: true };
  if (s.minimized) return { restore: true, show: true };
  return { restore: false, show: !s.visible };
}

/** Run `fn` one call at a time: a call made while the last is still running is dropped, so a quick
 *  second click never acts on state the first click is still changing. */
export function oneAtATime<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  let busy = false;
  return async (...args) => {
    if (busy) return;
    busy = true;
    try {
      await fn(...args);
    } finally {
      busy = false;
    }
  };
}
