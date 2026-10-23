# Runners other than Claude Code (design)

Non-normative. The binding rules are the role I/O protocol in
[`docs/contract/v1.md`](contract/v1.md), "Runners", and the `roles` key in "`config.json`". This
page sketches how a later job could let a non-Claude CLI (for example, Codex for a cross-model
reviewer) fill a role while Claude Code still orchestrates. Nothing here is implemented: in v1,
`"claude"` is the only accepted `runner`, and other harness adapters are deferred (HANDOFF,
"Deferred").

## Where the runner is chosen

`factory/config.json` names a runner per role:

```json
"roles": { "security": { "runner": "codex", "model": "gpt-5" } }
```

A later job widens the accepted `runner` values in `parseConfig` (an additive v1 change, updating
the contract doc in the same diff). Roles without an entry stay on `claude`. The orchestrator
still runs in Claude Code; only the role's run changes.

## How the orchestrator runs a non-Claude role

For a role whose runner isn't `claude`, the orchestrator replaces "spawn `factory-<role>`" with
"run the runner's CLI". Everything around the run stays the same:

1. **Span first.** Run `bun factory/cli.ts event <id> agent.started …` with the role's usual
   identity fields (`role`, plus `key` and `round` for a reviewer). The span never uses the
   runner's own session or process id.
2. **Build the card.** The same spawn card as for Claude Code (`repo`, `job dir`, `worktree`,
   `round`, `brief`, `write`, `deliver`), with the same absolute paths.
3. **Give it the role's instructions.** The runner has no Claude agent definition, so the adapter
   passes the role's managed instructions as its prompt: the rendered agent file's body (the text
   after the frontmatter and stamp) followed by the card. The body already tells it to read its
   overlay, `factory/roles/<role>.md`, at run time, so the overlay still never enters managed
   bytes.
4. **Invoke the CLI** non-interactively from the repo root, with the prompt on stdin or in a
   temp file outside `factory/`, the role's `model` when configured, and the narrowest sandbox the
   CLI offers. A reviewer or approver gets read-only access to the worktree plus write access to
   its one path. The builder gets write access to the worktree and `build.md`. Run reviewers in
   parallel, as Claude Code reviewers are.
5. **Confirm the file.** When the CLI exits, check that the `write` path exists. If it doesn't,
   re-run once with the same card plus a one-line "create `<path>` now" note (a CLI without
   resumable sessions can't be nudged in place). If it is still missing, log `job.escalated`, the
   same as for Claude Code.
6. **Close the span.** Run `agent.finished` with the same identity fields. The CLI reads the
   verdict from the file's first line. The orchestrator never parses the runner's output for a
   verdict and never passes one.

A malformed first line is handled as for Claude Code: re-run the role asking it to fix only that
line, then retry `agent.finished`. The orchestrator never edits the file itself.

## Builder sessions

The Claude builder is resumed once per round, so it keeps its context. A runner without
resumable sessions is re-run each round with the card plus the round's review folder (or the
rework note). Everything it needs is in files (`spec.md`, its own `build.md`, the reviews, the
branch), so a fresh run is correct, only slower. The span is still `role=builder
name=builder-<id>`, with `round=<N>` after round N.

## What doesn't change

- The CLI, the events, span identity, and how the CLI reads verdicts.
- The managed render. Claude agent files are still rendered for every role, so switching a role
  back to `claude` needs only a config change and `factory upgrade`.
- The board. Andon sees the same spans and files whatever filled the role.

## Checklist for a new runner

A runner may be accepted in `roles` only when all of these hold:

- [ ] It takes the spawn card and the role's managed instructions, and needs no other context.
- [ ] It reads the role's overlay, `factory/roles/<role>.md`, when it exists.
- [ ] It writes exactly the card's `write` path, with the role's first line (`# <title>`,
      `# Build — <id>`, `VERDICT: PASS|CHANGES`, `APPROVE|ESCALATE`), plus only what the role
      allows (builder commits in the worktree; reviewer supporting files under `round-<N>/<key>/`).
- [ ] It never writes job state (`events.jsonl`, `job.json`), the overlay, managed files,
      `.lock/`, the main checkout's code, or `main`, and never runs the CLI's `event` command.
- [ ] It runs non-interactively and exits when it's done, so the orchestrator can confirm the file.
- [ ] Its sandbox keeps reviewers and the approver read-only on code.
- [ ] Its `model` value, if any, fits the contract's model pattern.
- [ ] The contract doc's accepted `runner` values, `parseConfig`, and `/factory customize`'s
      refusal rules are widened together, in one diff reviewed by `factory-contract`.
- [ ] Its adapter has tests that cover a missing file, a malformed first line, and a parallel
      review round.
