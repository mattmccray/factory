# Settled jobs on demand — stop resending every settled job on each board push

- Status: draft (not yet interviewed; the decisions below are recommendations, not confirmed by
  Matt)
- Sources: `/factory explore job-archive` on 2026-10-28 (performance discussion);
  packages/andon-service/src/index.ts (`board`, `emitBoard`, SSE `board` events);
  docs/contract/v1.md ("Dashboard endpoints", "Andon service"); apps/andon-ui/src/SettledSheet.svelte,
  board.ts, lanes.ts; docs/design/andon-overview/design.md (§6 lanes, §9 Settled);
  factory/briefs/job-archive.md (decision 10); Matt's review of the focused view after the
  first `factory prune` (2026-10-29): design §7, apps/andon-ui/src/lanes.ts (focused Merged cell)
- Date: 2026-10-28 (updated 2026-10-29)

## Intent
Every `board` event the Andon service pushes carries the project's whole job list, settled jobs
included, and that list only grows (more so once the job archive feeds old jobs back in). The
board itself shows only working, needs-human, and recently merged jobs; settled jobs appear only
in the Settled sheet and the inspector. Sending settled jobs only when those views ask for them
keeps each push small however long a project's history gets. Matt wants this soon, before any
project reaches hundreds of jobs.

## Facts (checked 2026-10-28)
- A push is per project: a change in one project rebuilds and sends only that project's board,
  debounced to one `board` event per burst (50 ms).
- This repo's `job.json` files are about 4 KB each; 43 jobs make about 170 KB per push. A running
  job causes roughly 20–30 pushes.
- The UI uses settled jobs for more than the sheet: a lane's "· N settled" link and "Settled N"
  button, an idle lane's "last merge 3d 12h ago", the `#settled[=pid]` deep link, and the
  inspector opening a settled job (`#job=…`), including its timing.
- A **focused project** also shows settled jobs: design §7 says "Merged also lists that project's
  settled jobs, dimmed", built by job 025 (`apps/andon-ui/src/lanes.ts`, `laneOf`: settled tokens
  after live ones, `dimmed`). In this repo that's 31+ faded tokens under the recent merges, which
  reads as "these are merged" rather than "these are settled".
- "Settled" is time-based for merged jobs (`endedAt` older than `settleAfterHours`): a merged job
  becomes settled with no event at all, so a server-side split has to handle a job crossing the
  line between pushes.

## Decisions (recommendations, to confirm)
1. Split the payload → **`board` events and `GET …/board` carry only unsettled jobs plus, per
   project, a settled summary (count and latest `endedAt`); a new `GET /projects/<pid>/settled`
   returns the settled jobs in full, fetched when the Settled sheet or a settled job's inspector
   opens.** A contract change to the Andon service's endpoints (additive within v1 if it's a new
   endpoint and new fields, but dropping settled jobs from `board` changes what existing readers
   see; the contract reviewer decides).
2. Who decides "settled" → **The service, by the contract's rule at build time, plus a timer for
   the next merged job to cross `settleAfterHours`** so the board drops it without waiting for an
   unrelated event.
3. A focused project's Merged column → **Shows only unsettled (recent) merges; settled jobs leave
   it and are reached only through the Settled sheet** (the lane's "· N settled" link) and the
   inspector. *Direction confirmed by Matt on 2026-10-29;* details to settle in the interview.
   Amends design §7 ("Merged also lists that project's settled jobs, dimmed"): the job updates
   docs/design/andon-overview/design.md §7 and drops the dimmed settled tokens from `lanes.ts`.
   Why: once settled jobs no longer come with every `board` push (decision 1), the focused view
   can't list them without fetching them anyway, and a long faded tail under recent merges reads
   as more merged work rather than history.

## Scope
- In: (to settle in the interview)
- Out: the job archive itself (factory/briefs/job-archive.md); paging or searching the Settled
  sheet.

## Acceptance sketch
(to write in the interview)

## Contract calls
- Design §7 amendment (decision 3): settled jobs leave a focused project's Merged column;
  direction approved by Matt on 2026-10-29. The job updates docs/design/andon-overview/design.md.
- To decide in the interview: the shape of `board` events and `GET /projects/<pid>/board`, and
the new settled endpoint (docs/contract/v1.md "Andon service").

## Open
- Is the new endpoint plus a narrower `board` additive within v1, or does `board` keep settled
  jobs behind an opt-in query parameter so old readers are unaffected?
- Does the inspector fetch a single settled job (`GET …/jobs/<id>`), or the whole settled list?
- Order relative to job-archive: independent (either can go first), but best soon after.
