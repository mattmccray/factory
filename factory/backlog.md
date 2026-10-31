# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.

- [x] Settings and About open centered on the main window — both fixed-size child windows always open at their fixed size, centered on (and clamped to the screen of) the main window, ignoring remembered placement; an open one comes forward unmoved; the main window still remembers its own place — brief: factory/briefs/andon-child-window-placement.md → 077-andon-child-window-placement
