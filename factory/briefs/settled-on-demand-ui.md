# Settled jobs on demand in the Andon UI — opt in to the narrow board, fetch history when a view opens

- Status: ready
- Sources: factory/briefs/settled-on-demand.md (the service side; this brief depends on it
  being merged); `/factory explore settled-on-demand` on 2026-10-29; Matt's review of the focused
  view after the first `factory prune` (2026-10-29); apps/andon-ui/src/live.ts, api.ts, state.ts,
  board.ts, lanes.ts (`laneOf`, `activity`), find.ts, Lane.svelte, App.svelte,
  SettledSheet.svelte, Inspector.svelte, route.ts; docs/design/andon-overview/design.md (§6, §7,
  §9); docs/decisions.md decision 5
- Date: 2026-10-29

## Intent
The Andon UI opts in to the service's narrow board, so each push carries only the jobs on the
board plus a settled summary, and it fetches a project's settled jobs only when a view needs
them: the Settled sheet, a settled job in the inspector, or a focused project. Everything looks
the same as today, except that a focused project's Merged column no longer lists its settled
jobs as a long dimmed tail.

## Decisions
1. Opting in → **The UI always uses `GET /events?settled=summary` and
   `GET /projects/<pid>/board?settled=summary`, and keeps each project's `settled` summary in
   its state.** *Confirmed by Matt on 2026-10-29* (service brief, decision 1).
2. Counts and "last merge" → **The toolbar's "Settled N" is the sum of the projects' summary
   `count`s; a lane's "· N settled" and "Settled N" use its own `count`; "Idle · last merge …"
   takes the later of the summary's `lastMergedAt` and any unsettled merge on the board.**
   *Confirmed by Matt on 2026-10-29* (service brief, decision 2).
3. Settling on screen → **The UI keeps its own `isSettled` check on the jobs it holds, as
   today, so a job that just crossed never lingers between the crossing and the service's
   timer-driven push.** *Confirmed by Matt on 2026-10-29* (service brief, decision 3).
4. A focused project's Merged column → **Shows only unsettled (recent) merges; settled jobs
   leave it and are reached through the Settled sheet and the inspector.** *Confirmed by Matt on
   2026-10-29*, with these details:
   - the lane's "· N settled" link also shows when the project is focused (today `Lane.svelte`
     hides it in focus, because the settled jobs were listed inline);
   - search in a focused project matches only the jobs on its lane (`find.ts` no longer includes
     settled jobs in focus);
   - **Recent activity** is built from the project's unsettled and settled jobs together, as
     today (decision 5 fetches the settled ones on focus); settled jobs feed only Recent
     activity, never Merged tokens.
   Amends design §7 ("Merged also lists that project's settled jobs, dimmed"): the job updates
   docs/design/andon-overview/design.md §7 and drops the dimmed settled tokens from `lanes.ts`.
   Why: a long faded tail under recent merges reads as more merged work rather than history, and
   in a quiet project nearly all of the last 14 events belong to settled jobs.
5. Fetching settled jobs → **Only when a view needs them, from `GET /projects/<pid>/settled`:
   one project's list for a filtered Settled sheet (`#settled=<pid>`, a lane's link), a settled
   job in the inspector (including a cold `#job=…` deep link to one), or a focused project;
   every project's list for the global sheet (`#settled`, the toolbar). Lists are cached per
   project, and while such a view is open a project's list is refetched whenever its summary
   `count` or `lastMergedAt` changes.** *Confirmed by Matt on 2026-10-29.* Why: one request on
   opening history, at a size no longer pushed 20–30 times a job.

## Scope
- In: `apps/andon-ui` (live/api/state, the board model, lanes, find, Lane, App, the Settled
  sheet, the inspector, deep links) and its tests; docs/design/andon-overview/design.md §7 (and
  §9 if its wording assumes settled jobs are always loaded).
- Out: any service or contract change (the service brief did those); paging or searching the
  Settled sheet; any change to how a settled job looks in the sheet or the inspector.

## Acceptance sketch
- The UI connects with `?settled=summary`; a board push no longer carries settled jobs.
- The toolbar's "Settled N", each lane's "· N settled" / "Settled N", and "Idle · last merge …"
  show the same numbers and text as before for the same jobs.
- Opening the Settled sheet (global or one project), including from a cold `#settled` or
  `#settled=<pid>` link, lists the same rows as before, newest first; while it fetches it shows
  a loading state, and a failed fetch shows the reason instead of an empty list.
- Opening a settled job, including from a cold `#job=<settled id>` link, shows it in the
  inspector with its timing, as before.
- A focused project's Merged column shows only recent merges, with no dimmed tokens; its
  "· N settled" link is visible and opens the sheet filtered to it; its Recent activity lists
  the same 14 events as before; search in focus no longer matches settled jobs.
- When a job settles or a new one is abandoned while the sheet or a focused project is open, the
  view updates without a reload.
- Design §7 says settled jobs are reached through the sheet, not listed in Merged.

## Contract calls
- Design §7 amendment (decision 4): settled jobs leave a focused project's Merged column,
  approved by Matt on 2026-10-29. The job updates docs/design/andon-overview/design.md §7 to
  match. (Decision 5 of docs/decisions.md, "settled is a view" and a settled job's timing staying
  reachable in the inspector, is kept.)

## Open
None.
