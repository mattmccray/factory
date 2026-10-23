# README — what the factory is, and how to install, upgrade, and use it

- Status: ready
- Sources: factory/backlog.md (item "Rewrite `notes/factory-prompt.md`…"), notes/factory-prompt.md, notes/factory-app.md, HANDOFF.md, docs/upgrade.md, docs/runners.md, docs/contract/v1.md
- Date: 2026-10-23

## Intent
A newcomer (or Matt, months from now) can read one page and know what the factory is, how to
install it into a project, how to upgrade it, and how to drive everyday development with it. It
is the doc that makes dogfooding possible outside this repo.

## Decisions
1. One doc or two? → **One root `README.md`**: a short "what it is" (the loop, updated for v1),
   then install, upgrade, everyday usage, and Andon, linking to `docs/contract/v1.md`,
   `docs/upgrade.md`, and `docs/runners.md` for depth. It replaces the backlog item that would
   have rewritten `notes/factory-prompt.md`; that note stays as history. Why: the note
   describes the prototype (board.json, ux reviewer, fixed models), and two docs is more to keep
   in sync for personal tooling.
2. Install command? → **`bun install` in the factory clone, then `bun link` in `packages/cli`,
   so `factory init` / `factory upgrade` run from any project.** No full-path form in the
   README: it isn't tenable to use. The job checks the linked command against a scratch project
   and changes code only if linking doesn't work as is. The README tells the two CLIs apart: the
   linked `factory` (source) installs and upgrades; `bun factory/cli.ts` (the project's installed
   copy) runs `doctor`, `show`, and `event`. Why: one memorable command; `bun install` as a
   documented step also fixes a fresh clone failing the gate.
3. What do the usage examples cover? → **A "Using it" section that follows one feature end to
   end in a neutral example project**, with real commands and paths: (1) set up once — `factory
   init`, `/factory customize` (gate, reviewers, role rules), `doctor`, commit; (2) get work in —
   `/factory explore` for fuzzy or contract-touching work (brief + backlog line), `/factory
   queue` for clear work; (3) run it — `/factory next`, what each stage does, where its files
   land under `factory/jobs/<id>/`, local merge, never a push; (4) when it stops — `needs-human`,
   reading `decision.md`, `/factory approve <id>` or `/factory rework <id> "<note>"`; (5) watch
   it — Andon (`bun run andon` from the factory clone, the desktop shell) and `bun factory/cli.ts
   show <id>`; (6) side by side — several sessions, the overlap check, the lock; (7) upgrade —
   `factory upgrade` after a new release or a `reviewers`/`roles` change, and the
   edited-managed-file refusal. It ends with short **rules of thumb**: one job is one reviewable
   diff; contract changes go through explore (6 of the first 10 jobs escalated for lacking a
   brief); never edit managed files, use the overlay; never push. This repo's self-hosting
   (promotion) gets its own short section pointing at `docs/upgrade.md`. Why: one worked path
   teaches the loop faster than a command reference.
4. What may the job touch? → **Create the root `README.md`; update `docs/upgrade.md` (and any
   other doc under `docs/`) to the linked `factory` command; change `packages/cli` only if `bun
   link` doesn't work as is.** Never `.claude/` or `factory/`; no contract change;
   `notes/factory-prompt.md` stays as is. Why: CLAUDE.md's job surface doesn't list a root
   README, so the brief authorizes it explicitly; `docs/upgrade.md` must not keep teaching the
   ruled-out full-path form.

## Scope
- In: root `README.md` (what it is, install, upgrade, using it, Andon, self-hosting, rules of
  thumb); `docs/upgrade.md` (and other `docs/` pages) switched to the linked command; a
  `packages/cli` fix only if linking fails.
- Out: packaging for distribution (`bunx`, a global package from a registry, or the desktop
  app bundling the CLI). It is the eventual goal, but HANDOFF lists distribution as deferred; it
  gets its own explore once dogfooding has proven the install. Also out: any contract change,
  `.claude/` or `factory/`, `notes/`, a docs site, public polish.

## Acceptance sketch
- A root `README.md` exists and covers, in order: what the factory is (the loop, v1 terms: event
  log, CLI as only writer, configured reviewers), install, upgrade, using it (the seven steps of
  decision 3), Andon, this repo's self-hosting, and rules of thumb.
- Following the README's install steps on a fresh clone puts a working `factory` on PATH, and
  `factory init` in a scratch git repo followed by `bun factory/cli.ts doctor` exits 0. The
  build records that it ran them.
- Every command, script name, path, and file name the README shows exists and behaves as
  described in this repo (e.g. `bun run andon`, `factory upgrade`, the job files).
- No full-path `bun …/packages/cli/src/main.ts` form remains in the README or `docs/`.
- The README links to `docs/contract/v1.md`, `docs/upgrade.md`, and `docs/runners.md`, and
  each link resolves.
- The gate passes; nothing under `.claude/`, `factory/`, or `notes/` changed.

## Contract calls
None.

## Open
None.
