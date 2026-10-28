# Open a job's orchestrator thread from Andon

- Status: ready
- Sources: brief `factory/briefs/job-session-link.md` (runs first: records `session` on jobs); brief `factory/briefs/project-context-menu.md` (job 033: the native menu, the page-names-backend-decides rule, `t3` lookup; it left job cells without a menu); brief `factory/briefs/t3-handoff.md` (job 036: one main-window-only method, the backend builds what runs); `apps/andon/src/projectmenu.ts`, `apps/andon-ui/src/projectmenu.ts`; T3 Code's `t3code://threads/<environmentId>/<threadId>` link (checked 2026-10-28)
- Date: 2026-10-28

## Intent
In Andon, the Mac app, right-clicking a job offers "Open in T3 Code", which brings T3 Code
forward with the thread orchestrating that job selected. Getting from the board to the
conversation driving a job takes one click.

## Decisions
1. Where do the thread ids come from? → **The Mac app's backend (`apps/andon/src/backend.ts`,
   the Tiny JS process), asking the Andon service over HTTP, never reading files. The page
   sends only a project id and a job id through one new named backend method. The backend checks
   the project is in its `/projects` list and the job id has the factory form (three digits, a
   slug), fetches `GET /projects/<pid>/board` from the service that listed the project, finds the
   job there, checks its `session` by the contract's rule, and builds
   `t3code://threads/<environment>/<thread>` itself. No `session`, or one failing the checks,
   grays the item out. The service is unchanged (it already passes `job.json` through).**
   Why: the project menu's rule (the page names things, the backend decides), so Andon never
   opens a T3 Code link built from page-supplied values; and asking the service rather than
   reading `<root>/factory/jobs/…` keeps working when Andon follows services on other machines
   (deferred, decision 10), where a project's root isn't a local path. The recorded
   `environment` names the T3 Code environment of the machine that ran the job, so the link
   points at the right one.

2. What's in the menu, and where? → **Open in T3 Code, a separator, Copy Job ID; on job
   tokens on the board (All Projects and a focused project). A right-click or control-click
   doesn't change the selection, as for the project menu. No menu on "stopped here" ghost
   tokens, the inspector header, or the Settled sheet for now; a plain browser shows its own
   menu. Open in T3 Code is grayed out when `t3` isn't found (the project menu's lookup) or the
   job has no usable `session`; a failure to open shows a native notification ("Couldn't open
   <id> in T3 Code: …") and is logged, as the project menu does.** Why: the one action Matt
   asked for plus a free, harmless one; every other action (reveal the job folder, open the
   worktree) is more for the security reviewer and only works for local jobs, so it waits.

## Scope
- In: `apps/andon`: a pure, `bun:test`-covered job menu module beside `projectmenu.ts` (item
  ids, the request check, the job-id form, the `session` check, the link built from it, the
  failure text); `backend.ts` handles one new named method (the page's project id and job id),
  fetches the project's board from the Andon service, sets the native context menu, and on a
  click opens the link with Tiny's `shell.open` or copies the job id; `tinyjs.json`'s API gate
  grows by exactly that one method (pinned by a test).
- In: `apps/andon-ui`: job tokens ask for the job menu on right-click or control-click in the
  Mac app, through the same arming the project menu uses; selection unchanged; a plain browser
  unchanged.
- Out: any Andon service or `factory/v1` contract change (brief `job-session-link` adds
  `session`); the page ever sending a thread id, a link, or a path; reading job files from
  disk; menus on ghost tokens, the inspector header, or the Settled sheet; other job actions;
  verifying links to threads on other machines' T3 Code environments (multi-machine Andon is
  deferred).

## Acceptance sketch
- In the Mac app, right-clicking a job token whose job was claimed from a T3 Code thread shows
  Open in T3 Code and Copy Job ID; Open in T3 Code brings T3 Code forward with that thread
  selected (`manual`), and Copy Job ID puts the id on the clipboard.
- After a rework from another T3 Code thread, Open in T3 Code goes to that newer thread
  (`manual`).
- A job with no `session`, a malformed one, or no `t3` found shows Open in T3 Code grayed out;
  Copy Job ID still works.
- The selection doesn't change; ghost tokens get no menu; a plain browser shows its own menu.
- The page can't steer the link: an unknown project, a malformed job id, a job missing from the
  service's board, or a `session` failing the contract's check opens nothing (tests pin it,
  including that the link is built only from the board's `session`).
- A failure to open shows a "Couldn't open <id> in T3 Code: …" notification.
- The API gate allows exactly one more method than after job 037 (pinned).
- The gate passes.

## Contract calls
None. (It reads the `session` field brief `job-session-link` adds; the job menu on job cells
supersedes brief `project-context-menu`'s "not on the lane's job cells", which that brief scoped
to its own menu.)

## Open
None.
