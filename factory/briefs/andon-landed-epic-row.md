# A landed epic collapses to one line on the board

- Status: ready
- Sources: `/factory explore` on 2026-10-31; factory/briefs/andon-epics-ui.md (decisions 1–2);
  docs/design/epics/design.md (decision 9); docs/design/andon-overview/design.md (§5, "Idle
  lanes"); apps/andon-ui/src/lanes.ts (`laneOf`, `epicGutter`, `cellsOf`), Lane.svelte, board.ts
  (`isEpicSettled`)
- Date: 2026-10-31

## Intent
Today a landed epic keeps its full sub-lane, with its members as Merged tokens, until it settles
(`settleAfterHours`), so a finished epic takes several rows. A landed epic should collapse to one
compact line, like an idle project, that says it landed; the epic page is where Matt drills in to
its members and their jobs.

## Decisions
1. What does a landed epic's row show? → **One 28px row, styled like an idle lane: the indented
   gutter with the elbow, the green dot, and the epic's name (which opens the epic page, as
   today); across the columns, "Landed `<sha>` · N members · took <duration> · <age> ago". Its
   members leave the Merged column while it is landed; they are reached through the epic page
   (and, once it settles, the Settled sheet).** Why: a landed epic is a record, with nothing to
   act on; the epic page already lists every member with its job, so the row needs no expander.
2. Does a landed epic keep its project out of idle? → **No. A project whose only shown epics are
   landed (and which has no other job on the board) is idle: its lane collapses to the usual idle
   row and sorts in the idle tier, with the landed epic's one line under it (elbow and all). The
   idle row's "last merge" counts the epic's landing (its `endedAt`), so it reads "Idle · last
   merge 2h ago".** Why: collapsing the epic but leaving an empty, expanded project lane above it
   would give the rows back; and a landed epic needs nothing from Matt, so it shouldn't sort with
   active work.
3. Focus and Needs Me? → **A landed epic is always one line: focusing its project doesn't expand
   it, and Needs Me never shows it (it needs nothing).** Why: focus is for looking closely at
   moving work; the epic page shows the members better (plan order, edges, job links), and one
   rule is easy to remember.

## Defaults (not questioned; the spec-writer may refine)
- Search: a hit on a landed epic's member job (no longer a token) lights that epic's row instead
  of leaving it dimmed; a hit on its title or slug lights it as today.
- The row is green-toned like the gutter's "Landed" today, never red or orange; the landing epic
  (`landing`, not yet `landed`) keeps its full sub-lane.
- When it settles (`settleAfterHours` after its landing) the row leaves the board for the Settled
  sheet, as today.

## Scope
- In: `apps/andon-ui` (lanes.ts, Lane.svelte, find.ts as needed) and its tests;
  docs/design/epics/design.md (decision 9) and docs/design/andon-overview/design.md ("Idle lanes")
  to describe the landed row and the idle rule.
- Out: the service and the contract; the epic page and the Settled sheet (unchanged); the Mac app;
  any expander or inline drill-in on the row; a running, waiting, or landing epic's sub-lane.

## Acceptance sketch
- A landed, unsettled epic renders as one line with its landing sha, member count, duration, and
  age; no member tokens.
- Clicking its name opens the epic page, which lists its members and links to their jobs.
- A project with nothing but a landed epic shows the idle row ("Idle · last merge <the landing's
  age> ago"), sorts with the idle projects, and counts as idle in the header's "N active · M idle".
- Focusing that project leaves the landed epic on one line; Needs Me doesn't show it.
- A running, waiting, or landing epic, and a project with no epics, look exactly as today.

## Contract calls
- Design amendment, approved by Matt on 2026-10-31: a landed epic's sub-lane is one line with no
  member tokens, and a landed epic doesn't keep its project out of idle. The job updates
  docs/design/epics/design.md (decision 9) and docs/design/andon-overview/design.md ("Idle
  lanes") to match. No `factory/v1` contract change.

## Open
None.
