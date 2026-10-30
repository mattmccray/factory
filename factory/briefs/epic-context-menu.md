# An epic's right-click menu: Open in T3 Code

- Status: done
- Job: 076-epic-context-menu (merged 252b826 via epic andon-window-polish, 2026-10-30)
- Sources: the explore request of 2026-10-30 (Matt's notes: "add a context menu to epics as well, that first column that shows the epic name … a right click where you can do an open in T3 code … so I can go right to the orchestrator thread for that epic"); briefs `job-context-menu` (job 040), `job-session-link`; `apps/andon/src/jobmenu.ts`, `apps/andon/src/backend.ts` (`showJobMenu`, `runJobItem`), `apps/andon-ui/src/jobmenu.ts`, `apps/andon-ui/src/projectmenu.ts` (`menuArmer`), `apps/andon-ui/src/Lane.svelte` (the epic name button); `docs/contract/v1.md` "Epics" (`session` in `epic.json`); epic `factory/epics/andon-window-polish.md`
- Date: 2026-10-30

## Intent
Right-clicking an epic's name on the board opens the T3 Code thread that is driving it, so Matt
goes straight to the epic's orchestrator, as a job token already does for a job.

## Decisions
1. What's in the menu, and how is it built? → **Mirror the job menu: Open in T3 Code (grayed out
   when the epic has no recorded thread), a separator, and Copy Epic Name (the slug). On the epic
   name button in its sub-lane only. One new backend method, `epicMenu({ project, epic })`,
   answered only for the main window: it checks the request (exactly those two fields, a listed
   project, an epic slug of the contract's form), re-reads the epic from the service's board, and
   builds the `t3code://threads/<env>/<thread>` link only from a `session` that passes the job
   menu's check (reused, not copied). Failures notify as the job menu's do. The API gate grows by
   exactly that one method, pinned by the boundary test. Resume epic is out.** Why: the job
   menu is the pattern Matt already uses; the page names the epic and the backend decides, so no
   page value becomes a link; Resume would need `startWork` to accept a running epic.

## Facts (2026-10-30)
- The board carries each on-board epic's `epic.json` as stored, with `session` (the latest on
  `epic.started` or `epic.resumed`, else `null`; `docs/contract/v1.md` "Epics").
- The job menu (job 040): `jobMenu({ project, job })`, items Open in T3 Code / separator / Copy
  Job ID, `isSession` and `threadLink` in `apps/andon/src/jobmenu.ts`; the page arms it while the
  pointer is on a job token (`menuArmer`, `JOB_MENU_ATTR`), and the project menu on a project row
  or lane gutter.
- The epic name is the `.en` button in the sub-lane's first column (`Lane.svelte`); its member
  job tokens already arm the job menu.

## Scope
- In: `apps/andon`: `epicMenu` (request check, the board read, the items, the click actions:
  open the thread, copy the slug, the failure notices), the item ids routed by `onContextMenu`,
  `tinyjs.json`'s gate widened by that one method, tests (the request check, the items and
  their enabled state, the link only from a checked `session`, the boundary test).
  `apps/andon-ui`: the epic name button arming the epic menu (over the project menu around it),
  disarming elsewhere; tests for the pure parts.
- Out: Resume epic or any other start-work action; a menu on the epic page or its members'
  rows in the inspector; any change to the job or project menus' items; the service and the
  `factory/v1` contract.

## Acceptance sketch
- Right-clicking an epic's name in its sub-lane shows Open in T3 Code, a separator, and Copy Epic
  Name; it changes no selection or route.
- With a recorded, well-formed `session`, Open in T3 Code opens that thread in T3 Code; with none
  (or a malformed one) it is grayed out; Copy Epic Name copies the slug.
- `epicMenu` from another window, with any other field, an unlisted project, a malformed slug, or
  an epic not on the board, shows no epic menu; the boundary test pins the gate with exactly one
  new method.
- Elsewhere on a sub-lane (its cells, its job tokens) the menus are as today; in a plain browser,
  nothing changes.
- The gate passes.

## Contract calls
None.

## Open
None.
