# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.

- [ ] Merge conflicts go back to the builder instead of to a human — a conflicting merge logs `merge.conflicted` (CLI-derived budget, `conflicts` count, refused after 2), the builder merges the target in and resolves, then a normal review round and approver; non-conflict failures unchanged — brief: factory/briefs/merge-conflict-rework.md
