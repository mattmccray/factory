# Handoff — the factory, as its own project

- Date: 2026-10-22
- From: an interview session in Minerva v3 (`/Users/mattm/Projects/Personal/Apps/minerva-v3`)
- Status: **not yet seeded.** This folder holds only this handoff and `notes/`. Don't start
  building until the Minerva prerequisites below are done.

## What this project is

The **factory**: a skill-driven software factory in which a feature goes spec → build → N
parallel reviews → approve → merge. It's driven by agents that talk only through markdown
files, and it's observable through a fixed state contract. It was born inside Minerva and is
being extracted here so that any project can install it. Then a desktop/web dashboard, **Andon**,
can watch every project's factory at once. This repo owns all of it:

- the **contract** (`factory/v1`): event log, derived snapshot, config, file layout;
- the **CLI**, the only writer of job state;
- the **managed core**: the orchestrator skill and the role templates (spec-writer, builder,
  reviewer, approver);
- the **installer and guardrails**: `factory init`, `/factory customize`, `factory doctor`,
  `factory upgrade`;
- **harness adapters** (Claude Code first);
- **Andon**: `andon-agent` (a Bun daemon), a Svelte UI, and a Tiny JS desktop shell.

It is **personal tooling now, built to be publishable later.** Keep the contract and the
boundary between managed files and overlay clean enough that publishing never needs a
rewrite. Don't spend effort on public polish yet.

## Reference implementation (read these first)

All of these are in Minerva, at `/Users/mattm/Projects/Personal/Apps/minerva-v3/`:

| What | Path |
|---|---|
| The orchestrator skill | `.claude/skills/factory/SKILL.md` |
| The explore interview | `.claude/skills/factory/explore.md` |
| Role agents (Minerva-specific) | `.claude/agents/factory-{spec-writer,builder,security,ux,ui,code,approver}.md` |
| **The state contract (draft v1)** | `factory/CONTRACT.md` ← the starting spec for this repo |
| Contract code + CLI (after the plan lands) | `factory/lib/{contract,project,store}.ts`, `factory/cli.ts`, `factory/config.json` |
| Dashboard server / page | `factory/serve.ts`, `factory/dashboard.html` |
| Backlog and brief formats | `factory/backlog.md`, `factory/briefs/*.md` |
| Real job runs (gitignored, local) | `factory/jobs/001…/` (legacy, without event logs) and later jobs (with `events.jsonl`) |
| The plan that adds the event log, CLI and timers | `docs/superpowers/plans/2026-10-22-factory-observability.md` |

Source notes are in this repo: `notes/factory-app.md` (the original wishlist) and
`notes/factory-prompt.md` (the original "build a factory" prompt the Minerva factory was built
from).

## Prerequisites (in Minerva, before seeding)

1. Implement Minerva's observability plan by hand. This covers the CLI as the only writer, the
   `events.jsonl` log, the derived `job.json`, `config.json`, and the dashboard (viewport
   board, live timers, Settled dialog).
2. Run **3–5 real Minerva jobs** on it, ideally including a multi-round job and an escalation.
   Note any contract friction in Minerva's `factory/CONTRACT.md`.

## Decisions (from the 2026-10-22 interview; binding unless revisited with Matt)

1. **This repo is the factory itself,** not just a dashboard. Minerva is its first consumer and
   the reference it was extracted from.
2. **The contract is proven in Minerva first,** then lifted here. Start from Minerva's
   `factory/CONTRACT.md`; don't redesign it from scratch.
3. **An append-only per-job event log** (`jobs/<id>/events.jsonl`) is the truth. It records
   per-stage *and* per-agent timing, because parallel reviewers hide each other's durations
   in stage-level timing.
4. **A CLI is the only writer.** It takes timestamps from the system clock (never from the
   model), validates events and transitions (including WAIT FOR ALL), reads verdicts from the
   agents' files, appends to the log, and regenerates `job.json` as a disposable projection.
   The orchestrator runs commands; it never writes JSON.
5. **Andon board UX** (proven in Minerva's dashboard first):
   - the board fills the viewport, and each column scrolls independently under a fixed header;
   - the andon (needs-human) row has a capped height;
   - live timers show time in stage, total time, each reviewer's time, and how long a
     needs-human job has been waiting;
   - "settled" is a view: merged jobs older than `settleAfterHours` (default 24) move to a
     Settled dialog.
6. **Personal now, publishable later.**
7. **Names:**
   - "factory" is the contract identifier: `/factory`, a `factory/` folder in each project,
     a `factory` CLI, and `schema: "factory/v1"`;
   - the dashboard is called **Andon**;
   - in prose it's "the factory", with no "The";
   - everything lives in one repository, here.
8. **Managed core plus project overlay.**
   - Managed files (skill, role templates, CLI) are stamped with a version and hash and must
     not be edited.
   - The overlay is `factory/config.json` (reviewers, per-role model/runner, gate commands,
     issue tracker, merge policy, `maxRound`, settle threshold) plus `factory/roles/<role>.md`
     (each project's rules for a role).
   - `/factory customize` (alias `init`) edits only the overlay. `factory doctor` verifies
     managed hashes and validates config. `factory upgrade` replaces managed files and leaves
     the overlay alone.
   - Fixed: the lifecycle stages, event types, file layout and CLI. Configurable: reviewers,
     rules, models, gates, tracker and merge policy.
   - Required roles: spec-writer, builder, approver, and at least one reviewer.
9. **Harnesses:**
   - v1 targets Claude Code only (Matt uses it for about 99% of his work).
   - The design stays harness-neutral: a role's `runner` is part of the config (for example
     `{"runner": "claude", "model": "opus"}`), so other harnesses can *fill roles* (such as a
     Codex reviewer, for cross-model review) before they can *orchestrate*.
   - Codex, Pi and OpenCode as orchestrators come later, one adapter at a time, each starting
     with a research task.
   - Resuming the same builder between rounds is optional. The fallback is a fresh builder
     working from files (the rework path already does this).
10. **Andon architecture:**
    - `andon-agent` is a Bun daemon per machine. It knows the projects registered on that
      machine, watches their `factory/` trees (no polling), reuses the CLI's contract code,
      and streams changes over server-sent events.
    - The UI is a Svelte web app that connects to one or more agents. Supporting multiple
      machines later just means adding more agent URLs.
    - A thin **Tiny JS** shell (https://tinyjs.app) wraps the UI. It starts the local agent if
      needed and adds a tray badge with the needs-human count, plus native notifications on
      escalate and merge.
    - The shell must stay thin enough to swap out. As of 2026-10-21, Tiny JS is 0.63, has
      about 58 releases in 12 weeks, and has had some breaking changes. Its backend is
      txiki.js, not Node, so the contract code must not run there.
    - Registration: `factory init` registers a project with the local agent, and Andon can add
      or remove projects too.
11. **Bootstrap and dogfooding:**
    1. Seed this repo by hand with a **vendored v0** copy of Minerva's upgraded factory, plus
       this repo's own overlay. That's the last hand-written step.
    2. Everything after that goes through `/factory` here, including turning the vendored copy
       into managed templates.
    3. **The factory being built is never the factory doing the building.** Factory source
       lives in `packages/`. The *installed* copy that actually runs lives in `.claude/` and
       `factory/`, like any consumer. Jobs change only `packages/`.
    4. After a merge, an explicit self-upgrade (`factory upgrade` against this repo) promotes
       the new version. A job never modifies its own orchestrator mid-run.
    5. `factory/` stays pure runtime state plus the overlay, so the builder rule "never write
       under `factory/`" holds unchanged.
12. **This repo's reviewers:**
    - **code**;
    - **security** (the agent serves HTTP, and the CLI writes files);
    - **contract**, a new reviewer that checks every change against the schema and versioning
      rules;
    - **ui**, for Andon changes; it simply PASSes when Andon isn't touched. Conditional
      reviewers can wait.

## Seeding steps (do these by hand, once the prerequisites are done)

1. Lay out the repo:
   - `packages/contract` (types, validation, projection; lifted from Minerva's `factory/lib`);
   - `packages/cli`;
   - `packages/templates` (the skill and role templates, made project-neutral);
   - `packages/andon-agent`;
   - `apps/andon`, holding the Svelte UI and Tiny JS shell (empty until its jobs run).

   Use Bun workspaces, TypeScript strict and `bun test`.
2. **Vendor v0.** Copy Minerva's `.claude/skills/factory/` and `.claude/agents/factory-*.md` into
   this repo's `.claude/`, and Minerva's `factory/{cli.ts,lib/,serve.ts,dashboard.html,CONTRACT.md}`
   into `factory/`. Then strip the Minerva specifics:
   - PRD and DESIGN.md references;
   - `bun run issues` and the `M##` handling;
   - the UX reviewer.

   Write this repo's `factory/config.json` with reviewers `["security","code","contract","ui"]`
   and the gate `bun test && bun run check`. Write the role rules (including the new
   `factory-contract` agent) in the same style as Minerva's agents.
3. Write a `CLAUDE.md` for this repo. Include the source/state separation rule, the
   self-upgrade rule, and "contract changes are versioned and reviewed by the contract
   reviewer".
4. Write `factory/backlog.md` with the initial backlog below, commit, and run `/factory next`.

## Initial backlog (in dependency order; refine with `/factory explore` where fuzzy)

1. **Contract package.** Lift `factory/lib` into `packages/contract`. Promote CONTRACT.md to
   `docs/contract/v1.md` with its versioning rules (additive changes only within v1; how
   readers handle unknown fields).
2. **CLI package.** Run the vendored `factory/cli.ts` on `packages/cli`. Add `doctor`.
3. **Managed templates and overlay.** Turn the vendored skill and agents into neutral templates
   in `packages/templates` with overlay hooks (`factory/roles/<role>.md`, config-driven
   reviewers and gates), and add version and hash stamps.
4. **`factory init` / `upgrade`.** Install into a project (Claude Code adapter: render to
   `.claude/skills` and `.claude/agents`), upgrade only managed files, and support self-upgrade
   for this repo.
5. **`/factory customize`.** An interview that writes only the overlay and refuses anything
   that would break the contract. Ends by running `doctor`.
6. **Per-role `runner` config.** The Claude runner first. Design and document how a non-Claude
   CLI fills a role (read these paths, write this one file); implement later.
7. **`andon-agent`.** Watch registered projects, serve the board and docs, and stream changes
   over server-sent events. Handle registration through `factory init`.
8. **Andon UI** (Svelte). Port the Minerva dashboard (viewport board, timers, Settled dialog)
   and add a project switcher or all-projects view.
9. **Tiny JS shell.** A tray badge with the needs-human count, notifications, and auto-start
   of the agent.
10. **Migrate Minerva** to the installed factory: run `init` against Minerva, move Minerva's
    reviewer rules into its overlay, run `doctor`, and retire Minerva's vendored copy.
11. **Rewrite `notes/factory-prompt.md`** as a one-page "describe the factory" README once
    contract v1 is final.

## Deferred (don't build yet)

- Codex, Pi and OpenCode orchestrator adapters, each starting with a research task.
- Andon across multiple machines (the agent design already allows it).
- Reviewers that run only when certain files change.
- Distribution for publishing: name collision checks, a package registry, docs site.
- Reconstructing timing for legacy jobs (001–018) from git history; they show no timing.
