# Andon overview redesign

Andon's overview is a Kanban board today: a needs-human row, then five station columns
(Spec, Build, Review, Approve, Merged). That works for one or two projects. With a dozen or more
registered projects it gets too tall and too sparse, so this folder explores other ways to show
the same jobs.

## Layout

- `mockups/`: every concept we try, kept for the record. Each is a self-contained HTML file
  that reads the shared fixture `mockups/data.js`. Open `mockups/index.html` to browse them.
- `chosen/`: the concept we picked (07, the Mac app), copied here with its fixture so it stays
  stable while we refine it. `overview.png` and `inspector.png` are its reference screenshots.
- `design.md`: the accepted design, the contract job (0) and the four staged factory jobs (A–D)
  that implement it in `apps/andon-ui` and `apps/andon`, and the decisions behind it.

## The fixture

`mockups/data.js` freezes one moment (2026-10-25 16:30 UTC) across 12 projects and 30 jobs, so
every concept shows the same state. It covers every state the board must show:

| state | where in the fixture |
|---|---|
| needs-human (escalated by the approver) | `minerva/040-tag-migration` |
| needs-human (review budget spent) | `ledgerline/007-oauth-banks` |
| needs-human (merge failed) | `aegis-v5/111-session-timeout` |
| review failed (CHANGES, round complete) | `ledgerline/008-csv-import` |
| in review, round 2 after CHANGES | `minerva/041-notes-search` |
| in review, all pending | `orchard/019-sync-retry` |
| back in build after CHANGES | `tinyjs/066-tray-menu` |
| approve | `aegis-v5/112-admin-roles`, `cartograph/031-tile-cache` |
| build, spec, claimed | `factory/022`, `quill/003`; `aegis-v5/113`, `sundial/005`; `brain-cli/017` |
| merged (last 24h) | `factory/021`, `minerva/039`, `cartograph/030`, `quill/002`, `brain-cli/016` |
| settled (merged > 24h ago) | the rest; `harbor` and `beacon` are idle, with only settled work |

## Round 1 concepts

1. **Shift Log** (`01-timeline.html`): a Gantt timeline, one lane per project, with stage-colored bars running into a NOW line.
2. **Assembly Lines** (`02-swimlanes.html`): a project × station matrix, a compact Kanban with one thin lane per project.
3. **The Ledger** (`03-ledger.html`): a dense list with one row per job, grouped by what each job needs from you.
4. **Signal Wall** (`04-signal-wall.html`): a grid of project tiles styled like an andon light panel.
5. **Orbit** (`05-orbit.html`): a radial view with one sector per project and stations as rings, where work flows inward to merge.

## Round 2: Assembly Lines (see `round-2.md`)

Assembly Lines is the daily view. The Ledger is parked as a future weekly, monthly, or project report.
Every round-2 mock-up is fully interactive (drawer with docs, timing, approve/rework, project
focus, Settled, search, a scripted replay) and deep-linkable by URL hash.

6. **Cyanotype** (`06-lines-cyanotype.html`): a dark blueprint with white linework on Prussian blue.
7. **Mac app** (`07-lines-mac.html`): a native macOS dark-mode app with a sidebar, toolbar, and inspector.
8. **Mac + blueprint** (`08-lines-mac-blueprint.html`): native Mac chrome around a blueprint canvas.

`mockups/docs.js` adds each job's files and agent timing to the fixture.

## Decision (2026-10-26)

**07, the Mac app, is the winner.** The user called it "professional, polished, yet fun": it
gives what they need at a glance, and its interactions feel right. It's in
`chosen/andon-overview.html`. The rest stay in `mockups/` for the record, and The Ledger (03)
stays parked as a future report view.

The design is in `design.md`.
