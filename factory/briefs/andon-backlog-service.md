# The Andon service serves the backlog and explorations

- Status: ready
- Sources: the explore request of 2026-10-29 (pre-1.0 notes: "Surface backlog/epics in Andon (read-only is fine at first)"); `docs/contract/v1.md` "Andon service"; briefs `andon-epics-service`, `andon-epics-ui`, `settled-on-demand-ui`; epic `factory/epics/andon-backlog.md`
- Date: 2026-10-30

## Intent
The Andon service reads each project's backlog, briefs, and plans and serves them, read-only:
counts with the board, the queued and in-exploration lists on demand, a brief's or plan's text,
and a live `backlog` event. It's what the Backlog sheet (brief `andon-backlog-ui`) shows.

## Decisions
1. What does Andon show? → **Per project, two groups. Queued: the open backlog lines (`- [ ]`),
   in file order, each with its title and done-text, its kind (brief, epic with its member
   count, or free text), and any earlier abandoned attempts; opening one shows its brief or plan,
   rendered as the inspector renders job files. In exploration: draft briefs and draft plans.
   Not shown: ticked lines (already on the board as running jobs and epics) and done briefs
   (their jobs are in Settled).** Why: both groups are what Matt would start work from; nothing
   is shown twice.
2. The service side? → **Counts with the board, lists on demand, as settled jobs work. The
   narrow board (`?settled=summary`) gains `backlog: { queued, exploring }`. `GET
   /projects/<pid>/backlog` returns `{ queued, exploring }`, each item with its kind, slug, title,
   done-text, status, member count (an epic), and abandoned attempts, fetched when the sheet
   opens. `GET /projects/<pid>/briefs/<slug>` and `GET /projects/<pid>/plans/<slug>` return the
   file's text, as the docs endpoints do. The service watches `backlog.md`, `briefs/`, and
   `epics/` and sends a `backlog` event (the sheet re-fetches; counts ride the board). It reads
   only those fixed paths; slugs must match `^[a-z0-9]+(-[a-z0-9]+)*$`; the `Host` check applies;
   parsing is tolerant (a malformed line or brief shows as free text, never an error); it writes
   nothing.** Why: the existing on-demand pattern keeps the board light; the slug rule keeps a
   request inside the folder.


## Facts (2026-10-30)
- `factory/backlog.md`, `factory/briefs/*.md`, and `factory/epics/*.md` are tracked in git; the
  service reads none of them today. Running jobs and epics are already on the board.
- The service's endpoints are part of the contract (`docs/contract/v1.md` "Andon service"), so a
  new endpoint or event is an additive contract change.

## Scope
- In: `packages/andon-service`: a tolerant parser for `backlog.md` lines (open, ticked, brief,
  epic, free text) and for briefs' and plans' title, `Status:`, `- Abandoned:` lines, and
  members, in a pure `bun:test`-covered module; the narrow board's `backlog` counts; the three
  endpoints; watching the three paths and the `backlog` event; slug validation; tests including
  path-escape attempts. `docs/contract/v1.md` "Andon service" updated as the contract call says.
- Out: the UI (brief `andon-backlog-ui`); any write to the backlog, briefs, or plans; starting
  work (brief `t3-start-work`); the archive branch's copies of plans.

## Acceptance sketch
- In a project with open, ticked, brief, epic, and free-text backlog lines, plus draft, ready,
  and done briefs and draft and ready plans, `GET /projects/<pid>/backlog` returns the open lines
  in file order as `queued` (with kind, slug, title, done-text, status, member count for an epic,
  and abandoned attempts) and the draft briefs and plans as `exploring`; ticked lines and done
  briefs are absent.
- The narrow board carries matching `backlog` counts.
- `GET …/briefs/<slug>` and `…/plans/<slug>` return the file's text; a bad slug (`..`, `/`,
  uppercase, empty) is refused with 4xx and reads nothing; a missing file is 404.
- Editing `backlog.md`, a brief, or a plan sends one `backlog` event (debounced) and updates the
  counts.
- A malformed backlog line or brief appears as free text; nothing errors.
- The service writes nothing.

## Contract calls
"`docs/contract/v1.md` "Andon service" gains the narrow board's `backlog` counts, `GET
/projects/<pid>/backlog`, `GET /projects/<pid>/briefs/<slug>`, `GET /projects/<pid>/plans/<slug>`,
and the `backlog` event, an additive change within v1", approved by Matt on 2026-10-30. The job
updates the contract doc and its dated changes list to match.

## Open
None.
