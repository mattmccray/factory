# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.
- [ ] A landed epic's row: a wider name, its text right-aligned — the name cell spans the gutter plus the first stage column (one line, ellipsized), the landed text is flush right; every other row unchanged — brief: factory/briefs/landed-row-layout.md
