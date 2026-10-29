# The Andon service serves epics

- Status: done
- Job: 054-andon-epics-service (merged 70d82d2, 2026-10-29)
- Sources: docs/design/epics/design.md (decision 9; brief 4 of 5); factory/briefs/epic-cli.md
  (`epic.json`, the plan file, `factory/jobs/epics/<slug>/`, epics on `factory/archive`);
  `/factory explore` on 2026-10-29; docs/contract/v1.md ("Andon service", "Job archive",
  "`config.json`" settle rule); packages/andon-service/src (index.ts, archive.ts, settled.ts)
- Date: 2026-10-29

## Intent
The Andon service reads each project's epics (their `epic.json` snapshots, plan files, and member
briefs, locally and on the `factory/archive` branch) and serves them beside the jobs, so the Andon
UI (brief 5) can draw epic sub-lanes and the epic inspector without new subscriptions.

## Decisions
1. How do epics travel to the UI? → **With the jobs: `board` (endpoint and `/events` event, plain
   and narrow) gains `epics`, the project's epics on the board (running, waiting, landing, or
   landed and not yet settled), each `epic.json` passed through with unknown fields kept;
   `epics: []` when there are none. The narrow `settled` summary gains `epics` (a count), and
   `GET /projects/<pid>/settled` returns `{ jobs, epics }`. A new
   `GET /projects/<pid>/epics/<slug>/docs` returns `{ files }`: the plan file, then the member
   briefs in plan order. Archived epics (`epics/<slug>/` on `factory/archive`) are served as
   archived jobs are; a local `factory/jobs/epics/<slug>/` wins. One new non-recursive watch on
   `factory/epics/` re-sends the board on a plan edit (runtime state is under the already-watched
   `factory/jobs/`).** `epic-cli` was amended (2026-10-29) so `epic.json` carries `waitingOn`:
   `"you"` when `epic.waiting` was logged, `"members"` when waiting is derived, `null` otherwise,
   so the UI counts epic-level trouble without guessing from `note`. Why: one subscription and one
   update path, no new event type to order against `board`, and the service stays a thin reader.
2. When do an epic and its members settle? → **Members settle with their epic, never on their
   own.** An epic settles like a job (landed: `settleAfterHours` after it landed; abandoned: at
   once). A job with an `epic` (member, sync, or fix) is never settled while its epic isn't
   terminal, so a member merged into the epic branch days ago stays in Merged with the "in epic"
   mark; once the epic is terminal, its jobs settle when it does, by the epic's `endedAt`. An
   abandoned job in a live epic still settles at once (it leaves the lanes; the epic page shows it
   `abandoned`). The rule is defined once in `packages/contract` (added by `epic-cli`, amended
   2026-10-29), and the service switches its settled logic (`settled.ts`, the narrow board, the
   settled summary, the one-shot settle timer) to it. Why: merged members mean something only in
   their epic's context, so trickling into Settled would misrepresent a running epic; one rule
   means `prune` and Andon never disagree.

## Scope
- In: `packages/andon-service` (reading local and archived epics, `epics` on the plain and narrow
  board and `/events` `board` events, the settled summary's `epics` count, `/settled`'s `epics`,
  the epic docs endpoint, the `factory/epics/` watch, the epic-aware settle rule, the settle timer
  covering epics); `docs/contract/v1.md` ("Andon service"); tests for all of it.
- Out: the Andon UI and the Mac app (brief 5); writing anything (the service stays read-only);
  new event types on `/events`; the CLI, the skill, and `epic.json`'s shape (brief 2).

## Acceptance sketch
- `GET /projects/<pid>/board`, its narrow form, and every `/events` `board` event carry `epics`:
  each on-board epic's `epic.json` as stored (unknown fields kept), `[]` when none; a missing or
  mid-write `epic.json` keeps the last good snapshot, as for jobs.
- An epic whose local dir was pruned is served from `epics/<slug>/` on `factory/archive`; a local
  dir wins over the archive.
- The narrow `settled` summary carries `epics` (the count of settled epics), and
  `GET /projects/<pid>/settled` returns `{ jobs, epics }` with the settled epics.
- `GET /projects/<pid>/epics/<slug>/docs` returns `{ files }`: the plan, then each member brief in
  plan order (a missing brief is skipped); a bad slug, or a path that resolves outside the
  project, is a 404 and reads nothing.
- Editing `factory/epics/<slug>.md` re-sends that project's `board`; no polling is added.
- A member of a running epic is never in `settled` and never counted there, however old its merge;
  when the epic lands, its jobs settle with it, and the settle timer fires for the epic's
  crossing.
- Projects with no epics serve exactly what they do today plus `epics: []` (and `epics: 0` in the
  narrow summary).

## Contract calls
- "The Andon service serves epics: `epics` on the board and `board` events (plain and narrow), an
  `epics` count in the settled summary, `epics` from `/projects/<pid>/settled`, the new
  `GET /projects/<pid>/epics/<slug>/docs`, archived epics, and a watch on `factory/epics/`; the
  service applies the epic-aware settle rule from `packages/contract`." Approved by Matt on
  2026-10-29. Additive within `factory/v1` (new response fields and a new endpoint; jobs with no
  epic settle exactly as before). The job updates `docs/contract/v1.md` ("Andon service") to match.

## Open
None.
