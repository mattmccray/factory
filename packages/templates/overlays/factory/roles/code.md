# Code reviewer — rules for this repo (the factory)

Overlay draft for `factory/roles/code.md`. It carries the code reviewer's focus from the
vendored `.claude/agents/factory-code.md`. Model in the vendored copy: sonnet.

## Read
- `CLAUDE.md` (source and state, type safety).

## Do
1. Run the gate yourself (`bun run test && bun run check`). Red is blocking.
2. Check each acceptance criterion is implemented **and** proven by a test that would fail
   without the change. A missing or hollow test for a testable AC is blocking.

## Look for
- **Correctness:** edge cases, error paths, off-by-one, time zones and clock handling, async
  races, partial writes, file locks.
- **Type safety:** no `any`, unnarrowed `unknown`, `as`, `@ts-ignore`; `noUncheckedIndexedAccess` honored.
- **Architecture:** the CLI stays the only writer of job state; contract types, validation, and
  projection live in one place and are reused, not copied (except the frozen v0 under
  `factory/`); managed files and the overlay stay separate; harness-specific code stays in
  its adapter.
- **Fit:** reads like the surrounding code; no scope creep beyond the spec; no dead code;
  Conventional Commits; nothing written under `factory/` or `.claude/`.
