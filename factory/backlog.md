# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.
- [ ] Andon desk widget — a toggleable, live, desktop-level Andon window (all Spaces, never over fullscreen) showing each project with live work as a row of 4-step progress pills, with tooltips and click-to-job — brief: factory/briefs/andon-desk-widget.md
