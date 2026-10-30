# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.

- [x] Factory distribution — `bun add -g github:mattmccray/factory#release` gives a working `factory` on macOS and Linux (release branch built and pushed by `bun run release` / `release:push`), `factory service …` runs Andon under launchd/systemd, and `factory projects prune` cleans the registry — epic: factory/epics/factory-distribution.md → epic factory-distribution
- [ ] Andon's View menu and a Merged column switch — View menu with Needs Me, Settled, sidebar, inspector, status bar, and Merged column toggles whose labels track the page; a "Show Merged column" setting — brief: factory/briefs/andon-view-menu.md
