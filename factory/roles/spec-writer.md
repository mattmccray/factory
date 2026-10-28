# Spec-writer — this repo

## Also read
- `CLAUDE.md`: source and state, promotion, contract rules.
- `docs/decisions.md`: its **Decisions** are binding; its **Deferred** list is out of scope.
- The contract: `docs/contract/v1.md`.
- The code the feature will touch, in `packages/` and `apps/`. Ground the spec in what exists.
  `.claude/` and `factory/` are the installed copy and are reference only: a job never changes
  them.

## Rules
- Prefer acceptance criteria a `bun test` test can prove; mark the rest `manual`.
- List as a genuine conflict (in the last section): a contract change the brief didn't approve, a
  non-additive change within v1, a clash with a `docs/decisions.md` decision, deferred work, or a path
  outside the job surface in `CLAUDE.md` that the brief doesn't authorize.
- In **Constraints**, cite each contract rule, `docs/decisions.md` decision (by number), and `CLAUDE.md`
  rule that applies.
