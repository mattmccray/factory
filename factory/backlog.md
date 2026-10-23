# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.

- [x] Contract package — copy (don't move) `factory/lib` and its tests into `packages/contract` (the installed copy under `factory/` stays until promotion); promote `factory/CONTRACT.md` to `docs/contract/v1.md` with its versioning rules (additive changes only within v1; how readers handle unknown fields); `factory/` untouched → 001-contract-package
- [x] CLI package — the vendored `factory/cli.ts` runs on `packages/cli` (on `packages/contract`, not `factory/lib`), with the same commands, value parsing, and exit codes; add `factory doctor` (verifies managed hashes, validates config) → 002-cli-package
- [x] Managed templates and overlay — the vendored skill and agents become project-neutral templates in `packages/templates` with overlay hooks (`factory/roles/<role>.md`, config-driven reviewers and gates) and version + hash stamps → 003-managed-templates
- [x] `factory init` / `upgrade` — install into a project (Claude Code adapter: render to `.claude/skills` and `.claude/agents`); `upgrade` replaces only managed files and leaves the overlay alone; supports self-upgrade of this repo → 004-factory-init-upgrade
- [x] `/factory customize` (alias `init`) — an interview that writes only the overlay, refuses anything that would break the contract, and ends by running `doctor` → 005-factory-customize
- [x] Per-role `runner` config — the Claude runner first; design and document how a non-Claude CLI fills a role (reads these paths, writes this one file); implementation of other runners later → 006-role-runner-config
- [x] `andon-agent` — a Bun daemon that watches registered projects' `factory/` trees (no polling), reuses the contract code, serves the board and docs, and streams changes over server-sent events; `factory init` registers a project with it → 007-andon-agent
- [x] Andon UI (Svelte) — port the Minerva dashboard (viewport board, live timers, Settled dialog, drawer timing) and add a project switcher or all-projects view → 008-andon-ui
- [x] Andon UI follow-ups from 008 — `TimingView` timing line reads "PM · merged" (space before the separator); UI `Job`/span/config shapes are checked at compile time against `@factory/contract` via a type-only import (no contract runtime code in the browser); `vite.config.ts` pins the dev server to `127.0.0.1` with `cors: false`; the agent sends a restrictive `Content-Security-Policy` (`default-src 'self'`, no inline script) on UI responses and the board still works under it; `docs/contract/v1.md` says "any other path not served by the UI routes is a 404" and records the CSP header; additive within v1, no new runtime dependency → 009-andon-ui-followups
- [x] Tiny JS shell — thin wrapper around the UI: tray badge with the needs-human count, native notifications on escalate and merge, auto-start of the local agent; no contract code runs in it → 010-andon-shell
- [ ] README — root `README.md` says what the factory is and how to install (`bun link` → `factory init`), upgrade, and use it end to end; `docs/` drops the full-path CLI form; every command shown works; no contract change — brief: factory/briefs/readme.md
- [ ] Skill template's dashboard pointer — `packages/templates/assets/skill/SKILL.md` names Andon (`bun run andon` in the factory clone → http://127.0.0.1:8766/) instead of `bun factory/serve.ts` / `:8765/dashboard.html`, with a render test that fails on the old text; no contract change, nothing under `.claude/` or `factory/` touched
- [ ] Migrate Minerva to the installed factory — run `init` against Minerva, move Minerva's reviewer rules into its overlay, run `doctor`, retire Minerva's vendored copy
