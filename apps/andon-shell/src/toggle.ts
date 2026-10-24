// The tray icon's left click: show or hide the main window, decided from the window's state.
// Runtime-neutral; backend.ts reads the state and carries out the action.

/** The fields of the window's state the rule reads. */
export interface WindowFlags {
  visible: boolean;
  minimized: boolean;
  focused: boolean;
}

export type ToggleAction = { kind: 'hide' } | { kind: 'show'; restore: boolean };

/** Hide only a window that is visible, not minimized, and focused; otherwise show it in front,
 *  restoring it first when minimized. No state (`null`) is treated as hidden. */
export function toggleAction(s: WindowFlags | null): ToggleAction {
  if (s === null) return { kind: 'show', restore: false };
  if (s.minimized) return { kind: 'show', restore: true };
  if (s.visible && s.focused) return { kind: 'hide' };
  return { kind: 'show', restore: false };
}
