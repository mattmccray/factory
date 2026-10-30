# Andon window and menu polish

- Status: ready
- Sources: the explore request of 2026-10-30 (Matt's notes: a full-bleed About window as a child of main, ⌘W for Settings and About, New exploration in the app and context menus, a resizable inspector Files divider and sidebar, an epic right-click menu with Open in T3 Code); briefs `andon-about`, `settings-window-chrome`, `t3-start-work`, `job-context-menu`, `project-context-menu`
- Date: 2026-10-30

## Intent
Andon's windows and menus get a polish pass: the About window shows its art to the top edge and
sticks to the main window, ⌘W closes whichever window is in front, starting an exploration is a
menu item away, the inspector's Files divider and the sidebar can be dragged, and an epic's name
opens its orchestrator thread in T3 Code. Together because each is small, and they share the
menu and window plumbing.

## Members
- `andon-window-chrome` — a frameless, full-bleed About window as a child of main, and Window → Close (⌘W) for the front window
- `andon-resizable-panes` — a draggable divider between the inspector's Files list and its document, and a resizable sidebar
- `andon-explore-menus` — New Exploration… in the app menu and in a project's right-click menu after: `andon-window-chrome`
- `epic-context-menu` — right-click an epic's name to open its orchestrator thread in T3 Code after: `andon-explore-menus`
