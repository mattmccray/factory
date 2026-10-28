# Andon polish: legend order and no selection on right-click

- Status: done
- Job: 034-andon-polish (merged e1cd697, 2026-10-28)
- Sources: Matt's nitpicks (2026-10-28), items 1 and 3; `apps/andon-ui/src/sidebar.ts` (`LEGEND`), `apps/andon-ui/src/lanes.ts` (`COLUMNS`), brief `factory/briefs/project-context-menu.md`
- Date: 2026-10-28

## Intent
Scanning Andon left to right should read as the workflow: the status bar's legend lists the
states in the order a job moves through them, as the board's columns already do. And Andon
should feel like an app, not a web page: a right-click (which now opens native context menus)
no longer selects the text under the pointer.

## Decisions
1. How does this fit with the rest of Matt's list? → **One of four briefs, run in order: A (this
   one), C1 a Settings window, C2 a T3 Code hand-off, B the minimized-window icon.** Why: each
   is one reviewable diff; this one is small and safe, so it goes first.
2. Do the board's columns change? → **No. They are already in workflow order (Andon, Spec,
   Build, Review, Approve, Merged; claimed jobs sit in Spec). Only the status bar legend is
   reordered.** Why: checked in `lanes.ts` `COLUMNS`; Matt confirmed the split without naming a
   lane change.
3. The legend's order? → **Needs a human · Claimed · Spec · Building · In review · Review
   failed · At approver · Merged.** Why: the workflow order, left to right; Review failed is a
   review's outcome and sits in the Review column, so it follows In review.
4. Where does text stay selectable? → **Nowhere by default: selection is off across the app
   (sidebar, board and tokens, toolbar, status bar, column headers, the inspector's header and
   file list). It stays on only in the inspector's rendered document, the command boxes (which
   keep selecting the whole command on click), and text fields (search, the rework and abandon
   notes). The same in the Mac app and a plain browser.** Why: a right-click on chrome no longer
   selects a word under a native context menu, and Andon feels like a Mac app; text stays
   copyable where copying is the point; one behavior for both is simpler. Accepted cost: a job
   title can't be drag-selected off the board (the inspector's document has it).

## Scope
- In: `apps/andon-ui`: reorder `LEGEND` (and its test) to decision 3's order; CSS so text
  selection is off by default and on in the rendered document, the command boxes, and text
  fields.
- Out: any change to the board's columns, kinds, colors, or labels; any change in `apps/andon`
  (the Mac app), the service, or the contract; the minimized-window icon, Settings, and T3 Code
  (their own briefs).

## Acceptance sketch
- The status bar legend reads, left to right: Needs a human, Claimed, Spec, Building, In review,
  Review failed, At approver, Merged (a test pins the order).
- In the Mac app, right-clicking or control-clicking a sidebar project or a lane gutter opens
  the project menu without selecting any text; right-clicking elsewhere on the board, the
  toolbar, the status bar, or the inspector's header selects nothing (`manual`).
- Dragging across the board or the sidebar selects nothing; dragging in the inspector's
  rendered document selects text and ⌘C copies it (`manual`).
- Clicking a command box still selects the whole command; typing and selecting in the search,
  rework, and abandon fields work as before.
- A plain browser behaves the same.
- The gate passes.

## Contract calls
None.

## Open
None.
