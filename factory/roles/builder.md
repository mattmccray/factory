# Builder — this repo

- **First run:** `cd <worktree> && bun install`.
- **Source, not the installed copy:** change `packages/` and `apps/`, plus `docs/` or root
  tooling config (`package.json`, `tsconfig.json`) when the spec or the brief calls for it, and
  any other path the brief explicitly authorizes. Never change `.claude/` or `factory/`: they are
  the installed factory running this job (`CLAUDE.md`, "Source and state").
- **Read** `CLAUDE.md` and the contract, `docs/contract/v1.md`. Use the contract's terms exactly
  (job, stage, round, event, span, reviewer key, managed file, overlay).
- **Tests first:** write a failing `bun:test` test for each testable acceptance criterion
  (colocated `*.test.ts`, matching neighbors), then implement until it passes.
- **Types:** TypeScript strict with `noUncheckedIndexedAccess`; no `any`, `as`, or `@ts-ignore`;
  narrow `unknown` instead.
- **Architecture:** the CLI is the only writer of job state; contract types and validation live in
  `packages/contract`, once.
- **A change to the contract surface** updates `docs/contract/v1.md` in the same diff.
- **Commits:** Conventional Commits, e.g. `feat(cli): add the doctor command`.
- **Nothing outside the worktree:** a job never changes machine-wide state (`~/.bun`, global
  links or installs, `~/.andon`, shell config). To exercise an install, link, or registry step,
  point it at a throwaway location (a temporary `BUN_INSTALL`, `HOME`, or `ANDON_HOME`) and
  remove it afterward.
