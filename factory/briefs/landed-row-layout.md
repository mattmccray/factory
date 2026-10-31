# A landed epic's row: a wider name, its text right-aligned

- Status: ready
- Sources: `/factory explore` on 2026-10-31; factory/briefs/andon-landed-epic-row.md (decision 1);
  docs/design/epics/design.md (decision 9); apps/andon-ui/src/Lane.svelte (the landed sub-row),
  apps/andon-ui/src/app.css (`.row.sub.landed`)
- Date: 2026-10-31

## Intent
A landed epic's one-line row clips its name to the 148px gutter, so most epic names are cut off,
and its "Landed `<sha>` · N members · took … · … ago" text sits centered across the columns.
The name should get more room, and the text should sit flush right, so the row reads as a name
on the left and a record on the right.

## Decisions
1. How far does the name reach? → **The name's cell spans the gutter plus the first stage
   column (`grid-column: 1 / 3`, about 298px; wider when focused), still one line with an
   ellipsis; the landed text runs from column 3 to the end. Every landed row lines up on the same
   column edge.** Why: it's the "col span two" Matt asked for, keeps the row a single 28px line
   like the idle row, and doesn't shift with name length. Accepted side effect: the sticky
   (pinned) gutter is that much wider when the board scrolls sideways.
2. Where does the text sit? → **Right-aligned in its cell, with the cell's usual 10px right
   padding; when it doesn't fit, it truncates at its end with an ellipsis, as today.** Why: Matt
   asked for right instead of center alignment.

## Scope
- In: `apps/andon-ui` (Lane.svelte's landed sub-row, app.css's `.row.sub.landed` rules) and its
  tests; docs/design/epics/design.md (decision 9) where it describes the landed row's layout.
- Out: the idle project row, running/waiting/landing epic sub-lanes, the epic page, the Settled
  sheet, the service, the contract, the Mac app; what the row says (its text is unchanged).

## Acceptance sketch
- A landed epic's name cell covers the gutter and the first stage column; a long name shows
  noticeably more of itself, on one line, ellipsized when still too long.
- The "Landed `<sha>` · N members · took … · … ago" text is flush right in the rest of the row.
- The row is still one 28px line, green-toned, the name still opens the epic page, and search
  dimming/lighting works as before.
- When the board scrolls sideways, the widened name cell stays pinned at the left.
- Every other row (idle projects, project lanes, non-landed epic sub-lanes) looks exactly as
  today.

## Contract calls
None. (The design doc's landed-row description is updated to match; no `factory/v1` change.)

## Open
None.
