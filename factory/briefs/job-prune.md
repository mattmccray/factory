# Prune archived job dirs

- Status: done
- Job: 048-job-prune (merged d9b2f0a, 2026-10-29)
- Sources: `/factory explore job-archive` on 2026-10-28 (split from it);
  factory/briefs/job-archive.md; factory/briefs/andon-reads-archive.md; docs/contract/v1.md
  (settled rule, CLI)
- Date: 2026-10-28

## Intent
Archiving only copies, so local `factory/jobs/` keeps growing. `factory prune` clears the local
dir of a job whose record is safely on the `factory/archive` branch, so the working copy stays small
while history stays in the repo. Needs `job-archive`, `archive-branch-rename`, and `andon-reads-archive` merged first, so
a pruned job never drops out of Andon and never frees its id.

## Decisions
1. Its own command → **`factory prune`, manual, never called by the skill;** not a flag on the
   copy-only `archive`. Why: it's the one destructive step, so it gets its own command and its
   own check.
2. What it removes → **The local dir of a job only when all three hold:** it is archived; it is
   *settled* by the contract's existing rule (merged: `endedAt` older than `settleAfterHours`;
   abandoned: at once); and the archived tree matches the local files byte for byte (the same
   file set `archive` copies). Anything else is kept and reported. Why: the match check
   guarantees the archived copy is identical, so a second "old enough to prune" setting adds
   nothing.
3. Archiving off → **`factory prune` is refused** when `archive` isn't enabled. Why: there's
   nothing archived to trust.

## Scope
- In: `factory prune` in `packages/cli` (reusing `job-archive`'s helpers); tests;
  docs/contract/v1.md (CLI).
- Out: the backlog (`backlog-open-only`); briefs; pruning anything that isn't archived and
  settled; pushing or fetching.

## Acceptance sketch
- `factory prune` removes only archived, settled, matching dirs and reports what it removed and
  what it kept, and why.
- A job that is unarchived, not settled, or differs from its archived tree is kept.
- After a prune, the next claimed id is still higher than every archived id, and Andon still
  shows the pruned job.
- With archiving off, `factory prune` is refused with a non-zero exit and removes nothing.
- docs/contract/v1.md lists the command; additive within v1. The gate passes.

## Contract calls
None beyond adding `factory prune` to docs/contract/v1.md's CLI section (additive).

## Open
None.
