# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.

- [x] The Andon service serves epics — `epics` on every board payload and event (plain and narrow), settled epics on demand, `GET /projects/<pid>/epics/<slug>/docs`, archived epics, a `factory/epics/` watch, and members settling with their epic via the shared rule; no writes, no new event types — brief: factory/briefs/andon-epics-service.md → 054-andon-epics-service
- [ ] The Andon UI shows epics — sub-lanes with the epic gutter, compact "in epic" merged tokens with the branch-merge icon, the epic inspector page, epic-level waits in every needs-human count, settled epics, search, `#epic=` deep links, and the Mac app's badge and two epic notifications, per docs/design/epics/ — brief: factory/briefs/andon-epics-ui.md
