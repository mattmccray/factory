# Tray click toggles the window

- Status: done
- Job: 016-tray-click-toggle (merged 4e127ce, 2026-10-23)
- Sources: apps/andon-shell/src/backend.ts, apps/andon-shell/src/badge.ts, ~/.tinyjs/README.md (tray `primaryAction`), ~/.tinyjs/template/types/tiny.d.ts
- Date: 2026-10-23

## Intent
In the Andon shell, a left click on the tray icon shows the main window and brings it to the
front on the workspace you're on (closing the window hides it). The tray menu moves to a right-click (and ctrl-click), so reaching
the board takes one click instead of opening a menu first.

## Decisions
1. What does a left click do? → **Always show the main window: restore it if minimized, bring it
   to the front on the current workspace. It never hides it; closing the window hides it.**
   Why: in the built app `getState()` doesn't reliably report `focused: true` for a window in
   front when the tray is clicked, so a hide-when-focused toggle was flaky (job 016 rework 2,
   2026-10-23). This replaces the earlier rule (hide when visible, not minimized, and focused).
2. What's in the right-click menu? → **Unchanged: "Show Andon", a separator, "Quit".** Why:
   "Show Andon" still serves anyone who opens the menu out of habit, and VoiceOver and keyboard
   users; a label that flips between Show and Hide costs state tracking for little gain. A
   Settings item will come later, once the app has settings to show.

## Scope
- In: `primaryAction: true` on every tray spec the shell sets (including the starting and
  failure notices), and a left-click handler (`onTray(null, app)`) in the Tiny adapter that
  shows the main window (restoring it if minimized) and brings it forward on the current
  workspace. The show rule lives in runtime-neutral code with `bun:test` coverage;
  `backend.ts` stays a thin adapter.
- Out: hiding the window from a left click; a Settings menu item (later, when there are settings); a Show/Hide label that tracks the
  window's state; any change to the menu's items, the badge count, notifications, or the agent.

## Acceptance sketch
- Left-clicking the tray icon always shows the window in front on the current workspace:
  hidden, behind other windows, minimized (restored), on another workspace, or already in front
  (it stays). A left click never hides it.
- Right-click (or ctrl-click) opens the tray menu, which still reads "Show Andon", a
  separator, "Quit", and both items still work.
- The same behavior holds before the agent answers and when it fails to start.
- Unit tests pin the show rule for each case above, and that every tray spec sets
  `primaryAction: true`.

## Contract calls
None.

## Open
None.
