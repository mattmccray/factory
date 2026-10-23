# Configurable target branch

- Status: done
- Job: 014-configurable-target-branch (merged c0a944d, 2026-10-23)
- Sources: `HANDOFF.md` (Decision 8: "merge policy" is a planned overlay setting), `docs/contract/v1.md`, `packages/templates/assets/{skill/SKILL.md,agents/*.md}`, `packages/templates/overlays/factory/roles/{ui,contract}.md`
- Date: 2026-10-23

## Intent
The factory assumes every job branches from and merges into `main`. That breaks on projects whose
main branch is `master`, or that want factory work to land on some other branch. The target
branch becomes a `config.json` setting, and one option, `current`, means "whatever branch the
orchestrator's checkout is on".

## Decisions
1. When is the target resolved? → **Once per job, at claim time.** The CLI resolves the config
   value (for `current`, the main checkout's branch at that moment) and records it as a new
   optional `target` field on `job.claimed`, projected into `job.json` as `target`. The spawn
   card passes `base: <target>` to every agent in place of the hard-coded `main`. Why: the job
   stays consistent for its whole life (worktree base, review diffs, merge) even if the checkout
   switches branch or `config.json` changes mid-job; the log stays the truth, and Andon can show it.
2. Config shape and default? → **`"merge": { "target": "current" | "<branch>" }`, default
   `"current"` when `merge` or `merge.target` is absent.** Why: the target is part of how a job
   lands, so it sits where HANDOFF's planned merge policy will go; `current` is a no-op for
   projects already run from `main` (the skill requires that today) and makes `master` projects
   work with no config. A branch literally named `current` can't be targeted; documented, not escaped.
3. Who resolves and checks the target? → **The CLI, inside `job.claimed`.** It reads
   `merge.target`; for `current` it runs `git symbolic-ref --short HEAD` in the repo root, and
   for a name it checks `refs/heads/<name>` exists. It refuses the claim, writing nothing, on a
   detached HEAD or a missing branch. A caller-supplied `target` is rejected, as with `verdict`;
   everything after the claim reads `target` from `job.json`. Why: facts come from the system,
   not the model, the same as timestamps and verdicts. This is the CLI's first git call; it's
   tested against a temp repo.
4. Merge when the checkout isn't on the target? → **Stop, never switch.** The orchestrator checks
   the main checkout is on the job's `target` before merging; if not, it releases the lock and
   records `merge.failed reason='checkout is on <x>, job targets <target>'` (stage
   `needs-human`). The human switches branch and retries with `/factory approve <id>`. Why: the
   main checkout is the user's working tree, maybe with uncommitted work; `merge.failed` makes
   the wait visible on Andon and reuses the existing retry path.
5. Jobs with no recorded `target` (claimed before this change)? → **`job.json` `target: null`,
   and the skill falls back to resolving `merge.target` from the current config whenever it
   needs the branch** (default `current`: the checkout's branch). The contract doc states this
   beside the field; `docs/upgrade.md` adds "merge or settle live jobs before upgrading". Why: a
   hard-coded `main` fallback is wrong for Minerva (`master`); before this change each project
   used one branch and the checkout had to be on it, so the fallback is right in both. Decision
   1's freezing doesn't hold for these legacy jobs; Decision 4's merge check still guards them.
6. Does Andon show it? → **Yes, in the job drawer only:** `factory/<id> → <target>` beside the
   branch; nothing when `target` is `null`; the card is unchanged. Why: "where will this land?"
   is a per-job detail, and the drawer is where those live; the card's layout stays put.

## Scope
- In:
  - `packages/contract`: `merge.target` in config parsing and validation (unknown keys inside
    `merge` rejected); `target` on `job.claimed`, resolved by the CLI via git and refused on a
    detached HEAD or a missing branch, rejected when a caller supplies it; `target` in the
    `job.json` projection (`null` for logs without it).
  - `packages/cli`: `job.claimed` resolution; `doctor` validates `merge`.
  - `packages/templates`: the skill uses the job's `target` for the worktree base, the spawn
    card (`base: <target>`), the merge precondition and its `merge.failed` reason, the post-merge
    check, bookkeeping, rework, and the legacy `null` fallback; the Customize interview and its
    refusal rules cover `merge.target`. Agent templates and the default overlay role files
    (`overlays/factory/roles/{ui,contract}.md`) diff and log against `<base>` from the card,
    never a literal `main`.
  - `apps/andon`: the drawer line; the UI's `Job` type gains `target`.
  - Docs: `docs/contract/v1.md` (config key, event field, snapshot field, card field, the
    runner rule "never the target branch", the legacy fallback, the `current` name caveat),
    `docs/upgrade.md` (settle live jobs first), and the README wherever it says jobs merge into `main`.
- Out:
  - Any other merge policy (squash, PRs, pushing). Only `target` lands under `merge`.
  - A per-job target override on `/factory <feature>` or `next`.
  - Escaping a branch literally named `current`.
  - Auto-switching the main checkout's branch.
  - Changing the card in Andon.
  - This repo's installed copy and overlay (`.claude/`, `factory/`, including
    `factory/roles/{ui,contract}.md`): promoted afterward by `factory upgrade` and a human edit.

## Acceptance sketch
- With no `merge` key, a job claimed while the checkout is on `master` records `target: master`,
  branches from it, its reviewers diff against it, and it merges into it.
- `"merge": { "target": "develop" }` makes a job claimed from any branch target `develop`; a
  claim fails, writing nothing, if `develop` doesn't exist.
- With `current` on a detached HEAD, the claim fails, writing nothing, with a one-line reason.
- `job.claimed` with a caller-supplied `target=` is rejected.
- `doctor` fails on an unknown key inside `merge`, or on a `target` that isn't a non-empty
  string; `customize` refuses the same.
- A log without `target` projects `target: null`, and the skill's fallback is documented.
- Merging while the checkout is on another branch records `merge.failed` naming both branches,
  and never runs `git checkout`.
- The rendered skill and agents contain no literal `main` as a branch; a render test fails on
  the old text.
- The Andon drawer shows `factory/<id> → <target>`, and nothing extra when `target` is `null`.
- Gate green.

## Contract calls
"Add the optional `config.json` key `merge` (only `target`: `"current"` or a branch name;
default `"current"`), the optional CLI-resolved `target` field on `job.claimed`, the `target`
snapshot field in `job.json` (`null` when the log has none), and the card's `base` field, and
change the runner rule from 'never `main`' to 'never the job's target branch'", approved by
the user on 2026-10-23. All additive within v1. The job must update `docs/contract/v1.md` to match.

## Open
None.
