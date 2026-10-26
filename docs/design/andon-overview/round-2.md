# Round 2: Assembly Lines, three iterations

## What the user chose in round 1

- **Assembly Lines (02)** is the daily view: a project × station matrix with one thin lane per
  project. They love the blueprint look.
- **The Ledger (03)** stays alive as a *report*, not a live view: an end-of-week, end-of-month,
  or per-project report. It's parked for a later round.
- The user always runs in **dark mode**.

## The three iterations

| file | direction |
|---|---|
| `mockups/06-lines-cyanotype.html` | Dark blueprint, a true cyanotype: deep Prussian-blue sheet, white and pale-cyan linework, the same drafting details as 02. |
| `mockups/07-lines-mac.html` | The same layout as a native macOS app in dark mode: window chrome, a source-list sidebar, a toolbar, an inspector. No blueprint styling. |
| `mockups/08-lines-mac-blueprint.html` | A hybrid: native Mac app structure and controls, with blueprint touches in the canvas (grid, dimension lines, a drafting accent color). |

Each keeps 02's layout: an Andon (needs-human) column, then Spec, Build, Review, Approve, and
Merged; lanes sorted by trouble; idle projects collapsed; a distinct token shape per state; and
"stopped here → andon" marks.

## Full interactivity (all three)

They read `data.js` and `docs.js` (`FACTORY.docsFor`, `agentsFor`, `stagesFor`, `md`, `dur`,
`iso`, `landing`). Every feature below must work:

1. **Job drawer or inspector**, opened by clicking a token. It shows the project · id · stage, the
   title, `branch → target`, and a one-line timing summary. A file list is grouped like today's
   Andon: **Job** (timing, feature.md, spec.md, build.md, decision.md), then **Round N** (one
   review per reviewer, each with a PASS or CHANGES verdict dot). The selected file renders as
   markdown. The default file is the latest one that isn't feature.md. Esc closes it, and
   ↑/↓ move between files.
2. **Timing view** in the drawer: claimed and merged times, a stage bar with a legend, a stage
   table (stage, round, entered, duration), and an agent table (agent, round, result, started,
   duration).
3. **Needs-human actions** in the drawer for escalated or merge-failed jobs: an **Approve**
   button and a **Rework…** button with a note field, each showing the exact CLI command
   (`/factory approve <id>`, `/factory rework <id> "<note>"`) with a copy button. The mock-up
   only shows a toast; it doesn't change state.
4. **Project focus**: clicking a lane's project name filters to that project (one lane, with
   more room, e.g. the full title on each token). Show a clear "All projects" way back. Also
   include a project switcher control (a menu, sidebar, or popover) with per-project
   needs-human counts.
5. **Settled**: a "Settled · N" control opens a dialog or sheet listing merged jobs older than
   24h, newest first, with total time and round count. Clicking a row opens that job's drawer.
   A collapsed idle lane's "settled ×N" opens the same list filtered to that project.
6. **Hover preview** on tokens (a compact popover); click pins it by opening the drawer.
7. **Search or filter**: a field that dims non-matching tokens by id or title, focused with `/`.
   A "needs me" toggle shows only needs-human and review-failed work.
8. **Live feel**: timers tick each second from the fixture's NOW. A **Replay** control advances
   one scripted event every couple of seconds so the user can watch a token move:
   orchard/019's reviewers finish one by one, then it moves to Approve, then to Merged. Use a
   short motion for the move and a brief highlight on arrival.
9. **Deep links** for review and screenshots: the URL hash restores state. `#job=<key>` opens
   the drawer, `&file=<path>` selects a file (`timing` for the timing view), `#project=<id>`
   focuses a lane, and `#settled` opens the Settled dialog. Update the hash as the user
   navigates.
10. **Keyboard**: `/` search, Esc closes the top layer, `g a` goes to All projects, `?` shows a
    shortcut sheet.

The page targets a 1440×900 viewport, dark mode, and American English.
