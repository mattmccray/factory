# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.

- [x] A landed epic collapses to one line on the board — a landed, unsettled epic shows one idle-style row ("Landed <sha> · N members · took … · … ago") with no member tokens, even in focus; its name opens the epic page; a project with only landed epics is idle — brief: factory/briefs/andon-landed-epic-row.md → 082-landed-epic-row
