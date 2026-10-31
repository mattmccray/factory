# Machines in the Mac app

- Status: done
- Job: 081-andon-machines-mac (merged 3b5bffc via epic andon-multi-machine, 2026-10-30)
- Sources: the explore request of 2026-10-30; epic plan `factory/epics/andon-multi-machine.md`; briefs `andon-hub`, `andon-machines-ui`, `t3-handoff`, `t3-start-work`, `job-context-menu`, `project-context-menu`, `epic-context-menu`; `apps/andon/src/follow.ts`, `badge.ts`, `notify.ts`, `projectmenu.ts`, `jobmenu.ts`, `epicmenu.ts`, `handoff.ts`, `startwork.ts`
- Date: 2026-10-30

## Intent
The Mac app's tray badge and notifications cover every machine's jobs, and its native actions do
the right thing for a project on another machine: open its threads in T3 Code where they live,
copy what can't run here, and never act on a path that isn't on this Mac.

## Facts (2026-10-30)
- The Mac app follows the local service's `/events` itself (`follow.ts`); with the hub (brief
  `andon-hub`), remote projects (`<pid>@<machine>`, with `machine` and the remote `root`) arrive
  there with no change.
- The badge counts needs-human jobs plus epics waiting on you across every listed project
  (`badge.ts`). Notifications fire on transitions into needs-human or merged (jobs) and landed or
  waiting on you (epics); a project's first board after start or reconnect is a silent baseline
  (`notify.ts`).
- Each T3 Code server has an environment id (Rocinante: `31b71739-…`). A job records
  `session=t3code:<environmentId>/<threadId>` from the T3 Code thread that orchestrated it, and
  Open in T3 Code opens `t3code://threads/<environmentId>/<threadId>`, which opens a thread in any
  environment T3 Code on this Mac is connected to. agentbox is already a T3 Code connection here
  (no projects yet).
- Send runs `t3 thread start … <project root> <command>` (no environment flag; the local server
  only); draft opens `t3code://new?prompt=…&repo=<owner/name>`, whose choice of environment is
  unverified. Project → Open in ▸ T3 Code runs `t3 app <root>`.

## Decisions
1. Badge and notifications → **The badge counts every machine, a down one included (its last known
   needs-human jobs still count). Remote notifications name the machine ("factory · studio: needs a
   human"), with the same rules. A peer that comes back after being down notifies the real
   transitions that happened meanwhile; a peer first seen is a silent baseline, as a project is.
   A machine going down or coming back never notifies.** Why: the hub's "never vanish" rule; the
   transitions are real; machines sleeping or dropping Wi-Fi would be noise, and the sidebar
   heading shows it.
2. Native menus and hand-offs for a remote project → **Project menu: New Exploration… and Run Next
   run the page's flow, and the start comes back copy-only (the `/factory …` command copied; the
   page's toast names the machine); Copy Project Path copies the remote path; Reveal in Finder and
   Open in ▸ VS Code, T3 Code, Ghostty are grayed out, "Open in" noting the machine ("on studio").
   Job and epic menus: Open in T3 Code opens the recorded `t3code://threads/<environmentId>/<threadId>`
   exactly as for a local job; Copy Job ID and Copy Epic Name unchanged. The inspector's hand-offs
   (approve, rework, abandon) and Start Work, in draft or send mode, come back copy-only for a
   remote project (the existing `copy-only` outcome). The Mac app never spawns or opens anything
   with a remote project's `root`; a test pins it.** Why: reading and opening a thread by its
   environment id work across machines today; starting anything needs a verified way to target
   the other environment (later member `andon-remote-handoff`); grayed items keep the menus the same
   shape for local and remote projects.

## Defaults (not questioned; the spec-writer may refine)
- A project is remote when its `machine` isn't the hub's own (from `/machines`, or the id's
  `@<machine>` suffix), never guessed from its `root`.
- The tray tooltip and menu keep their shape; a remote job's notification click shows the main
  window as a local one's does.

## Scope
- In: `apps/andon` (the badge and notifications across machines with the machine named, the
  project, job, and epic menus and the hand-off and start-work outcomes for remote projects, and the
  never-spawn-a-remote-root guard), with tests (runtime-neutral, as today; the boundary test still
  keeps contract code out of the Mac app).
- Out: the service (brief `andon-hub`); the UI (brief `andon-machines-ui`); starting threads in a
  remote environment (a later member, `andon-remote-handoff`).

## Acceptance sketch
- With Studio followed, the tray badge counts Studio's needs-human jobs and waiting epics with the
  local ones, and still counts them while Studio is down.
- A Studio job escalating notifies "<project> · studio: needs a human"; Studio going down or coming
  back notifies nothing; a job that escalated on Studio while it was unreachable notifies once it's
  back.
- A remote project's right-click menu has New Exploration…, Run Next, and Copy Project Path working
  (starts copy-only), and Reveal in Finder and Open in ▸ grayed with the machine noted.
- A remote job's Open in T3 Code opens its recorded thread link; with no recorded session it's
  grayed as for a local job.
- A remote job's approve, rework, or abandon hand-off, and a remote Start Work, copy the command and
  return `copy-only`, in every hand-off mode; nothing is spawned with the remote root.
- Local projects behave exactly as before.

## Contract calls
None.

## Open
None.
