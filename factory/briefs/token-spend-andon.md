# Show token spend in Andon

- Status: done
- Job: 094-token-spend-andon (merged b4012a9 via epic token-spend, 2026-11-02)
- Epic: `factory/epics/token-spend.md` (after `token-spend-record`)
- Sources: `factory/briefs/token-spend-record.md`; `apps/andon-ui/src/TimingView.svelte` (the Stages and Agents tables); `docs/design/andon-overview/design.md` section 8 (Inspector)
- Date: 2026-11-02

## Intent
Once the CLI records token spend (`token-spend-record`), Andon shows it next to the timing, so a
job's cost per phase can be read where its time per phase already is, without the terminal.

## Decisions
1. What one number stands for an agent's spend in the tables? → **"Tokens": the sum of the four
   counts (input, output, cache write, cache read), written compactly (`2.4M`); its tooltip gives
   the four-way breakdown and the model, and a small usage summary under the tables lists the
   job's totals by kind.** Why: it is the intuitive "spend" and tracks the volume that drives
   usage; the breakdown, which `token-spend-record` decision 3 keeps in the record, stays one
   hover away. Output-only was rejected: it hides the context volume, where a long builder costs.
2. Where does spend appear? → **The inspector and the epic page only.** The job's timing view
   gets a Tokens column in the Stages and Agents tables, an orchestrator row at the end of the
   Agents table, and the usage summary; the header's timing summary line gains the job's total
   ("… · round 1/2 · 64M tokens"). The epic page shows the epic's total (its orchestrator
   figure plus its members' spend), with each member row showing its own total. The board's
   tokens, their hover popover, and the Settled sheet don't change. Why: the board answers
   "what's happening", not "what did it cost", and merged tokens were just compacted to one line.
3. How do gaps read? → **Not recorded** (a job or span from before tracking): a muted `—`,
   tooltip "Not recorded (before token tracking)"; a job with nothing recorded leaves tokens out
   of its summary line, never `0`. **Unavailable**: a muted `?`, tooltip the CLI's recorded
   reason. **Partial**: any total with an unknown span reads `≥ 64M`, tooltip "<n> span(s)
   unavailable", never as exact. **A running span**: blank until it closes (spend lands at span
   close; no live counter). Why: each gap says what it is, and a total is never shown as more
   certain than it is.

## Scope
- In: the Tokens column in the inspector's Stages and Agents tables (the compact sum, its tooltip
  with the four counts and the model); the orchestrator row; the usage summary by kind under the
  tables; the job's total in the header's timing summary line; the epic page's total and its
  member rows' totals; the gap states (decision 3); the design doc
  (`docs/design/andon-overview/design.md` and the epics design, where they describe these
  views) updated to match.
- Out: the board's tokens and their hover popover; the Settled sheet; dollar figures; any change
  to what the CLI records (`token-spend-record` owns that). Andon writes no job state.

## Acceptance sketch
- A job run after tracking shows a Tokens value on every finished stage and agent row, an
  orchestrator row, a usage summary by kind, and its total in the summary line; hovering a value
  shows input, output, cache write, cache read, and the model.
- A job from before tracking looks as it does today, with `—` in the Tokens column and no tokens
  in its summary line.
- A span recorded as unavailable shows `?` with the reason, and every total that includes it
  reads `≥ …`.
- An agent still running shows a blank Tokens cell.
- An epic's page shows the epic's total and each member's total.
- The board's tokens and popovers are unchanged.

## Contract calls
None.

## Open
None.
