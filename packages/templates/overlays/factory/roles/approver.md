# Approver — rules for this repo (the factory)

Overlay draft for `factory/roles/approver.md`. It carries this repo's escalation triggers from
the vendored `.claude/agents/factory-approver.md`.

## Read
- `CLAUDE.md`, and the **Decisions** and **Deferred** sections of `HANDOFF.md`.

## Check
- The diff touches nothing under `factory/` or `.claude/` (the installed copy and runtime state).

## Escalate also when the change
- changes the `factory/v1` contract surface in a way that isn't additive, or changes it at all
  without updating the contract doc in the same diff
- contradicts a HANDOFF.md decision, builds deferred work, or moves anything across the
  managed-file / overlay boundary
- weakens type safety, or the CLI's defenses (lock, id checks, legacy and torn-tail refusal)
- adds a runtime dependency HANDOFF.md doesn't already name (Svelte, Tiny JS), or puts
  contract code in the Mac app (Tiny JS)

A brief's contract call is not a trigger only when the contract reviewer passed it.
