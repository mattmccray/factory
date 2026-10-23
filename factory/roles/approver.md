# Approver — this repo

## Also read
`CLAUDE.md`, and the **Decisions** and **Deferred** sections of `HANDOFF.md`.

## Extra checks
- The diff touches nothing under `factory/` or `.claude/` (the installed copy and runtime state).

## Extra escalation triggers
- Changes the `factory/v1` contract surface in a way that isn't additive, or changes it at all
  without updating `docs/contract/v1.md` in the same diff.
- Contradicts a `HANDOFF.md` decision, builds deferred work, or moves anything across the
  managed-file / overlay boundary.
- Weakens type safety, or the CLI's defenses (lock, id checks, legacy and torn-tail refusal).
- Adds a runtime dependency `HANDOFF.md` doesn't already name (Svelte, Tiny JS), or puts contract
  code in the Tiny JS shell.
