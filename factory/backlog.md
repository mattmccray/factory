# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.

- [x] Rename the archive branch to `factory/archive` (before Andon reads the archive) — `factory archive` and `claim`'s id read use `refs/heads/factory/archive` instead of `factory/jobs`, so bare `git log factory/archive` works; the `factory/jobs/` directory, tree layout, trailers, and `archive` config key are unchanged; no fallback for the old name (renamed by hand at promotion); tests, skill template, and `docs/contract/v1.md` updated — brief: factory/briefs/archive-branch-rename.md → 046-archive-branch-rename
- [ ] Andon reads the archive (after Job archive) — the Andon service serves jobs found only on `factory/archive` in the existing `board` and `docs` shapes (re-projected from `events.jsonl`, a local dir wins), watches the ref without polling, and caches per branch tip (no git call on a `jobs/` change; one `ls-tree` and one `cat-file --batch` per ref move, counted by a test); read-only git, no shell; no Andon UI change — brief: factory/briefs/andon-reads-archive.md
- [ ] Prune archived job dirs (after Andon reads the archive) — a manual `factory prune` removes only local job dirs that are archived, settled, and byte-identical to their archived tree, reporting what it kept and why; refused with archiving off; ids and Andon unaffected — brief: factory/briefs/job-prune.md
