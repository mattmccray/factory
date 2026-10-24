# Tray click toggles the window

- Status: ready
- Sources: apps/andon-shell/src/backend.ts, apps/andon-shell/src/badge.ts, ~/.tinyjs/README.md (tray `primaryAction`), ~/.tinyjs/template/types/tiny.d.ts
- Date: 2026-10-23

## Intent
In the Andon shell, a left click on the tray icon shows or hides the main window, the way a
menu-bar toggle app works. The tray menu moves to a right-click (and ctrl-click), so reaching
the board takes one click instead of opening a menu first.

## Decisions
1. What does a left click do when the window is open but buried or minimized? → **If the main
   window is visible, not minimized, and focused, hide it; otherwise show it (restore if
   minimized) and bring it to the front.** Why: a buried window comes forward on the first
   click instead of disappearing, and a window in use hides on one click (clicking the menu bar
   doesn't take focus on macOS).
2. What's in the right-click menu? → **Unchanged: "Show Andon", a separator, "Quit".** Why:
   "Show Andon" still serves anyone who opens the menu out of habit, and VoiceOver and keyboard
   users; a label that flips between Show and Hide costs state tracking for little gain. A
   Settings item will come later, once the app has settings to show.

## Scope
- In: `primaryAction: true` on every tray spec the shell sets (including the starting and
  failure notices), and a left-click handler (`onTray(null, app)`) in the Tiny adapter that
  reads `app.window('main').getState()` and hides the window only (`hide({ app: false })`) or
  shows it and brings it forward. The show-or-hide rule lives in runtime-neutral code with
  `bun:test` coverage; `backend.ts` stays a thin adapter.
- Out: a Settings menu item (later, when there are settings); a Show/Hide label that tracks the
  window's state; any change to the menu's items, the badge count, notifications, or the agent.

## Acceptance sketch
- Left-clicking the tray icon with the window hidden shows it in front.
- Left-clicking with the window visible, focused, and not minimized hides it.
- Left-clicking with the window visible but behind other windows, or minimized, brings it to
  the front.
- Right-click (or ctrl-click) opens the tray menu, which still reads "Show Andon", a
  separator, "Quit", and both items still work.
- The same behavior holds before the agent answers and when it fails to start.
- Unit tests pin the show-or-hide rule for each case above, and that every tray spec sets
  `primaryAction: true`.

## Contract calls
None.

## Open
None.
