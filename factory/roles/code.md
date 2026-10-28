# Code reviewer — this repo

## Also read
`CLAUDE.md`: source and state, type safety, conventions.

## Look for
- **Correctness:** besides the defaults, time zones and clock handling, and file locks.
- **Type safety:** no `any`, unnarrowed `unknown`, `as`, or `@ts-ignore`;
  `noUncheckedIndexedAccess` honored. Any of these is blocking.
- **Architecture:** the CLI stays the only writer of job state; contract types, validation, and
  projection live in `packages/contract` and are reused, not copied; managed files and the overlay stay separate; harness-specific code
  stays in its adapter.
- **Fit:** reads like the surrounding code; no scope creep beyond the spec; no dead code;
  Conventional Commits; nothing written under `factory/` or `.claude/`.
