# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.

- [x] Contract package — copy (don't move) `factory/lib` and its tests into `packages/contract` (the installed copy under `factory/` stays until promotion); promote `factory/CONTRACT.md` to `docs/contract/v1.md` with its versioning rules (additive changes only within v1; how readers handle unknown fields); `factory/` untouched → 001-contract-package
- [ ] CLI package — the vendored `factory/cli.ts` runs on `packages/cli` (on `packages/contract`, not `factory/lib`), with the same commands, value parsing, and exit codes; add `factory doctor` (verifies managed hashes, validates config)
- [ ] Managed templates and overlay — the vendored skill and agents become project-neutral templates in `packages/templates` with overlay hooks (`factory/roles/<role>.md`, config-driven reviewers and gates) and version + hash stamps
- [ ] `factory init` / `upgrade` — install into a project (Claude Code adapter: render to `.claude/skills` and `.claude/agents`); `upgrade` replaces only managed files and leaves the overlay alone; supports self-upgrade of this repo
- [ ] `/factory customize` (alias `init`) — an interview that writes only the overlay, refuses anything that would break the contract, and ends by running `doctor`
- [ ] Per-role `runner` config — the Claude runner first; design and document how a non-Claude CLI fills a role (reads these paths, writes this one file); implementation of other runners later
- [ ] `andon-agent` — a Bun daemon that watches registered projects' `factory/` trees (no polling), reuses the contract code, serves the board and docs, and streams changes over server-sent events; `factory init` registers a project with it
- [ ] Andon UI (Svelte) — port the Minerva dashboard (viewport board, live timers, Settled dialog, drawer timing) and add a project switcher or all-projects view
- [ ] Tiny JS shell — thin wrapper around the UI: tray badge with the needs-human count, native notifications on escalate and merge, auto-start of the local agent; no contract code runs in it
- [ ] Migrate Minerva to the installed factory — run `init` against Minerva, move Minerva's reviewer rules into its overlay, run `doctor`, retire Minerva's vendored copy
- [ ] Rewrite `notes/factory-prompt.md` as a one-page "describe the factory" README once contract v1 is final
