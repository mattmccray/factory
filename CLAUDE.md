# The factory

This repo is the factory itself: the `factory/v1` contract, the CLI (the only writer of job
state), the managed core (the `/factory` skill and role templates), the installer and
guardrails (`init`, `customize`, `doctor`, `upgrade`), harness adapters, and Andon (the
dashboard). `docs/decisions.md` records the project's binding decisions, its invariants, and
its deferred list.

Write in American English (en-US).

## Source and state

The factory being built is never the factory doing the building.

- **Source** is `packages/` and `apps/`. Jobs change source, plus `docs/` or root tooling
  config (`package.json`, `tsconfig.json`) or the 'README.md' when the work calls for it.
- **The installed copy** is `.claude/` (the skill and agents) and `factory/` (the CLI,
  `CONTRACT.md`, `managed.json`, and the overlay: `config.json` and `roles/<role>.md`). It runs
  the jobs. **Jobs never change `.claude/` or `factory/`.**
- **Runtime state** is `factory/jobs/`, `factory/.lock/`, and `factory/.worktrees/`
  (gitignored). Only the factory CLI writes job state.

## Promotion

Promoting merged source into the installed copy is a deliberate, human-approved step outside
any job: `factory upgrade` run against this repo on `main`, after a merge, never mid-job (see
`docs/upgrade.md`, "Self-upgrade of this repo"). `upgrade` leaves the overlay alone, so
overlay changes (`factory/config.json`, `factory/roles/`) are hand edits in the same step.

## The contract

`factory/v1` is specified in `docs/contract/v1.md` (`factory/CONTRACT.md` is its installed
copy). Contract changes are versioned (additive only within v1) and are reviewed by the
contract reviewer (`factory-contract`). A change to the contract's surface updates the
contract doc in the same diff.

## Gate

`bun run test && bun run check` — `bun test` over `packages/` and `apps/`, and strict `tsc`
(`noUncheckedIndexedAccess`, Bun types). `bun factory/cli.ts doctor` checks the installed copy.

## Conventions

- TypeScript strict; no `any`, `as`, or `@ts-ignore` — narrow `unknown`.
- Tests are `bun:test`, colocated as `*.test.ts`.
- Conventional Commits. The main branch is `main`; never push without being asked.
