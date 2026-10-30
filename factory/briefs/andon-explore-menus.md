# New Exploration and Run Next from Andon's menus

- Status: ready
- Sources: the explore request of 2026-10-30 (Matt's notes: "add to the context menu and the app menu some of these new functions we've added, the ability to create a new exploration prompt specifically"); brief `t3-start-work` (job 068), `project-context-menu`; `apps/andon/src/appmenu.ts`, `apps/andon/src/projectmenu.ts`, `apps/andon/src/startwork.ts`, `apps/andon-ui/src/NewExplorationSheet.svelte`, `apps/andon-ui/src/BacklogSheet.svelte`; member `andon-window-chrome` (the File menu); epic `factory/epics/andon-window-polish.md`
- Date: 2026-10-30

## Intent
Starting an exploration is a menu item away, not a trip into the Backlog sheet: File → New
Exploration… (⌘N) and a project's right-click menu open the idea sheet, and the right-click menu
can also run a project's next backlog line. Everything goes to T3 Code exactly as the Backlog
sheet's buttons do.

## Decisions
1. Which actions go where? → **A project's right-click menu gains a first group, New
   Exploration… and Run Next, then a separator, then today's items. New Exploration… shows the
   board and opens the New exploration sheet for that project; Run Next starts
   `/factory next` through `startWork`, exactly as the Backlog sheet's Run next (Settings' mode,
   the same toasts and fallbacks). The File menu (added by `andon-window-chrome`) gains New
   Exploration… (⌘N) above Close Window. Run Next stays out of the app menu; Run, Start epic,
   and Continue exploring stay on the Backlog sheet only.** Why: Matt asked for New exploration
   specifically; Run Next fits where a project is in hand, and without one it is too easy to
   start a whole job in the wrong project.
2. Which project does File → New Exploration… use? → **With one project selected in the sidebar,
   that one. With All Projects, the sheet shows a project picker above the idea field, starting
   on the project last explored in (kept in `localStorage`), else the first project by name;
   only projects with a root are listed. With one registered project, no picker. The picker
   appears only for this path; the right-click menu and the Backlog sheet still open the sheet
   for a fixed project.** Why: ⌘N should always work; graying it out under All Projects would
   feel broken.
3. How do menu clicks reach the page? → **One new page event, `event.startwork`, carrying
   `{ action: 'new-exploration' | 'next', project: <id> | null }`. File → New Exploration… shows
   the main window (bringing it back when hidden or minimized) and pushes `new-exploration` with
   `project: null`; the right-click New Exploration… does the same with that project's id; the
   right-click Run Next pushes `next` with the project's id, and the page calls `startWork`
   exactly as the Backlog sheet's Run next does. The page treats the payload as a request only: it
   acts only on a project it lists, and `startWork` checks everything in the backend as today.
   The API gate grows by exactly that one event; no backend method is added or changed.** Why:
   the pattern View → Show Backlog… set; the sheet, the toasts, and the hand-off stay in one place.

## Facts (2026-10-30)
- The Backlog sheet offers Run, Start epic, Continue exploring, Run next, and New exploration…;
  all go through the backend's `startWork` (job 068), which checks the project and builds the
  command.
- The New exploration sheet is opened for one project (`exploreProject` in `App.svelte`).
- The project menu today: Copy Project Path, Reveal in Finder, a separator, Open in ▸ (VS Code,
  T3 Code, Ghostty) (`projectMenuItems`).
- ⌘N is free in the menu bar (⇧⌘N is Needs Me); a plain `n` on the page toggles Needs Me.

## Scope
- In: `apps/andon`: File → New Exploration… (⌘N) and its action; the project menu's New
  Exploration… and Run Next items and their actions; `event.startwork` and its payload,
  `tinyjs.json`'s gate widened by that one event; tests (the menus' items and order, each
  click's action and payload, the boundary test). `apps/andon-ui`: handling `event.startwork`
  (only for a listed project, or null for the File menu), the New exploration sheet's project
  picker for the File menu path under All Projects, the remembered last-explored project; tests
  for the pure parts (which project is used, the picker's start, the payload check).
- Out: Run, Start epic, or Continue exploring in any menu; Run Next in the app menu; any change
  to `startWork`, `handOff`, the commands built, or the T3 Code modes; Close Window (member
  `andon-window-chrome`); a plain browser's menus; the service and the `factory/v1` contract.

## Acceptance sketch
- File → New Exploration… (⌘N), above Close Window: with a project selected, opens the New
  exploration sheet for it; under All Projects, opens it with a picker starting on the last
  project explored in (else the first by name); with one project, no picker. A hidden or
  minimized main window comes back first.
- A project's right-click menu starts with New Exploration… and Run Next, then a separator, then
  Copy Project Path, Reveal in Finder, and Open in ▸. New Exploration… opens the sheet for that
  project; Run Next starts `/factory next` there exactly as the Backlog sheet's Run next (mode,
  toasts, and fallbacks).
- An `event.startwork` naming a project the page doesn't list, or with any other action or
  field, does nothing; the boundary test pins the gate with exactly one new event.
- In a plain browser, nothing changes (the Backlog sheet still copies only).
- The gate passes.

## Contract calls
None.

## Open
None.
