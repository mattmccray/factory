# Machines in the Andon UI

- Status: done
- Job: 080-andon-machines-ui (merged 33531dc via epic andon-multi-machine, 2026-10-30)
- Sources: the explore request of 2026-10-30; epic plan `factory/epics/andon-multi-machine.md`; briefs `andon-hub`, `andon-peer-access`; decision 5 and `docs/design/andon-overview/design.md` (§3–§7); `apps/andon-ui/src/sidebar.ts`, `lanes.ts`, `live.ts`
- Date: 2026-10-30

## Intent
The board shows every machine's projects in one place, with trouble first whatever machine it's
on, and makes it plain which machine each lane is on and whether that machine is reachable.

## Facts (2026-10-30)
- The design (decision 5, binding) has a sidebar of Overview, then Projects sorted by name, then a
  footer line ("Connected · 12 projects"), and lanes in trouble-first tiers across all projects.
- The hub (brief `andon-hub`) gives each project `machine`, serves remote projects as
  `<pid>@<machine>` on the usual routes, keeps a down machine's last boards listed, and adds
  `GET /machines` and a `machines` event (`{ name, url, state, since, reason, release }`).
- The UI fetches with relative paths, so it works unchanged when loaded from a tailnet address.
- Native actions (Open in…, hand-off, Start Work, the right-click menus) are the Mac app's; the UI
  asks for them.

## Decisions
1. How do machines appear? → **Sidebar: under Projects, one heading per machine, the local machine
   first, then peers by name; a heading shows the machine's state (nothing when `live`, a gray
   "connecting…", a red "down since 14:02" or "needs upgrade"); its projects sorted by name under
   it. With no peers, no headings: as today. Board: lanes stay one list in trouble-first tier order
   across every machine, never split by machine; a remote lane's gutter adds its machine under the
   project name ("factory · studio"); a down machine's lanes are dimmed with "as of 14:02". Footer:
   "Connected · 3 machines · 12 projects", plus e.g. "studio down".** Why: trouble first is the
   design's core promise, so a needs-human job on Studio must rise to the top; the sidebar headings
   carry machine health without breaking that. The design doc gains a "Machines" section to match.
2. What do a remote project's actions do? → **Reading works as for a local project (the inspector,
   its docs and timing, the Settled and Backlog sheets). The hand-off, Start Work, Run Next, and New
   Exploration controls stay for remote projects, and the page asks the Mac app with the project's
   id as today; the Mac app decides what each does (brief `andon-machines-mac`: Open in T3 Code
   through the job's recorded environment; draft, send, and start copy-only for now). The page shows
   whatever outcome comes back, including a copy-only toast that names the machine ("Copied. Run it
   on studio"). In a plain browser they stay copy-only, as today.** Why: Matt starts sessions for
   every machine from Rocinante's T3 Code, which connects to their environments; starting a thread
   in a remote environment waits on a verified T3 Code entry point (a later member,
   `andon-remote-handoff`, once agentbox has a project to test against), and keeping the controls
   means that member changes only the Mac app.

## Defaults (not questioned; the spec-writer may refine)
- A down machine's lanes freeze their live timers at the machine's last-seen time ("as of 14:02")
  rather than counting on with data that may be stale.
- Machine headings aren't selectable; All Projects, the toolbar's counts, and Needs Me cover every
  machine.
- Two projects with the same name on different machines are told apart by the machine wherever the
  name appears (sidebar under its heading, lane gutter, inspector header, search results).

## Scope
- In: `apps/andon-ui` (reading `machine` and `/machines` and its event, the sidebar headings, the
  lane gutter's machine and stale state, the footer, the inspector header, the copy-only toast
  naming the machine), `docs/design/andon-overview/design.md` (the "Machines" section), and tests.
- Out: the service (brief `andon-hub`); the Mac app (brief `andon-machines-mac`); a tablet layout.

## Acceptance sketch
- With no peers, the sidebar, board, and footer look exactly as today.
- With Studio and agentbox followed, the sidebar shows a heading per machine (Rocinante first) with
  its projects under it; a needs-human job on Studio sits in the top tier with the local ones, its
  gutter reading "<project> · studio".
- Stopping a peer's service turns its heading "down since <time>", dims its lanes with "as of
  <time>", freezes their timers, and shows it in the footer; restarting brings it back live.
- A peer needing an upgrade shows "needs upgrade" on its heading.
- A remote job's inspector shows its docs and timing; its hand-off shows the outcome the Mac app
  returns, including "Copied. Run it on studio".
- The UI loaded in a browser from another machine's tailnet address works the same, copy-only.

## Contract calls
- "The accepted Andon design (decision 5) gains a 'Machines' section: machine headings in the
  sidebar, one trouble-first board across machines with the machine in a remote lane's gutter, the
  down and stale states, and the footer's machine count", approved by Matt on 2026-10-30. The job
  updates `docs/design/andon-overview/design.md`.

## Open
None.
