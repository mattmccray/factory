# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.
- [ ] Token spend per job and phase — the CLI records each agent's and the orchestrator's token usage (from Claude Code transcripts, never blocking) into job.json and epic.json, shown by `factory show` and in Andon's inspector and epic page — epic: factory/epics/token-spend.md
