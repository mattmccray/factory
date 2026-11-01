# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.
- [x] `factory upgrade` runs doctor — every completed upgrade runs the installed `factory/cli.ts doctor` and exits 1 when it fails (no rollback; with `--commit`, no commit); promote drops its own doctor step; contract and docs/upgrade.md updated — brief: factory/briefs/upgrade-runs-doctor.md → 089-upgrade-runs-doctor
