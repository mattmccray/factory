# The Andon UI shows the backlog and explorations

- Status: ready
- Sources: the explore request of 2026-10-29 (pre-1.0 notes: "Surface backlog/epics in Andon (read-only is fine at first)"); `docs/contract/v1.md` "Andon service"; briefs `andon-epics-service`, `andon-epics-ui`, `settled-on-demand-ui`; epic `factory/epics/andon-backlog.md`
- Date: 2026-10-30

## Intent
Matt sees what's coming in each project, not only what's running: a Backlog sheet with the
queued lines in the order `/factory next` takes them and the briefs and plans still being
explored, each opening to its brief or plan. Read-only; it's what `t3-start-work` will act on.

## Decisions
1. What does Andon show? → **Per project, two groups. Queued: the open backlog lines (`- [ ]`),
   in file order, each with its title and done-text, its kind (brief, epic with its member
   count, or free text), and any earlier abandoned attempts; opening one shows its brief or plan,
   rendered as the inspector renders job files. In exploration: draft briefs and draft plans.
   Not shown: ticked lines (already on the board as running jobs and epics) and done briefs
   (their jobs are in Settled).** Why: both groups are what Matt would start work from; nothing
   is shown twice.
2. Where does it live in the UI? → **A Backlog sheet, built like the Settled sheet: projects
   with their Queued and In exploration groups. It opens from a quiet "N queued" link in each
   lane's gutter beside "N settled" (filtered to that project), from the toolbar, and from View →
   "Show Backlog…" (⇧⌘B), added beside "Show Settled…" (brief `andon-view-menu` builds that
   menu; whichever job runs second takes the other's menu file as it finds it). Opening an item
   shows its brief or plan in the inspector, with deep links `#brief=<pid>/<slug>` and
   `#plan=<pid>/<slug>`; an epic's page lists its members and their brief statuses. Search also
   finds queued and exploring items by title.** Why: the board stays about work in motion; ghost
   tokens for queued work were ruled out in brief `andon-epics-ui`.

## Facts (2026-10-30)
- The data comes from brief `andon-backlog-service`: the narrow board's `backlog` counts, `GET
  /projects/<pid>/backlog`, `GET …/briefs/<slug>`, `GET …/plans/<slug>`, and the `backlog`
  event.
- The Settled sheet (`apps/andon-ui/src/SettledSheet.svelte`) and the inspector's job and epic
  pages set the patterns to follow.

## Scope
- In: `apps/andon-ui`: the Backlog sheet (fetched when it opens, re-fetched on `backlog`), the
  gutter's "N queued" link, the toolbar entry, the brief and plan inspector pages (markdown
  rendered as job files are), deep links `#brief=` and `#plan=`, search over queued and
  exploring titles, light and dark; `apps/andon`: View → "Show Backlog…" (⇧⌘B) beside "Show
  Settled…", pushing an event the page acts on (no new backend method); tests for all of it.
- Out: the service and contract (brief `andon-backlog-service`); any write to the backlog,
  briefs, or plans; starting work or copying commands (brief `t3-start-work`); ghost tokens on
  the board.

## Acceptance sketch
- The Backlog sheet lists each project's Queued lines in backlog order (title, done-text, kind,
  member count for an epic, abandoned attempts) and its In exploration drafts; a project's
  "N queued" gutter link opens it filtered to that project.
- Opening an item shows its brief or plan in the inspector; `#brief=<pid>/<slug>` and
  `#plan=<pid>/<slug>` open those pages directly; an epic's page lists its members and their
  brief statuses.
- Editing the backlog while the sheet is open updates it; the counts follow the board.
- Search finds queued and exploring items by title and opens their pages.
- In the Mac app, View → Show Backlog… (⇧⌘B) opens the sheet.
- Nothing on the board changes besides the gutter link.

## Contract calls
None (the service's contract change is brief `andon-backlog-service`'s).

## Open
None.
