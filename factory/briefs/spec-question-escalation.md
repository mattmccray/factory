# Escalate a spec's open questions at the spec step

- Status: ready
- Sources: thread "Test Andon to T3 Code Handoffs" (job 086-andon-remote-handoff, 2026-10-31); jobs 062 and 068 (escalated by the approver on a spec's open item, after a full build)
- Date: 2026-10-31

## Intent
When a spec writer lists an open question, the orchestrator today either builds on it (and the
approver escalates a whole build later, as in 062 and 068) or improvises a chat question without
logging anything, so Andon shows a stuck Spec card (086: 1h43m with no event). The job should
go to Needs Human at once, with the question on the card, so Andon shows it is waiting on Matt
and any session can pick it up.

## Facts
- The spec writer already triages: "Never ask questions. Make the most reasonable assumption,
  state it in Scope, and list genuine conflicts in the last section" (agent definition, Rules);
  this repo's overlay narrows "genuine" to an unapproved contract change, a non-additive change,
  a clash with a decision, deferred work, or a path outside the job surface. Of specs 032–086,
  only 062, 068, and 086 listed anything open, and all three needed a human.
- The approver already escalates on any open item not marked "approved in brief"
  (`approver.md`, the first escalation trigger), so escalating at spec time adds no human touch;
  it moves the same one before the build.
- `job.escalated` is already allowed from `spec` (contract, "Transitions the CLI enforces"), and
  sets `stoppedFrom = "spec"`. The skill's `/factory rework` re-runs the spec writer only when the
  job escalated before `spec.md` existed.
- Andon today: a needs-human token's tag is "Escalated"; the inspector's needs-human box makes
  Approve the primary button (`apps/andon-ui/src/Inspector.svelte`, `lanes.ts` `tagOf`).

## Decisions
1. What happens when a spec lists open questions? → **The orchestrator escalates right after the
   spec step** (`job.escalated reason='spec has open questions: …'`), before any worktree or
   build; Matt answers with `/factory rework <id> "<answer>"`, which re-runs the spec writer with
   the note, then builds. Why: no contract change, `needs-human` is durable and any session (or
   Andon's rework hand-off) can resume it, and it matches the approver's existing trigger one
   build earlier. A `job.waiting` marker was rejected: a contract call, Andon UI work, and it goes
   stale if the asking session dies.
2. Grade open questions by severity, letting minor ones through to the builder? → **No tiers.**
   The spec writer's existing rule (assume and state it in Scope; list only genuine conflicts)
   is the severity gate, and everything that passes it escalates. Each open item states its
   assumed answer and the alternatives, so the escalation note can read "… (assumed: yes)" and
   the reply is often "go with the assumption". Why: the triage already happens (062, 068, 086
   were all real), and a "minor" tier would let the spec writer downgrade what the approver
   escalates on anyway.
3. How does Andon show a job that stopped before the build? → **When a needs-human job's
   `stoppedFrom` is `spec` or `claimed`, its tag reads "Question" (not "Escalated"); in the
   inspector, Rework… is the primary button and Approve is grayed out with the tooltip "Nothing
   built yet".** The skill's `/factory approve` refuses such a job ("nothing built; answer with
   rework"). Why: nothing has been built, so Approve would merge an empty branch, and the board
   should tell "answer a question" from "review a finished build". Keyed on the existing
   `stoppedFrom`, so no contract change. Accepted: a spec writer that wrote no `spec.md` also
   shows "Question"; rework is still the right step, and the note says what happened.
4. The dashed ghost such a job leaves in the Spec column? → **"asked here → Andon"** (other
   needs-human jobs keep "stopped here → Andon"; failed merges keep "merge broke here → Andon").
   Why: it pairs with the "Question" tag as "merge broke here" pairs with "Merge failed", so the
   Spec column itself says a question is waiting. The ghost already appears for any needs-human
   job via `stoppedFrom`; 086 showed none only because nothing was logged.

5. Which stage is the job in while the spec writer re-runs after the answer? → **`spec`: the CLI
   derives it. `job.reworked` on a job whose `stoppedFrom` is `spec` or `claimed` enters `spec`,
   not `build`;** the orchestrator re-runs the spec writer, logs `job.titled`, then enters `build`
   as usual. Why: the board shows what is happening (not "Building" while the spec is rewritten),
   the orchestrator can't forget it because the CLI derives it, and it closes the Known gap "A
   spec-writer rerun after a spec-stage rework is timed under `build`". No job in this repo has a
   rework after a spec-stage stop, so no existing `job.json` rebuilds differently. If the contract
   reviewer finds the derived rule too strong for "additive only within v1", the accepted fallback
   is an optional `stage=spec` field on `job.reworked`.

## Scope
- In:
  - The skill (`packages/templates/assets/skill/SKILL.md`): after step 1, if `spec.md` lists any
    contract conflict or open question not marked "approved in brief", log
    `job.escalated reason='spec has <n> open question(s): <first, with its assumed answer>'`
    and stop before the worktree; tell Matt to answer with `/factory rework`. In an epic, the
    member escalates as any member does and the epic keeps driving.
  - A ground rule in the skill: the orchestrator never stops mid-job to wait on the human
    without logging `job.escalated` first (no off-the-board questions).
  - `/factory rework` on a job that stopped from `spec` or `claimed`: re-run the spec writer
    with the rework note (also when `spec.md` exists), `job.titled`, then step 2 onward.
    `/factory approve` refuses such a job ("nothing built; answer with rework").
  - The spec-writer definition (`packages/templates/assets/agents/spec-writer.md`): reads any
    `rework-*.md` as binding human decisions, like the brief's; each open item states the
    question, its assumed answer, and the alternatives.
  - The CLI and contract: `job.reworked` enters `spec` when `stoppedFrom` is `spec` or
    `claimed` (`packages/contract`, `docs/contract/v1.md`); drop the Known gap line from
    `docs/decisions.md`.
  - Andon UI (`apps/andon-ui`): the "Question" tag, the "asked here → Andon" ghost, and the
    needs-human box (Rework… primary, Approve grayed with "Nothing built yet") for a
    needs-human job whose `stoppedFrom` is `spec` or `claimed`; the design-doc amendment.
- Out:
  - A `job.waiting` / `job.resumed` event or any "waiting on you" marker for working jobs.
  - Severity tiers for open questions.
  - An Andon "stale job" heuristic (a working stage with no open span for a long time).
  - Changes to the approver's triggers (it still escalates on any unapproved open item).
  - The Mac app (`apps/andon`) and the Andon service: no change.

## Acceptance sketch
- A spec with an unapproved open question puts the job in Needs Human right after the spec step,
  with no worktree or build, and the note names the question and its assumed answer.
- Andon shows that job's token tagged "Question", a dashed "asked here → Andon" ghost in the
  Spec column, and an inspector box with Rework… primary and Approve grayed ("Nothing built yet").
- A needs-human job that stopped in build, review, or approve still reads "Escalated" and
  "stopped here → Andon", with Approve primary.
- `/factory rework <id> "<answer>"` on it puts the job back in Spec; the spec writer re-runs,
  reads the rework note as binding, and the job then builds as usual.
- `/factory approve` on it refuses and points to rework.
- The CLI derives `spec` from `job.reworked` after a spec or claimed stop, and `build` otherwise;
  rebuilding every existing job here gives the same `job.json` as before.

## Contract calls
- "Amend `docs/design/andon-overview/design.md` (§5 'Columns' and §6's tags) for the 'Question'
  tag, the 'asked here → Andon' ghost, and the needs-human box's primary action for a job that
  stopped before the build", approved by Matt on 2026-10-31. Not a `factory/v1` change.
- "`job.reworked` enters stage `spec` (not `build`) when the job's `stoppedFrom` is `spec` or
  `claimed`" in `docs/contract/v1.md` (`events.jsonl` table and transitions), and the matching
  Known gap removed from `docs/decisions.md`, approved by Matt on 2026-10-31. Fallback, if the
  contract reviewer finds it not additive: an optional `stage=spec` field on `job.reworked`.

## Open
None.
