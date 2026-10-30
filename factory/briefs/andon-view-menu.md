# Andon's View menu and a Merged column switch

- Status: done
- Job: 063-andon-view-menu (merged c9c7bf6, 2026-10-30)
- Sources: the explore request of 2026-10-29 (pre-1.0 notes: "Add settings for merged column visibility", "New app menu items: View …"); briefs `andon-app-menu`, `andon-settings`; `apps/andon/src/appmenu.ts`, `apps/andon/src/settings.ts`, `apps/andon-ui/src/App.svelte`
- Date: 2026-10-30

## Intent
Andon's View menu becomes the place for the board's view toggles: Needs Me, the Settled sheet,
the sidebar, the inspector, the status bar, and the Merged column, which Matt can now switch off
in Settings or the menu.

## Decisions
1. What does the Merged column setting do? → **An on/off switch: "Show Merged column" in
   Settings, on by default. Off, the column is gone and the other five columns share its width;
   merged jobs show only in the Settled sheet and a focused project's recent activity. Stored by
   the Mac app like `statusBarHidden` and kept in step with a View menu toggle the same way; a
   plain browser always shows it.** Why: what Matt meant; Settled already holds every merged job,
   and `settleAfterHours` stays the one source for how long a job stays.
2. The View menu? → **In order: "Show Only Needs Me" (⇧⌘N; "Show All Jobs" while on), "Show
   Settled…" (⇧⌘S), a separator, "Hide Sidebar" (⌃⌘S; "Show Sidebar"), "Hide Inspector" (⌥⌘I;
   "Show Inspector"), a separator, then the current "Hide Status Bar" (⌘/) and "Hide Merged
   Column" (no shortcut; "Show Merged Column"). Labels flip, Finder-style, as the status bar's
   does (a checkmark instead only if Tiny's menus turn out to support one). The page's own `n`
   keeps working, and the shortcut sheet lists the menu shortcuts too. The labels follow the
   page's real state, including changes made in the page (`n`, closing the inspector, the
   narrow-window rule hiding the sidebar): the main window's page reports its view state to the
   Mac app through exactly one new backend method, answered only for the main window, taking
   only those booleans; the API gate grows by that one method, pinned by the boundary test.**
   Why: Matt's layout; ⌃⌘S and ⌥⌘I are the Mac's sidebar and inspector conventions; a menu
   label that lies about the page is worse than none.

## Facts (2026-10-30)
- The UI already toggles the sidebar (`toggleSidebar`, `apps/andon-ui/src/inspector.ts`), opens
  and closes the inspector, toggles Needs Me (`n`), and opens the Settled sheet.
- The View menu today holds only Show/Hide Status Bar (⌘/), a label that flips, kept in step
  with Settings by the Mac app pushing an event to the page.
- The Mac app stores `statusBarHidden` and `t3Handoff` (`apps/andon/src/settings.ts`).

## Scope
- In: `apps/andon`: the View menu items and their ids in `appmenu.ts` (pure, `bun:test`-covered),
  the `mergedHidden` setting (stored, validated in `settings.ts`, pushed to the page), the menu →
  page events for each action, the one view-state method and its check, the gate widened by it.
- In: `apps/andon-ui`: Settings' "Show Merged column" checkbox; the board dropping the Merged
  column (the others share its width) when hidden; acting on each menu event (toggle Needs Me,
  open the Settled sheet, toggle the sidebar and inspector); reporting view state to the Mac
  app; the shortcut sheet listing the menu shortcuts.
- Out: any change to how long merged jobs stay (`settleAfterHours` is unchanged); the menu or
  the Merged switch in a plain browser (it always shows the column); the service and the
  contract; other menus (About is brief `andon-about`).

## Acceptance sketch
- The View menu shows the items in the agreed order, with their shortcuts and separators.
- Each item does its action in the main window, and its label flips to match; changing the same
  state in the page (`n`, closing the inspector, a narrow window hiding the sidebar) flips the
  label too.
- "Show Merged column" off (in Settings or the menu) removes the Merged column at once in the
  main window and flips the other control; the choice survives a relaunch; merged jobs still show
  in the Settled sheet.
- In a plain browser the Merged column always shows and nothing new appears.
- The view-state method answers only the main window and accepts only its booleans; the boundary
  test pins the gate with exactly one new method.

## Contract calls
None.

## Open
None.
