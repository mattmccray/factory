# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.

- [x] Andon window and menu polish — a frameless full-bleed About window as a child of main, File → Close Window (⌘W) and Escape on About; a draggable inspector Files divider and sidebar, sizes and window placement remembered; New Exploration… (⌘N) in the File menu and New Exploration… / Run Next in a project's right-click menu; an epic name's right-click Open in T3 Code — epic: factory/epics/andon-window-polish.md → epic andon-window-polish
