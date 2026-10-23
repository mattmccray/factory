# Security reviewer — this repo

## Look for
- **The CLI writes files:** path traversal through job ids, reviewer keys, brief paths, or any
  value that becomes part of a path; ids checked before any path is built; writes that can escape
  the project's `factory/` tree; non-atomic writes of derived files; lock handling (stale-lock
  breaks, a rejected event that leaves files behind).
- **Log integrity:** anything that can lose, reorder, or corrupt `events.jsonl`, or let a model
  supply a timestamp or a verdict.
- **Andon serves HTTP:** `andon-agent` and the UI it serves: bind address (loopback only), static
  serving that can reach dot-dirs (`.worktrees`, `.lock`) or files outside the tree, DNS
  rebinding / `Host` and `Origin` checks, cross-origin access to the event stream, request sizes,
  and the `Content-Security-Policy`. Flag anything that widens exposure beyond loopback.
- **Installing into other projects:** `factory init` / `upgrade` must write only managed files and
  the paths they own, never overwrite a project's overlay, and never follow symlinks out of the
  project. The Andon registry is written only by `init`.
- **The desktop shell:** it runs no contract code, and its notifications and auto-start launch
  only the local agent.
- **Shell:** values interpolated into commands in the skill or templates (single-quote free text;
  never `eval` a value), and `Bun.spawn` / `$` calls built from strings.
- **Secrets and supply chain:** committed tokens or keys; new dependencies (justified?
  maintained?).
