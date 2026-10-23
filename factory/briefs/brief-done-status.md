# Mark a brief done when its job merges

- Status: ready
- Sources: `packages/templates/assets/skill/SKILL.md` (Merge, bookkeeping), `packages/templates/assets/skill/explore.md` (brief format), `docs/contract/v1.md` (`job.claimed.brief`), `HANDOFF.md` ("Backlog and brief formats")
- Date: 2026-10-23

## Intent
When a job that carries a brief merges, the brief still says `Status: ready`, so you can't tell
from the brief whether it was carried out, or by which job (`readme.md` → 011 and
`target-branch.md` → 014 are both still `ready`). After this change, a merged job marks its brief
done and points the brief at the job and the merge commit.

## Decisions
1. What does a merged brief say? → **`Status: done`, plus a header line right below it:
   `- Job: <id> (merged <short sha>, <YYYY-MM-DD>)`.** Why: `done` reads plainly and isn't tied
   to git wording if the merge policy changes later; the `Job:` back-link is the part you
   actually want when you open an old brief.
2. Who writes it, and when? → **The orchestrator, in the Merge step's bookkeeping, after
   `job.merged` succeeds, and only when `job.json` has a `brief`.** It sets the `Status:` line,
   adds the `Job:` line, and commits brief and backlog tick together by pathspec
   (`-- factory/backlog.md factory/briefs/<slug>.md`, message unchanged:
   `chore(factory): record job <id>`). `/factory approve` merges go through the same step.
   Why: the brief is a tracked human-facing file like the backlog the orchestrator already
   ticks; the CLI writes job state and never commits. No new event, no contract-surface change.
3. Briefs already merged? → **Backfilled by hand in the commit that adds this brief**
   (`readme.md` → 011, `target-branch.md` → 014); no backfill tooling. This brief itself is
   marked done by hand after its job merges, alongside promotion, since this repo's installed
   skill gets the new step only via `factory upgrade`. Why: jobs never change `factory/`, and a
   sweep command is tooling for a one-time cleanup of two files.
4. A `done` brief at claim or explore? → **Claim refuses it with its own message naming the
   job (`brief <slug> is done (job <id>)`), not the draft message. `explore <slug>` doesn't
   reopen it: it says which job carried it out and offers a new brief that lists the old one
   under `Sources:`.** Why: each brief stays an accurate record of what one job was asked to do;
   follow-up work gets its own brief and job (as 009 followed 008).

## Scope
- In: `packages/templates/assets/skill/SKILL.md`: the Merge bookkeeping step marks the job's
  brief done and commits it with the backlog tick by pathspec; the claim rule's `done`
  refusal. `packages/templates/assets/skill/explore.md`: the format's status becomes
  `draft | ready | done`, documents the `- Job:` line (written only at merge), and the "existing
  brief" start refuses to reopen a `done` brief. Render tests in
  `packages/templates/src/render.test.ts` that pin the new text.
- Out: any CLI command or event (no contract change); backfill tooling; touching `factory/` or
  `.claude/` (the backfill and marking this brief done are hand steps outside the job); promotion
  into this repo's installed copy (that's `factory upgrade`, after merge); marking briefs of
  escalated or abandoned jobs.

## Acceptance sketch
- The rendered skill's Merge step, after `job.merged`, tells the orchestrator: when `job.json`
  has a `brief`, set its `Status:` to `done`, add `- Job: <id> (merged <short sha>, <date>)`
  right below it, and commit it together with `factory/backlog.md` by pathspec in the
  `chore(factory): record job <id>` commit; no brief → backlog only, as today.
- The rendered skill's claim rule refuses a `done` brief with a message naming its job,
  distinct from the draft refusal.
- The rendered `explore.md` shows `Status: draft | ready | done` and the `Job:` line, and says a
  `done` brief isn't reopened: name the job, offer a new brief citing it in `Sources:`.
- Render tests fail on the old bookkeeping text (backlog-only pathspec) and pass on the new.
- `bun run test && bun run check` green; nothing under `factory/` or `.claude/` in the diff.

## Contract calls
None. The brief format is a skill-owned surface (HANDOFF "Backlog and brief formats"); no
event, field, or `docs/contract/v1.md` change.

## Open
None.
