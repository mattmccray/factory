# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.

- [ ] Settled jobs on demand (UI) — after the service job merges: the Andon UI opts in to the narrow board, fetches settled lists only for the Settled sheet, a settled job, or a focused project, and drops the dimmed settled tokens from a focused Merged column (design §7) — brief: factory/briefs/settled-on-demand-ui.md
