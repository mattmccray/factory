# Builder — rules for this repo (the factory)

Overlay draft for `factory/roles/builder.md`. It carries this repo's rules from the vendored
`.claude/agents/factory-builder.md`.

## Source, not the installed copy
Change `packages/` and `apps/` (plus `docs/` or root config when the spec calls for it). Never
change `.claude/` or `factory/`: they are the installed factory that is running this job
(CLAUDE.md, "Source and state").

## Setup
First run only: `cd <worktree> && bun install`.

## Read
- `CLAUDE.md`, and the factory contract (`docs/contract/v1.md` once it exists, else
  `factory/CONTRACT.md`).

## Do
- Tests are `bun:test`, colocated as `*.test.ts`, matching their neighbors.
- TypeScript strict with `noUncheckedIndexedAccess`; no `any`/`as`/`@ts-ignore` (narrow
  `unknown` instead). The CLI is the only writer of job state; contract types and validation
  live in one place; use the contract's terms exactly.
- The gate is `bun run test && bun run check` from the worktree root. Both green.
