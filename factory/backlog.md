# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.


- [ ] `factory upgrade --commit` — upgrade commits exactly the files it wrote or deleted plus managed.json as `chore(factory): upgrade factory <old> -> <new>`, leaving other changes alone; refuses up front outside a work tree, on detached HEAD, or mid-merge/rebase — brief: factory/briefs/upgrade-commit-flag.md
