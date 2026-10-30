# A draggable Files divider in the inspector, and a resizable sidebar

- Status: done
- Job: 074-andon-resizable-panes (merged e2c3d4d via epic andon-window-polish, 2026-10-30)
- Sources: the explore request of 2026-10-30 (Matt's notes: "the horizontal divider between the list of files in a job … and the detail of the selected document … can we make that resizable … the banner with the ability to approve, reject, abandon … pushes the document detail area down to such a small region you only read a few lines at a time"; "resizability on the main project sidebar as well … as a matter of polish"); `apps/andon-ui/src/Inspector.svelte` (the edge grip), `apps/andon-ui/src/inspector.ts` (`INSPECTOR_MIN`/`MAX`/`DEFAULT`, `clampWidth`), `apps/andon-ui/src/app.css` (`.files`, `--sbw`); epic `factory/epics/andon-window-polish.md`
- Date: 2026-10-30

## Intent
When a job needs Matt, its banner and Files list leave the document only a few lines; a
draggable divider between the Files list and the document lets him give the document the room.
The project sidebar gets a drag edge too, as polish.

## Decisions
1. How does the Files divider behave? → **A horizontal grip on the line between the Files list
   and the document, in the job inspector, always (not only for a needs-human job). Dragging sets
   the Files list's height: at least about two file rows, at most what leaves the document about
   120 px. Until dragged, the list sizes as today (fits its files, up to 38%); double-clicking
   the grip resets it to that. Like the inspector's edge grip, it is focusable (↑ and ↓ move it)
   and shows a resize cursor.** Why: the needs-human case is where it matters, but a divider that
   comes and goes would feel odd; the edge grip sets the pattern.
2. How does the sidebar resize? → **A grip on its right edge, like the inspector's (drag, or
   focus and ← →, Home and End to the limits), from 180 to 320 px, default 216 px;
   double-clicking it resets to 216. View → Hide Sidebar and the narrow-window rule work as
   today, and a sidebar shown again comes back at the width last set.** Why: 180 keeps the
   traffic lights and footer whole; wider than 320 only takes room from the board.
3. Are the sizes kept? → **Yes, all three, in the page's `localStorage`: the sidebar width, the
   Files list height (only once dragged; until then it fits its files), and the inspector width
   (today reset on every reload, so this changes that). A stored value out of range is clamped,
   and one that doesn't parse is ignored (the default applies).** Why: with three drag handles,
   one that forgets would feel broken; the page already keeps the project selection there.
4. Is the main window's position and size remembered? → **Yes: `tinyjs.json` sets
   `"rememberWindows": true` explicitly (Tiny restores each window's position, size, and
   fullscreen state per screen layout), whatever Tiny's default is.** Why: normal Mac behavior,
   and the board is a window you park; part of "keep my layout". The job checks by hand that the
   main window comes back where it was and that Settings and About still open over it as children.

## Facts (2026-10-30)
- The job inspector's Files list is `max-height: 38%` with its own scroll, and the document
  scrolls below it; the needs-human callout (Approve, Rework…, Abandon…, the command) sits above
  both.
- The epic page and the brief and plan pages scroll as one column (`.ins-scroll`): no divider.
- The inspector's left-edge grip: drag, or focus and ← → (Home and End to the limits), clamped
  to 320–560 px (default 392), not kept across reloads.
- The sidebar is a fixed 216 px (`--sbw`); View → Hide Sidebar and a narrow window hide it.
- Tiny's `rememberWindows` setting (tinyjs.json schema: "Restore each window's position, size and
  maximized/fullscreen state per screen layout") isn't set in `apps/andon/tinyjs.json`; Andon's
  store already holds a `__screens` entry, so it may be on by default — not confirmed.

## Scope
- In: `apps/andon-ui`: the Files divider (job inspector only), the sidebar's edge grip, keeping
  the three sizes in `localStorage` (the pure parts: clamping, parsing, the limits, the reset, in
  `bun:test`); `apps/andon`: `"rememberWindows": true` in `tinyjs.json`.
- Out: a divider on the epic, brief, or plan pages (they scroll as one column); changing the
  inspector's width limits; changing the needs-human callout itself; the narrow-window rule;
  remembering anything else (Needs Me, the open sheet); the service and the `factory/v1` contract.

## Acceptance sketch
- In a job's inspector, dragging the line between Files and the document resizes the Files list
  within its limits; ↑ and ↓ on the focused grip move it; double-click resets it to fit its
  files (up to 38%); a needs-human job's document can be given most of the inspector.
- The sidebar's right edge drags from 180 to 320 px; ← → on the focused grip, Home and End;
  double-click resets to 216; hiding and showing the sidebar keeps the width set.
- After a reload (and a relaunch), the sidebar width, the dragged Files height, and the inspector
  width are as they were; a stored value out of range is clamped and a garbled one ignored
  (tests pin both).
- The main window reopens where it was, at its size (`manual`); Settings and About still open
  above it (`manual`).
- In a plain browser, the grips and the kept sizes work the same.
- The gate passes.

## Contract calls
None.

## Open
None.
