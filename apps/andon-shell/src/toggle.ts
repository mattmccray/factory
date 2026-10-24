// The tray icon's left click: show or hide the main window, decided from the window's state.
// Runtime-neutral; backend.ts reads the state and carries out the action.

/** The fields of the window's state the rule reads. */
export interface WindowFlags {
  visible: boolean;
  minimized: boolean;
  focused: boolean;
  fullscreen: boolean;
  /** Already on every Space (the shell never sets this). */
  allSpaces: boolean;
}

/** `moveHere`: bring the window to the Space the user is on instead of switching to its Space. */
export type ToggleAction = { kind: 'hide' } | { kind: 'show'; restore: boolean; moveHere: boolean };

/** Hide only a window that is visible, not minimized, and focused; otherwise show it in front,
 *  restoring it first when minimized. No state (`null`) is treated as hidden. A fullscreen window
 *  lives on its own Space, so it is not moved; nor is a window that is already on every Space. */
export function toggleAction(s: WindowFlags | null): ToggleAction {
  if (s === null) return { kind: 'show', restore: false, moveHere: true };
  if (!s.minimized && s.visible && s.focused) return { kind: 'hide' };
  return { kind: 'show', restore: s.minimized, moveHere: !s.fullscreen && !s.allSpaces };
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
