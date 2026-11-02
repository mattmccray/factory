# Record token spend per job and phase

- Status: done
- Job: 093-token-spend-record (merged 72a4652 via epic token-spend, 2026-11-02)
- Epic: `factory/epics/token-spend.md`
- Sources: Claude Code transcripts (`~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl` and `.meta.json`); `docs/contract/v1.md` (agent spans); `docs/decisions.md` (decisions 3, 4, 9)
- Date: 2026-11-02

## Intent
Today the factory records how long each job, stage, and agent took, but not how many tokens
they spent. Matt wants to see token spend per job and per lifecycle phase (spec, build per
round, each reviewer per round, approver), kept with the job's record so it outlives Claude
Code's transcript cleanup.

## Decisions
1. Recorded in the job's record, or a report computed on demand? → **Recorded.** Why: Claude
   Code deletes transcripts after about 30 days, so an on-demand report loses the history the
   feature is for; an additive change to v1 is allowed, and it gives Andon and the archive the
   numbers for free.
2. How does the CLI find an agent span's transcript? → **The orchestrator passes the harness's
   agent id on `agent.finished` (`agentId=<id>`); the CLI finds `subagents/agent-<id>.jsonl`
   under the project's Claude Code folder and sums the usage of the messages timestamped inside
   that span.** Why: exact, one extra field on an event the orchestrator already sends, and the
   window handles a builder resumed across rounds. The id is a handle from the harness, not a
   model-made number (decision 4). The skill's rule against recording Claude Code ids is about
   `session=`; its wording is amended to allow this one.
3. What is recorded per span? → **The four raw token counts (input, output, cache write, cache
   read) and the model; no dollar figure.** `job.json` rolls them up per agent, stage, round,
   and job, following the timing's shape. Why: the counts are priced very differently, so one
   summed number would hide cost; the model shows which role ran on what; prices change and a
   subscription isn't per-token, so a stored price would go stale while raw counts stay true. A
   cost estimate (e.g. Andon with a price table) is deferred.
4. Is the orchestrator's spend recorded? → **Yes, as its own slice.** The CLI finds the
   orchestrating session(s) from the job's agent ids (an agent transcript lives under its
   parent session's `subagents/` folder) and sums that session's messages inside the job's
   active time, from claim to its end (merge, escalation, abandon), with each later stretch
   (`rework`, `approve`) counted the same way. No session id is recorded. **A standalone job**
   gets an `orchestrator` slice; **an epic's** orchestrator spend goes in `epic.json` as one
   figure for the epic, and its member jobs carry only their agents' spend. Why: in job 092 the
   orchestrator was about a third of the total; splitting an epic driver's spend across members
   would be invented precision. Session time outside a job's window (an `explore` before the
   claim, work after the merge) isn't counted.
5. What happens when usage can't be read (a missing or unflushed transcript, a changed format,
   another harness, no `agentId`)? → **Accounting never blocks the pipeline.** The event always
   succeeds; the span records usage as unavailable with a one-line reason; totals show as
   partial (e.g. "≥ 1.2M, 1 span unknown"), never as a wrong exact number; `doctor` adds no
   failure for it. Why: a job exists to ship code, and a Claude Code format change must not
   halt every job.
6. Where does it show, and how is the work split? → **An epic, `token-spend`, of two briefs.
   This one records the spend (the contract, the CLI, the rollups, the skill) and adds a usage
   table to `factory show <id>`; `token-spend-andon` shows it in Andon after this one merges.**
   Why: the CLI half is useful on its own, and the contract reviewer and the UI reviewer each get
   a focused diff.
7. Backfill jobs that ran before this lands? → **No; deferred.** Earlier jobs, and spans that
   closed before the upgrade, show usage as "not recorded" (distinct from "unavailable").
   Why: a backfill would append events to merged jobs, which reject every event; it sits with the
   already-deferred reconstruction of legacy timing.

## Facts (found, not decided)
- Each subagent transcript has per-message `model` and `usage` (input, output, cache-creation,
  cache-read tokens). Its first message is the factory spawn card (job id, round), and its
  `.meta.json` names the `agentType`.
- The Agent tool's returned `totalTokens` is the last turn's context size, not the agent's
  spend; the real spend is the sum over the transcript's messages.
- A builder resumed with SendMessage keeps appending to the same transcript, so a span's spend
  is the messages whose timestamps fall inside that span.
- The transcript format is Claude Code's internal format, not a documented API.

## Scope
- In: `agentId=<id>` on `agent.finished` (optional, additive); the CLI reading that agent's
  Claude Code transcript at span close and recording the span's model and four token counts, or
  "unavailable" with a reason; the orchestrator slice (decision 4) for standalone jobs and the
  epic figure in `epic.json`; rollups in `job.json` per agent, stage, round, and job, with
  partial totals when a span is unknown; a usage table in `factory show <id>` (and the epic's
  total in `epic show`); the skill passing `agentId` on every `agent.finished` and its
  session-id rule reworded to allow the agent id; `docs/contract/v1.md` updated in the same
  diff; the deferred list gains the cost estimate and the backfill.
- Out: dollar figures or price tables; backfilling earlier jobs; Andon display (the epic's
  `token-spend-andon`); harnesses other than Claude Code (their spans record "unavailable").
- Must not: copy anything from a transcript but the model and the token counts (no prompts, no
  content); block, refuse, or fail any event, merge, or `doctor` over missing usage; put Claude
  Code's transcript format in the contract (it lives in a Claude-specific reader behind a
  harness-neutral usage shape, decision 9).

## Acceptance sketch
- A job run after this lands shows, in `factory show <id>`, tokens (input, output, cache write,
  cache read) and the model for each agent span, totals per stage, per round, and for the job,
  plus an orchestrator line.
- A builder resumed for round 2 shows round 2's spend separately from round 1's, from the same
  transcript.
- An epic shows its orchestrator spend once, in `epic show`, and its members show only their
  agents' spend.
- With the transcript missing, or no `agentId`, the event still succeeds, the span reads
  "unavailable: <reason>", and the totals read as partial.
- A job that ran before this lands reads "not recorded".
- `job.json` and `events.jsonl` hold no transcript content.

## Contract calls
"Additive v1 change: `agent.finished` accepts an optional `agentId`; agent spans in `job.json`
carry usage (model and four token counts, or unavailable with a reason); `job.json` gains usage
rollups and an orchestrator slice; `epic.json` gains the epic's orchestrator usage", approved by
Matt on 2026-11-02. The job updates `docs/contract/v1.md` to match.

## Open
None.
