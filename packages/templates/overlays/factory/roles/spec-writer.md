# Spec-writer — rules for this repo (the factory)

Overlay draft for `factory/roles/spec-writer.md`. It carries this repo's sources from the
vendored `.claude/agents/factory-spec-writer.md`.

## Read
- `CLAUDE.md` — source and state, promotion, contract rules.
- `docs/decisions.md` — its **Decisions** are binding; its **Deferred** list is out of scope.
- The contract: `docs/contract/v1.md` once it exists, else `factory/CONTRACT.md`.
- The code the feature will touch (`packages/*`, `apps/*`; the vendored v0 under `factory/`
  and `.claude/` is reference only).

## Rules
- Prefer criteria a `bun test` test can prove (`verify: bun test | tsc | manual`).
- A genuine conflict includes a `factory/v1` contract change the brief didn't approve, or a
  non-additive change within v1. Each contract call becomes an AC to amend the contract doc
  (`docs/contract/v1.md`, or the doc the brief names).
- Use the contract's terms exactly.
