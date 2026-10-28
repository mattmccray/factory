# Andon overview: design

Status: **accepted** (2026-10-26). The reference is `chosen/andon-overview.html`, mock-up 07 from
round 2. Its reference screenshots are `chosen/overview.png` and `chosen/inspector.png`.

This document is what factory jobs implement against `apps/andon-ui` and `apps/andon`, and
what the `ui` reviewer judges them by. Where it and the mock-up disagree, this document wins; the
mock-up shows the feel. Each section that a job implements is marked **(Job A–D)**; see "Jobs".

## 1. Why

Andon's board is a Kanban: a needs-human row and five station columns. With one or two projects
that's fine. With a dozen registered projects it's tall, sparse, and project-blind: a job's
project is a tag on its card, so "what is each project doing?" takes reading every card.

The new overview is an **Assembly Lines** board: a project × station matrix with one thin lane per
project, inside a **native-feeling macOS app** (sidebar, toolbar, inspector). One screen answers:

1. What needs me? The Andon column, red badges, and the Needs Me filter.
2. What is each project doing? One lane each, with work moving left to right.
3. What is this job, exactly? The inspector: its documents, timing, and the command to act on it.

## 2. Principles

- **At a glance.** Twelve projects and about 30 jobs fit at 1440×900 with no scrolling. State is
  readable from shape and color before any text is read.
- **Trouble first.** Needs-human work is red, has its own column, sorts its lane to the top, and
  is counted in the sidebar, the toolbar, and the Mac app's Dock badge (which already exists).
- **A real Mac app.** System type, system colors, hairlines, vibrancy, sheets, and an inspector.
  Never fake chrome: no drawn traffic lights or menu bar.
- **Read-only.** Andon never writes job state; only the factory CLI does. Actions copy the exact
  `/factory` command for you to run.
- **Same app in a browser.** Everything works in a plain browser tab; only the window chrome
  differs (section 4).

## 3. Anatomy (Job A)

```
┌──────────┬──────────────────────────────────────────────────────────┬────────────┐
│ sidebar  │ toolbar (52px, drag region)                              │ inspector  │
│ 216px    ├──────────────────────────────────────────────────────────┤ 392px,     │
│ vibrancy │ board: header row (sticky) + one lane per project        │ resizable, │
│          │                                                          │ pushes the │
│          │                                                          │ board      │
│ service ●├──────────────────────────────────────────────────────────┤            │
│          │ status bar (28px)                                        │            │
└──────────┴──────────────────────────────────────────────────────────┴────────────┘
```

**Sidebar** (216px, collapsible with the toolbar's sidebar button):
- **Overview**: "All Projects", with a red badge for the total needs-human count.
- **Projects**: every registered project, sorted by name. Each row has a status dot (its worst
  state: red needs-human, orange review failed, blue working, gray idle), the name, and a badge
  (red with the needs-human count, or gray with the active count, or none when idle). Selecting a
  project focuses it (section 7). This replaces today's project `<select>`, and the selection
  still persists under the existing `andon.project` key.
- **Footer**: the service connection ("Connected · andon-service · 12 projects", or "Connecting…" or
  "Unreachable"), with a green, gray, or red dot. This replaces the header's status.
- The mock-up's disabled "Reports" section (Weekly and Monthly ledger) is **left out** until the
  Ledger report exists.

**Toolbar** (52px):
- The sidebar toggle.
- The title, "Andon" (or the focused project's name), with a subtitle: "All Projects — 12 running,
  3 waiting on you". Running excludes needs-human; the waiting part is red and omitted at zero.
- A segmented control, **All Work | Needs Me** (with a red count badge on Needs Me).
- A search field (200px, `/` hint).
- **Settled** with a count badge.
- The inspector toggle.
- The mock-up's **Replay** button was a demo, so it's **left out**.

**Board.** A grid with a 148px project gutter and six equal columns: **Andon**, **Spec**,
**Build**, **Review**, **Approve**, and **Merged**. A sticky, blurred header row shows each
column's name, a colored square, a count badge, and its role (Andon: "needs a human"; Spec:
"spec-writer"; Build: "builder"; Review: "reviewers"; Approve: "approver"; Merged: "last 24
hours", using the smallest `settleAfterHours` shown). The gutter header reads "10 active · 2 idle".

**Status bar** (28px):
- The state legend: a swatch and a label for each state.
- "Settle after 24h".
- A live clock.
- "? shortcuts".

**Inspector** (392px by default, 320–560 with the left-edge grip, width persisted). It opens
beside the board and **pushes** it; it never covers it. When the window is narrower than 1640px,
opening the inspector auto-hides the sidebar, and closing it brings the sidebar back.

## 4. The window: the Mac app and browser (Job A)

Tiny JS 0.65 supports a hidden title bar (`types/tiny.d.ts`, `TinyChromeOptions`). The Mac
app should use it:

- In `apps/andon/tinyjs.json`, set `"chrome": { "frame": false, "windowControls": true,
  "windowControlsPos": { "x": 18, "y": 20 }, "vibrancy": "sidebar" }`, so it applies before first
  paint. Tune the position so the traffic lights are vertically centered in the 52px toolbar row,
  over the sidebar.
- Load the page as `http://127.0.0.1:8766/?shell=mac`. When `shell=mac` is present, the page:
  - leaves 78px at the top-left of the sidebar for the traffic lights (the sidebar's first row
    starts below them, as in the mock-up);
  - marks the toolbar and the sidebar's top strip `data-tiny-drag` so the window can be dragged,
    and double-clicking that strip zooms the window;
  - lets the sidebar's background be transparent so the native `sidebar` vibrancy shows through.
- **Check first:** `tinyjs.json` sets `"api": { "disable": ["*"] }`. Job A must confirm that
  `data-tiny-drag` works with the page API disabled. If it doesn't, enable the narrowest API that
  makes dragging work, say which one in `build.md`, and keep everything else disabled.
- **In a browser** (no `shell=mac`): no inset and no drag attributes, and the sidebar gets a solid
  background. The layout is otherwise identical.
- The `minSize` floor is 1100×700. In a browser narrower than 1100px, the board **scrolls
  sideways**: the six columns keep a 150px minimum, and the project gutter and the header row stay
  pinned.

## 5. Lanes (Job B)

There is one lane per registered project.

**Kinds of job.** Each job on the board has a kind, derived from its stage, its latest round, and
its project's `settleAfterHours`:

| kind | rule |
|---|---|
| needs-human | stage `needs-human`. It's the **merge failed** variant when `decision` is `APPROVE`; see below. |
| review-failed | stage `review`, the current round is complete, and any verdict is `CHANGES` |
| reviewing | stage `review`, otherwise |
| approve | stage `approve` |
| build | stage `build` (show "Rework → R2" when it's a second or later round) |
| spec | stage `spec` |
| claimed | stage `claimed` |
| merged | stage `merged`, merged within `settleAfterHours` |
| settled | stage `merged`, merged earlier |
| abandoned | stage `abandoned`: closed without merging (Job 0). It's never on the board; it's listed in Settled. |

**Why a job stopped.** Job 0 (022) added two snapshot fields: `stoppedBy` (`escalated` or
`merge-failed`) and `stoppedFrom` (the working stage the job left). Andon shows the merge-failed
variant from `stoppedBy`. A snapshot written before them lacks both keys, and readers treat a
missing key as `null` (`factory rebuild` derives them from the log). With `stoppedBy` null in
needs-human, Andon falls back to a rule that is exact for the common case:
`decision === 'APPROVE'` can only mean the approver approved and the merge failed. A job whose
`decision` is `APPROVE (human)` with no `stoppedBy` is shown with the tag "Approved · not merged".

**Columns.** A claimed job sits in Spec, as today. A needs-human job sits in **Andon**, and leaves
a dashed red ghost, "**040** stopped here → Andon" (or "merge broke here → Andon"), in the column
of the stage it was in when it escalated: `stoppedFrom`, or, when that is null, the last working
stage in `timing.stages` before `needs-human`. Clicking the ghost opens the job. Merged holds merged jobs only; settled jobs are
not on the board (see Settled).

**Lane order**, top to bottom:
1. non-idle before idle;
2. more needs-human jobs first;
3. then more review-failed jobs;
4. then more active jobs;
5. then registration order.

Order is computed on load. Afterward a lane moves only when its **tier** changes (gains or loses
a needs-human or review-failed job, or goes idle or active), and it moves with a 250ms slide. A
job finishing a stage never reshuffles lanes.

**Gutter**, three short lines:
- the project name with its status dot;
- "2 active · 11h 40m", the oldest claim among active jobs;
- "1 at Andon" in red, or "1 sent back" in orange, plus "· 1 settled" as an underlined link that
  opens Settled filtered to that project.

The name is a button that focuses the project.

**Idle lanes** (no job that isn't settled) collapse to one 28px row: the gray name, "Idle · last
merge 3d 12h ago" across the columns, and a "Settled 2" button on the right.

**Crowded cells and lane height.** Tokens stack vertically in a cell, newest first, with 4px
between them. A lane is as tall as its **fullest cell**, not its job count: four jobs in four
different stations need one token's height, and four jobs all in Build need four.
- **All Projects:** a cell shows at most **3 tokens**, then a "+N more" row that focuses the
  project. The lane grows to at most 3 tokens plus that row.
- **Focused project:** every active job is shown, and the lane grows to fit its fullest cell
  (section 7).

## 6. Tokens (Job B)

A token is a 6px-radius button, 2–3 lines tall, with a 3px state-colored bar on its left edge.

- **Line 1:** the job number in mono (`040`), then the title, both ellipsized.
- **Line 2:** a state tag, then reviewer verdict chips for the current round, then `R1/2`, then
  the time in stage, right-aligned and ticking.

| kind | edge, fill, border | line 2 tag | extra |
|---|---|---|---|
| needs-human | red bar, red-tinted fill, red border | ⚑ "Escalated", red | line 3: the note, ellipsized, light red |
| merge failed | as needs-human, with a diagonal red hatch | "Merge failed", red | line 3: the note |
| review-failed | orange bar, orange-tinted fill, orange border | "Changes", orange | |
| reviewing | purple bar | none | pending chips pulse |
| approve | **solid blue fill**, white text | none | a ✓ badge at top right |
| build | indigo bar | "Building" (or "Rework → R2") | an indeterminate 2px progress line on the bottom edge |
| spec | teal bar, faint diagonal hatch | "Drafting spec", teal | |
| claimed | dashed gray border, no fill | "Claimed", italic | the title is the id until the spec names it |
| merged | green border, green-tinted fill | "✓ 3c9e01a" (short sha), green | "1h 4m ago" instead of the time in stage |

**Verdict chips** are 14px mono, with two-letter abbreviations in the project's reviewer order
(`security` se, `contract` ct, `code` cd, `ui` ui, `ux` ux; otherwise the first two letters).
Pass is a solid color, CHANGES is solid orange, and pending is an outline. State is never shown
by color alone: every kind has a distinct tag, edge, or shape too.

**Hover.** After 350ms, a popover shows the title, project · id, stage, time in stage, round,
each round's verdicts, and the note. Click opens the inspector, and the selected token gets a
2px focus ring in the accent color.

**Motion.** When a job changes column, its token slides from the old cell to the new one in
250ms, then gets a brief highlight (today's `fresh` and `moved` sets). New jobs fade in. All
motion is disabled under `prefers-reduced-motion`.

## 7. Project focus (Job B)

Selecting a project (in the sidebar, by clicking its gutter name, or with `#project=`) shows only
that lane, taller, with **no cap**: every active job is shown, and the lane grows to fit its
fullest cell.
- tokens show full titles (wrapping to 2 lines) and the branch;
- Merged also lists that project's settled jobs, dimmed;
- below the lane is a **Recent activity** list of the last 14 events: time, job number, what
  happened ("R2 ui: PASS", "entered review", "merged 3c9e01a"), and how long ago. Each one opens
  its job.

The toolbar title becomes the project name, and a "‹" back button returns to All Projects.
"N waiting elsewhere" shows in the subtitle when other projects need you.

## 8. Inspector (Job C)

It replaces the drawer. From top to bottom:

1. **Bar** (52px): "minerva / 040-tag-migration" and a close button.
2. **Header**: project · id with a stage pill ("NEEDS A HUMAN" in red, etc.); the title (17px
   semibold); `branch → target` in mono; and the timing summary line ("6:06:06 in needs-human ·
   claimed 8h 40m ago · round 1/2", today's `summary()`).
3. **Needs-human box** (only for needs-human jobs): a red-tinted rounded box with the note, then
   **Approve** (accent button) and **Rework…** (plain button), then the command in mono with a
   copy button.
   - Approve shows `/factory approve <id>`.
   - Rework… opens a **sheet** with a note field; the command line updates as you type
     (`/factory rework <id> "<note>"`), and the sheet has Copy and Cancel.
   - **Abandon…** (a destructive-style plain button, after Rework…) opens a sheet with a required
     reason field and the command `/factory abandon <id> "<reason>"` (Job 0).
   - Copying shows a HUD toast, "Copied /factory …", for 1.6s.
   - **Andon never runs these itself.** In the Mac app, when T3 Code is installed, it can also hand
     one to T3 Code: as an unsent draft in a new thread (the default), or, if chosen in Settings,
     sent to a new thread right away. Andon still writes no job state; the factory CLI does.
4. **Files**, grouped as today's `groupsOf()` does:
   - **Job**: timing, feature.md (and the brief), spec.md, build.md, decision.md, in that order.
   - **Round N**: one row per reviewer ("security review"), with a green or orange verdict dot;
     the latest round is marked "current".
   - The default file is today's `pickFile()`, and the selected row has the accent fill.
5. **Document**: the markdown, rendered with today's `markdown()`, in system type. The first line
   (`VERDICT: …`, `APPROVE`, or `ESCALATE`) renders as a colored pill. **Timing** is today's
   `TimingView`, restyled: the stage bar, its legend, the Stages table, and the Agents table.

The docs reload when the job's `updated` changes (as today). ↑ and ↓ move between files.

## 9. Settled (Job C)

**Settled** in the toolbar, or a lane's "N settled" link, opens a **sheet**: "Settled · merged
more than 24h ago". It holds:
- an optional project filter chip, removable;
- rows, newest first: title, project · id, merged date, total time, and rounds. Abandoned jobs
  are listed too, by the date they were closed, with a gray "Abandoned" tag and their reason
  instead of a sha.

A row opens the job in the inspector and closes the sheet. This replaces `SettledDialog`.

## 10. Search, Needs Me, keyboard, deep links (Job D)

**Search** matches id, title, and project name, case-insensitively. Non-matching tokens and
lanes dim to 25%; matches keep full contrast. Escape clears the field, then leaves it.

**Needs Me** shows only work that a human has to look at, and hides lanes with none:
- every needs-human job that hasn't been addressed, which means it hasn't been reworked, merged,
  or abandoned. That includes "Approved · not merged".
- review-failed jobs, so you can see what was sent back. These don't need you, but they're worth
  a look.

A job that has waited on the approver a long time is not included: no human is needed.

**Keyboard:**

| key | action |
|---|---|
| `/` | focus search |
| Esc | close the topmost layer: sheet, then inspector, then search. Works from inside a field. |
| ↑ / ↓ | previous or next file in the inspector |
| `g` `a` | All Projects |
| `n` | toggle Needs Me |
| `?` | shortcut sheet |

Closing a layer returns focus to what opened it.

**Deep links.** The URL hash holds the view, so a reload or a shared link restores it:
- `#project=<id>`
- `#job=<project>/<job id>&file=<path|timing>`
- `#settled` or `#settled=<project>`
- `#needs`
- combinations, joined with `&`

Opening the inspector or a sheet **pushes** a history entry, so Back closes it; file changes
**replace** the entry. This fixes the mock-up's rough edge. The Mac app's `?shell=mac` lives in the
query, not the hash.

## 11. Visual tokens (Job A)

The app follows the system appearance (`prefers-color-scheme`). Dark is the primary design.

| token | dark | light |
|---|---|---|
| `--win` (toolbar, status bar, inspector) | `#1e1e20` | `#f6f6f6` |
| `--canvas` (board) | `#19191b` | `#ffffff` |
| `--raised` (sheets, popovers) | `#2a2a2d` | `#ffffff` with a shadow |
| `--label` / `2` / `3` / `4` | white at .88 / .55 / .30 / .16 | black at .85 / .50 / .26 / .10 |
| `--sep` / `--sep2` (hairlines, .5px) | white at .09 / .14 | black at .10 / .16 |
| `--ctl` / `--ctl-h` (control fill, hover) | white at .08 / .12 | black at .05 / .08 |
| accent (`--blue`) | `#0a84ff` | `#007aff` |
| needs-human (`--red`) | `#ff453a` | `#ff3b30` |
| review failed (`--orange`) | `#ff9f0a` | `#ff9500` |
| merged (`--green`) | `#30d158` | `#34c759` |
| spec (`--teal`) | `#40cbe0` | `#30b0c7` |
| build (`--indigo`) | `#6e6cf0` | `#5856d6` |
| review (`--purple`) | `#bf5af2` | `#af52de` |
| claimed, idle (`--gray`) | `#98989d` | `#8e8e93` |

- **Type:** `-apple-system, BlinkMacSystemFont, "SF Pro Text"`. Sizes: 13px base, 17px for the
  inspector title, 12–12.5px for controls, 11px for meta, 10.5px for token line 2. Ids, shas,
  commands, and times use `ui-monospace, "SF Mono"`, with tabular numbers for every count and
  timer.
- **Radii:** 6px for tokens, rows, and buttons; 7px for fields and segmented controls; 10px for
  sheets and popovers.
- **Focus:** a 2px accent ring, offset 1px.
- **Contrast:** every text color meets WCAG AA on its background in both appearances, and the
  light tints of the state fills are adjusted until they do.

This replaces the vendored paper palette in `app.css`. The serif type, the dot-grid background,
and the amber andon stripes go away.

## 12. Code plan

**Keep as they are** (they're the model, and they're tested):
- `job.ts`, `state.ts`, `live.ts`, `api.ts`, `docs.ts`, `timing.ts`, `time.ts`, `markdown.ts`;
- the selection and needs-human logic in `projects.ts`;
- the `movement` and settle logic in `board.ts`.

**New pure modules** (each with colocated `*.test.ts`):
- `lanes.ts`: the lane model. It takes board jobs and `now`, and returns lanes (project, tier,
  idle, gutter meta, cells per column, ghosts, "+N more"). It covers the kinds table, lane order
  and tier changes, and the stopped-here column.
- `route.ts`: parses and formats the hash (section 10), round-tripping every form.
- `keys.ts`: the key-to-action map and the `g a` sequence, as a pure reducer.

**Components, rewritten:**

| today | becomes |
|---|---|
| `App.svelte` | a frame with sidebar, toolbar, board, inspector, status bar |
| `Header.svelte` | `Sidebar.svelte`, `Toolbar.svelte`, `StatusBar.svelte` |
| `Board.svelte` | `Lines.svelte` (the matrix) and `Lane.svelte` |
| `Card.svelte` | `Token.svelte` and `TokenPopover.svelte` |
| `Drawer.svelte` | `Inspector.svelte` (reusing `TimingView.svelte`) and `ReworkSheet.svelte` |
| `SettledDialog.svelte` | `SettledSheet.svelte` |

Old components are deleted in the job that replaces them.

**Mac app:** `tinyjs.json` (chrome, minSize, the `?shell=mac` URL); nothing else changes.

**Contract:** none in jobs A–D, which only read what the service serves. The two additions they
use (why a job stopped, and `abandoned`) come from Job 0.

## 13. Jobs

Job 0 changes the contract; jobs A–D build the UI. Each leaves Andon working and passes the gate
(`bun run test && bun run check`).

**Order:** 0, then `factory upgrade` this repo and each registered project (so their CLIs write
the new fields), then A, B, C, D. A doesn't depend on Job 0, so it can go first if Job 0 is still
in exploration.

- **0. `needs-human-exits`** (contract; done: job 022). Every change here is
  additive within v1, and is reviewed by `factory-contract` with `docs/contract/v1.md` updated in
  the same diff.
  - **Why it stopped:** snapshot fields `stoppedBy` (`escalated` | `merge-failed`) and
    `stoppedFrom` (the stage it stopped from). *Done: job 022.*
  - **Abandon:** a new `job.abandoned` event (`reason`), leading to a new terminal stage
    `abandoned`. It sets `endedAt`, and `note` becomes the reason. Like `merged`, the terminal
    stage rejects every later event.
  - **Where it's allowed:** from `needs-human`, freely. From a working stage (spec, build, review,
    approve) only with `--force`, as the way out of a stuck job. Abandon never stops agents: you
    stop the session driving the job first, then abandon. The CLI can't tell whether a session
    is still running (the lock is short and global), so `--force` is the user's word that it
    isn't. If one is, its next event is rejected because the stage is terminal, and it stops.
  - **CLI:** `factory abandon <id> "<reason>" [--force] [--delete-branch]` logs the event, removes
    the worktree, and keeps the branch unless `--delete-branch` is given. It lives in the CLI, not
    only the skill, so a terminal, a script, or (later) the Andon service can run it without an AI
    session. With no flag it keeps the branch: deleting unmerged commits is the step that can't
    be undone, so it must be asked for explicitly.
  - **Skill:** `/factory abandon <id> <reason>` asks two questions before calling the CLI: confirm
    the abandon (and, from a working stage, that its session is stopped), then keep or delete the
    branch, defaulting to keep.
  - **Readers:** the Andon service and the UI treat `abandoned` as settled.


- **A. `andon-mac-frame`** (sections 3, 4, 11; done: job 023): the frame (sidebar, toolbar, status bar, empty
  inspector slot), the visual tokens with light and dark, the project sidebar replacing the
  switcher, the connection footer, and the Mac app chrome (`frame: false`, traffic-light position,
  vibrancy, drag regions, `?shell=mac`). Today's board renders inside the new frame unchanged.
  *Accept:* the sidebar shows every project with correct badges and dots; selection persists; the
  Mac app window has native traffic lights over the sidebar and drags by the toolbar; the browser
  shows the same app without the inset; both appearances meet AA.
- **B. `andon-assembly-lines`** (sections 5, 6, 7): `lanes.ts` with tests, plus the matrix, the
  tokens, the hover popover, idle lanes, ghosts, crowded cells, project focus with recent
  activity, and the move animation. It deletes `Board.svelte` and `Card.svelte`.
  *Accept:* each kind renders as specified; lane order and tier changes match section 5; 12
  projects and 30 jobs fit at 1440×900.
- **C. `andon-inspector`** (sections 8, 9): the inspector (push layout, resizable, auto-hiding the
  sidebar), files, the document, timing, the needs-human box with copy-only commands and the
  Rework sheet, and the Settled sheet. It deletes `Drawer.svelte` and `SettledDialog.svelte`.
  *Accept:* every file group and verdict from today's drawer is present; nothing in Andon writes
  job state.
- **D. `andon-find-and-keys`** (section 10): search, Needs Me, the keyboard map, the shortcut
  sheet, and deep links with history. It adds `route.ts` and `keys.ts` with tests.
  *Accept:* every hash form restores its view after a reload; Esc closes layers in order, even
  from a field; Back closes the inspector.

## 14. Out of scope

- The Ledger as a weekly, monthly, or project **report**. It's a later design (mock-up 03).
- Running approve, rework, or abandon from Andon (a later exploration; see section 15).
- The mock-up's Replay demo, and its fake menu bar and traffic lights.
- Multi-machine Andon.

## 15. Decisions (2026-10-26)

- **Crowded cells:** cap at 3 plus "+N more" in All Projects; a focused project shows every job.
  Lane height follows the fullest cell (section 5).
- **Narrow windows:** below 1100px, the board scrolls sideways (section 4).
- **Needs Me:** every unaddressed needs-human job, plus review-failed (section 10).
- **Why a job stopped, and abandon:** both are contract additions in Job 0, done before the UI's
  B and C jobs.
- **Abandoning a running job:** not directly. Stop its session first; then abandon works from
  any stage with `--force`, which covers stuck jobs (section 13).
- **The branch on abandon:** the skill asks (default keep); the CLI keeps it unless
  `--delete-branch` is given.
- **Interactive Andon, later:** a separate exploration, not part of this rollout. The direction
  is two levels, with no durable runner until one is clearly needed:
  1. The Andon service runs the project's installed `factory` CLI for actions that need no AI
     (approve, abandon), behind a per-service token and an Origin check. The CLI stays the only
     writer of job state.
  2. An inbox for actions that need an AI session (rework, a message to a job): Andon records the
     request through the service, and the `/factory` session or a resumed builder picks it up at
     its next checkpoint.

  Multi-machine follows decision 10 (`docs/decisions.md`): each machine's service owns its projects, and Andon sends
  each action to the owning service (over Tailscale or an SSH tunnel), with no central server.
