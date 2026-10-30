# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.

- [ ] Andon's View menu and a Merged column switch — View menu with Needs Me, Settled, sidebar, inspector, status bar, and Merged column toggles whose labels track the page; a "Show Merged column" setting — brief: factory/briefs/andon-view-menu.md
- [ ] An About window for Andon — App → About Andon opens a window with the lantern art, the app's version (and the service's when it differs), the GitHub link, and the copyright — brief: factory/briefs/andon-about.md
- [ ] Backlog in Andon, and starting work from it — the service serves each project's queued backlog and explorations, Andon shows them in a Backlog sheet with brief and plan pages, and Run / Start epic / Run next / Continue exploring / New exploration hand `/factory` commands to T3 Code — epic: factory/epics/andon-backlog.md
