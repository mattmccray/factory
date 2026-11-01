# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.
- [x] Release runs its gate in the checkout — `bun run release` runs the gate in the checkout (no `git archive` export), builds the bundle after the version and changelog writes and restores them on a failed build; `archive.test.ts` no longer needs a git repo; decision 14 and docs/upgrade.md updated — brief: factory/briefs/release-gate-in-checkout.md → 090-release-gate-in-checkout
