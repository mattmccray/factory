# Merge conflicts go back to the builder instead of to a human

- Status: ready
- Sources: docs/design/epics/design.md (decisions 4 and 5; brief 1 of 5); `/factory explore` on
  2026-10-29; docs/contract/v1.md ("`events.jsonl`", "Transitions the CLI enforces", "`job.json`",
  "CLI"); packages/contract/src/contract.ts (event parsing and transition checks);
  packages/templates/assets/skill/SKILL.md (Merge, Ground rules);
  packages/templates/assets/agents/builder.md
- Date: 2026-10-29

## Intent
Today a merge conflict stops a job: `merge.failed` sends it to `needs-human`, and Matt has to
`/factory rework` it so the builder rebases. Instead, the orchestrator hands the conflict back to
the job's own builder, which merges the target into its branch in the job worktree and resolves
it; the job then goes through a normal review round and the approver, and merges again. Only a
job that keeps conflicting escalates. This applies to every job, standalone or (later) in an epic.

## Decisions
1. Who sets the new budget and enforces the limit? → **The CLI. The new event
   `merge.conflicted` carries only `reason`; the CLI derives stage `build`, `maxRound = round + 2`,
   `note = reason`, and a new `job.json` field `conflicts` (incremented), and refuses a third
   `merge.conflicted` (when `conflicts` is already 2) with a one-line reason telling the
   orchestrator to log `merge.failed`.** The limit is fixed at 2 in the contract, not a config
   key. Why: the CLI defends the rule itself, as it does WAIT FOR ALL, so a forgetful orchestrator
   can't loop; no new integer fields widen the CLI's deliberately narrow value parsing; and the
   round + 2 budget can't drift between skill and code. A config key can come later if 2 is wrong.
2. Is it also allowed after a human approval? → **Yes: `merge.conflicted` is allowed from
   `approve` and from `needs-human` once the job has `job.human-approved`, with the same budget,
   count, and limit; it moves the job to `build` and clears the human approval (as `merge.failed`
   resets it today).** After the builder resolves, it gets a review round and the approver like
   any other job, and an `ESCALATE` there comes back to Matt with its reason. `/factory approve`
   then no longer guarantees a merge in the same step; the approving session drives the loop on.
   Why: the human approved the work as it stood, not a resolution that didn't exist yet, and both
   paths are the same case ("approved work, merge conflicted").
3. What does the builder get? → **A facts-only note, `jobs/<id>/conflict-<c>.md` (`c` = the new
   `conflicts` count), written by the orchestrator right before `merge.conflicted`: the target
   branch and its sha at the failed merge, the conflicting paths (`git diff --name-only
   --diff-filter=U`, taken before the abort), and `git merge`'s one-line summary. The "how" is a
   new section of the managed builder template:** when the card names a conflict note, merge
   `<base>` into the branch in the job worktree as a merge commit (no rebase, no force-push, no
   history rewrite), resolve keeping both sides' intent, run the gate, and add a `## Conflict <c>`
   section to `build.md` saying how each path was resolved and what it kept from each side. The
   resume message names the note (as a rework names `rework-<k>.md`); a builder not alive in the
   session is spawned fresh from the files. The approver reads `conflict-*.md` as it reads rework
   notes; reviewers need nothing new (their diff includes the merge). Why: facts are the job's,
   the method is a standing versioned rule; a merge commit keeps every reviewed commit intact.
4. How does Andon show it? → **Only the service change: it lists `conflict-*.md` in the
   inspector's Job files, after the rework notes. The token keeps "Rework → R2", and the card's
   note carries the reason.** Why: the point is that conflicts stop needing Matt, so one more
   quiet round is the intended look; a distinct "Conflict → R2" needs a projection field saying
   why the job is back in build, which can be added later if wanted.

## Scope
- In: the `merge.conflicted` event, its transitions, and the `conflicts` field in
  `packages/contract` (types, parsing, transition checks, projection) and the CLI; the contract
  doc (`docs/contract/v1.md`); the skill's Merge step and `/factory approve` path
  (`packages/templates/assets/skill/SKILL.md`); the builder and approver templates
  (`packages/templates/assets/agents/builder.md`, `approver.md`); the Andon service listing
  `conflict-*.md` in a job's files; tests for all of it.
- Out: epics (briefs 2–5 of docs/design/epics/design.md); a configurable conflict limit; any
  Andon token, label, or style change ("Rework → R2" stays); a field recording why a job is back in
  build; changing the overlap check; any non-conflict merge failure (a wrong checkout, a stray
  `index.lock`), which still logs `merge.failed`; rebasing or rewriting a job branch's history.

## Acceptance sketch
- A job whose merge into its target conflicts goes back to `build` instead of `needs-human`: the
  orchestrator aborts the merge, releases `factory/.lock`, writes `conflict-<c>.md`, logs
  `merge.conflicted`, and resumes the builder, which merges the target into the job branch with
  a merge commit, resolves, runs the gate, and records a `## Conflict <c>` section in `build.md`.
  The job then runs a normal review round and the approver, and merges.
- `merge.conflicted` is accepted from `approve`, and from `needs-human` only after
  `job.human-approved`; it is rejected from every other stage, and its third occurrence on one job
  is rejected with a one-line reason naming `merge.failed`. A rejected event writes nothing.
- After `merge.conflicted`: stage `build`, `maxRound = round + 2`, `conflicts` + 1,
  `note = reason`, human approval cleared; the next `round.started` is `round + 1`.
- `job.json` always carries `conflicts` (0 when none); readers treat a missing key as 0, and
  `rebuild` derives it from the log. Logs without the event stay valid v1.
- `merge.conflicted` takes only `reason`; any other field (`maxRound`, a count, `session`) is an
  extra field and is rejected. The CLI's value parsing is unchanged.
- A non-conflict merge failure still logs `merge.failed` and goes to `needs-human` as today.
- The builder template tells a builder given a conflict note to merge (never rebase or
  force-push), keep both sides' intent, run the gate, and record each path's resolution; the
  approver template reads `conflict-*.md` as it reads rework notes.
- The Andon inspector lists `conflict-*.md` in the job's files after the rework notes.
- The contract doc describes the event, its transitions, `conflicts`, `conflict-<c>.md` in the
  layout, and the conflict note on the builder's card and in the builder's and approver's reads.

## Contract calls
- "A new event `merge.conflicted` (`reason`), allowed from `approve` and from `needs-human` after
  `job.human-approved`, moving the job to `build` with `maxRound = round + 2`, `note = reason`, and
  human approval cleared; refused once `conflicts` is 2. A new `job.json` field `conflicts`
  (integer, default 0). A new orchestrator-written input `jobs/<id>/conflict-<c>.md`, added to the
  builder's card and to the builder's and approver's reads." Approved by Matt on 2026-10-29. It is
  additive within `factory/v1` (a new event, a new snapshot field with a default, a new input
  file; no existing transition changes). The job updates `docs/contract/v1.md` to match.

## Open
None.
