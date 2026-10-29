# The backlog holds only open work, and every backlog edit is committed at once

- Status: done
- Job: 044-backlog-open-only (merged a3de0b0, 2026-10-28)
- Sources: `/factory explore job-archive` on 2026-10-28; packages/templates/assets/skill/SKILL.md
  (claim, `/factory next`, Merge bookkeeping, `/factory abandon`, `queue`);
  packages/templates/assets/skill/explore.md (Finish); `git log -- factory/backlog.md` (e.g.
  `275706e` committed job 038's tick inside another brief's commit)
- Date: 2026-10-28

## Intent
`factory/backlog.md` keeps every finished line forever (24.5 KB: 44 ticked lines, none open),
and the orchestrator re-reads all of it on every `next`, `queue`, and `explore`. Worse, a claim
ticks its line without committing it, so the working tree stays dirty while a job runs, and
whichever step commits the backlog next (another job's merge, a `queue`, an `explore`) sweeps
other jobs' ticks into its own commit. The backlog should hold only open work, and every edit to
it should be committed right away by the step that makes it, so parallel jobs never mix.

## Decisions
1. Finished lines → **Removed, not kept ticked.** Merge bookkeeping removes the job's line (in
   the same commit that marks its brief done), and `/factory abandon` removes it too. Why: each
   line's content is already kept elsewhere (the job's `feature.md` verbatim, the brief's
   `- Job:` line, the archive, git history); leaving an abandoned line would let a later
   `/factory next` quietly pick up abandoned work.
2. While a job runs → **The line stays, ticked `- [x] … → <id>`,** so a running job is visible
   and two sessions can't grab the same line.
3. Committing → **Every backlog edit is committed at once, by pathspec, under `factory/.lock`,
   by the step that makes it:** claim (tick, `chore(factory): claim job <id>`), Merge bookkeeping
   (remove, plus the brief), abandon (remove, plus the brief: `chore(factory): abandon job
   <id>`), `queue`, and `explore`'s Finish (both now take the lock for their commit). Why: a
   pathspec commit takes the whole file, so nothing may ever be left uncommitted between steps.
   The claim commit lands on the target before the job's branch is created, which is harmless.
4. Someone else's edits → **If `backlog.md` already has uncommitted changes when a step starts,
   the step stops with one line** ("commit or discard your backlog edits first") instead of
   sweeping them in. Before a claim, nothing is claimed. At merge, the merge stands and only the
   bookkeeping waits.
5. `/factory next <words>` matching finished work → **Says it already ran by checking done
   briefs' `- Job:` lines** (ticked lines are gone once merged).
6. Abandoned briefs → **`/factory abandon` adds `- Abandoned: <id> (<YYYY-MM-DD>): <reason>`
   under the brief's `Status:` line** (one per attempt) in the abandon commit; the status stays
   `ready` (the format keeps `draft | ready | done`). Claiming a brief with an `Abandoned:` line
   asks once: *"Brief `<slug>` was abandoned as job `<id>`: '<reason>'. Start it again, or
   revise it first with `/factory explore <slug>`?"* `explore` resuming such a brief shows its
   abandoned attempts in its summary. Why: without the note, an abandoned brief looks like one
   that never ran, and the next attempt repeats what went wrong.
7. Existing ticked lines → **Cleared once by hand in the promotion step** after the merge, since
   jobs never touch `factory/`.

## Scope
- In: `packages/templates/assets/skill/SKILL.md` (claim, `next`, Merge bookkeeping, abandon,
  `queue`) and `packages/templates/assets/skill/explore.md` (Finish, resuming, the brief format's
  `- Abandoned:` line); render tests pinning them.
- Out: any CLI or contract change; `factory prune`; moving or deleting briefs; editing
  `factory/backlog.md` or any brief in this repo (the promotion step's hand edit).

## Acceptance sketch
- The rendered skill: claim ticks and commits the line under the lock; Merge bookkeeping removes
  it and commits with the brief; abandon removes it, adds the brief's `- Abandoned:` line, and
  commits both; `queue` and `explore` take the lock for their commit; every commit is by
  pathspec.
- The rendered skill stops a backlog step on uncommitted `backlog.md` changes with the one-line
  message, and says what happens to the merge.
- Claiming a brief with an `Abandoned:` line asks first; `explore` shows abandoned attempts;
  `next` reports finished work from done briefs.
- Render tests pin each of these. No CLI or contract change. The gate passes.

## Contract calls
None.

## Open
None.
