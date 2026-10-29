# The Andon UI shows epics

- Status: ready
- Sources: docs/design/epics/design.md (decision 9; brief 5 of 5) and its mock-ups
  (`epics-overview.html`, `overview.png`, `panels.png`, `panel-board.html`,
  `panel-inspector.html`); factory/briefs/andon-epics-service.md (the payloads) and epic-cli.md
  (`epic.json`, `waitingOn`); factory/briefs/epic-skill.md decision 1 (`/factory epic <slug>`);
  `/factory explore` on 2026-10-29; docs/design/andon-overview/design.md (§3, §5, §7–§10);
  factory/briefs/compact-merged-tokens.md; apps/andon-ui/src (lanes.ts, Token.svelte, Lane.svelte,
  Inspector.svelte, SettledSheet.svelte, App.svelte, route.ts, live.ts, state.ts); apps/andon
- Date: 2026-10-29

## Intent
Andon draws a running epic the way the accepted mock-ups do: a sub-lane under its project lane with
the epic's members moving through the stations, a gutter that says how the epic is doing and what
it waits on, "in epic" marks on members merged into the epic branch, and an epic page in the
inspector. Matt sees an epic's progress at a glance instead of one stuck card, and epic-level
trouble counts like any other.

## Decisions
1. How do sub-lanes behave with the board's existing rules? → **Each rule extends an existing
   one.** A sub-lane sits directly under its project lane and never moves on its own; several epics
   in one project are ordered by start time, oldest first. A project's tier (needs-human,
   review-failed, active, idle) counts its epics' jobs and epic-level waiting, so trouble inside an
   epic sorts its project up. **Needs Me** shows a sub-lane whose epic has a member in
   `needs-human` or `waitingOn: "you"`, with its project lane kept as a collapsed one-line header
   when only the sub-lane qualifies. **Focus** shows all of a project's sub-lanes, expanded.
   "At most 3 tokens, then +N more" applies per cell in sub-lanes too (+N more focuses the
   project). The **sidebar** stays one row per project: an epic-level wait adds to its red badge
   and epic jobs to its active count. A project with only a waiting epic isn't idle. Why: trouble
   first holds wherever the trouble is, and nothing becomes a new mode.
2. The remaining surfaces? → **Each existing job surface gains epics.** The **Settled sheet** lists
   landed and abandoned epics (fetched on demand like settled jobs) as one row each with title,
   outcome, landing sha, and member count, their member jobs grouped under that row rather than
   loose; opening it opens the epic page. **Search** matches epic titles and slugs (a hit opens the
   epic page), and a member job's result shows its epic. **Deep links:** `#epic=<pid>/<slug>`
   opens an epic page, and a member job's page links back to its epic. The **Mac app's** tray
   badge adds epic-level waits (`waitingOn: "you"`) to the needs-human count, matching the sidebar;
   it notifies **"Epic landed"** (title and member count) and **"Epic waiting on you"** (the
   reason); members merging into the epic branch don't notify (a member escalating still does). The
   epic page copies `/factory epic <slug>`, and an Abandon… sheet copies
   `/factory epic abandon <slug> "<reason>"`. Why: every surface already exists for jobs; and
   notifications fire only for what changes Matt's target or needs him, so a big epic doesn't
   produce a burst of noise.

## Scope
- In: `apps/andon-ui` (consuming `epics` from the board and `board` events and `/settled`; the
  sub-lane, its gutter, and its ordering; the "in epic" token mark and legend entry; sync/fix
  tags; the epic inspector page and its docs from the epic docs endpoint; Needs Me, focus,
  crowding, the sidebar counts, the Settled sheet, search, deep links, the copied commands) and
  `apps/andon` (tray badge and the two notifications); tests for all of it, following the
  mock-ups in docs/design/epics/ and the compact merged token (job 038).
- Out: the service and contract (brief 4 and earlier); Andon running any command (it copies
  commands, as today); per-epic sidebar rows; ghost tokens for queued or blocked members; a
  "Conflict → R2" label; contract code in the Mac app (decision 10).

## Acceptance sketch
- A project with a running epic shows a sub-lane directly under its lane, in the mock-up's style
  (indented gutter, elbow connector, faint tint), holding only that epic's jobs, with `sync`/`fix`
  tags on generated ones; several epics order by start time.
- The gutter shows the name and status dot, "N/M merged · K running · <time>", and what's waiting
  ("1 blocked on <id> · 1 queued", "Landing…", or in red "Waiting on you: <reason>" when
  `waitingOn` is `"you"`).
- Members merged into the epic branch render as compact one-line merged tokens with a dashed green
  edge and a branch-merge icon whose tooltip and label read "Merged into `factory/epic/<slug>` ·
  lands on `<target>` with the epic"; the legend shows the icon. Queued and blocked members never
  render as tokens.
- Clicking the epic name opens the epic page: state pill, `factory/epic/<slug> → <target>`,
  timing, a progress bar by member state, Members in plan order (edges, state, job link), a
  Generated group, the plan and member briefs as documents, and for `waitingOn: "you"` a red box
  with the reason and `/factory epic <slug>` to copy; a member job's page links to its epic.
- Trouble first: an escalated member counts once, as any job; an epic with `waitingOn: "you"`
  adds one to the sidebar, toolbar, Needs Me, and tray badge counts and turns its gutter red; a
  project's tier includes its epics.
- Needs Me, focus, the per-cell cap, and idle handling behave as decision 1 says.
- The Settled sheet lists settled epics with their members grouped; search finds epics;
  `#epic=<pid>/<slug>` opens an epic page.
- The Mac app notifies "Epic landed" and "Epic waiting on you", and not on member merges into
  the epic branch.
- A project with no epics looks and behaves exactly as today.

## Contract calls
None. This brief consumes the contract surface approved in `epic-cli` and `andon-epics-service`.

## Open
None.
