# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.
- [x] Say why a GitHub project can't draft, and space the New exploration title — when T3 Code's primary remote isn't on GitHub but another remote is, the toast names both remotes and says to make the GitHub one `upstream`; "No GitHub remote" stays for projects with none; drafts still use the primary; the New exploration title has one space before the project name — brief: factory/briefs/t3-primary-remote-toast.md → 091-t3-primary-remote-toast
