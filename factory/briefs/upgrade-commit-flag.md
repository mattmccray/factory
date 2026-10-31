# `factory upgrade --commit`

- Status: ready
- Sources: packages/cli/src/install.ts (`upgrade`), scripts/promote.ts, docs/contract/v1.md ("`init` and `upgrade`"), docs/upgrade.md
- Date: 2026-10-31

## Intent
After `factory upgrade`, the user commits the installed copy by hand, and has to pick out the
upgrade's files from anything else in the working tree. `factory upgrade --commit` commits exactly
the files that upgrade wrote or deleted (plus `factory/managed.json`) in one commit, and leaves
everything else in the working tree and index alone.

## Decisions
1. Which commands get `--commit`? → **`upgrade` only.** Why: `init` also appends to `.gitignore`
   (which may hold the user's uncommitted edits) and may write a default `config.json`, and a first
   install is usually reviewed by hand before committing. `upgrade` touches only managed files and
   `managed.json`. `init --commit` is deferred.
2. Commit message? → **`chore(factory): upgrade factory <old> -> <new>`**, mirroring upgrade's
   summary line (old version from the old `managed.json`, new from `VERSION`; reads right for a
   same-version re-render). No `Co-Authored-By` trailer (the CLI commits, not an agent), and no
   message-override flag. Why: both versions are known, `chore` stays out of the release
   changelog, and `git commit --amend` covers custom wording.
3. Refusals before writing? → **With `--commit`, refuse (writing nothing, one-line reason) when the
   project root isn't in a git work tree, when HEAD is detached, or when a merge, rebase,
   cherry-pick, or revert is in progress.** No branch requirement and no clean-tree requirement.
   Without `--commit`, none of these checks run. Why: the contract says a refusal writes nothing,
   and a pathspec commit can't happen in those states; other projects legitimately upgrade on any
   branch, and leaving unrelated changes alone is the point.
4. The commit fails after writing (a hook, signing, no `user.name`)? → **No rollback, exit 1, one
   line** naming the upgrade's summary, git's first error line, and "commit the upgraded files by
   hand". Hooks are never bypassed (no `--no-verify`). Nothing changed (0 written, 0 removed,
   `managed.json` unchanged) → no commit, exit 0, the usual summary plus `nothing to commit`.
   Why: the written install is consistent and passes doctor; restoring old bytes is riskier and
   would desync the install from the CLI that ran; a project's hooks get their say.
5. Does `bun run promote` switch to `--commit`? → **No, promote stays as it is.** Why: promote
   deliberately commits all of `.claude/` and `factory/`, including the overlay hand edits made in
   the same step (CLAUDE.md, "Promotion"), under `chore(factory): promote vX.Y.Z`; `--commit` would
   drop those edits. Keeps this job to `packages/cli`, the contract, and docs.

## Scope
- In: `factory upgrade [--force] [--commit]` (flags in either order, `--force --commit` allowed),
  from both the source CLI and the release bundle; its usage line; the contract
  (docs/contract/v1.md, "`init` and `upgrade`" and the CLI synopsis); a line on `--commit` in
  docs/upgrade.md, "Upgrading a project"; tests.
- What is committed: exactly the paths upgrade wrote, the paths it deleted, and
  `factory/managed.json` when rewritten, as one pathspec commit. Other staged and unstaged changes
  stay exactly as they were (still staged, still unstaged); untracked new managed files are
  included.
- Out: `init --commit` (deferred); a message-override flag; any branch or clean-tree requirement;
  pushing; changing `scripts/promote.ts` or the self-upgrade docs.

## Acceptance sketch
- `factory upgrade --commit` in a git repo with a pending upgrade makes one commit
  `chore(factory): upgrade factory <old> -> <new>` (no trailer) containing exactly the written
  files, the deleted files, and `managed.json`, and prints the summary line plus the commit's
  short sha.
- A file the user had staged or modified elsewhere (e.g. `src/x.ts`, or `factory/config.json`) is
  not in the commit and keeps its staged/unstaged state afterward.
- A reviewer removed from `reviewers` → its agent file's deletion is in the commit; a reviewer
  added → its new agent file is in the commit.
- Nothing to upgrade → no new commit, exit 0, summary plus `nothing to commit`.
- Not a git work tree, detached HEAD, or a merge/rebase/cherry-pick/revert in progress → exit 1,
  one-line reason, no file written.
- A pre-commit hook that rejects → files stay written, `doctor` passes, exit 1 with one line naming
  the summary and git's error; hooks are not bypassed.
- Plain `factory upgrade` (no `--commit`) behaves exactly as before, including outside git.
- Any argument other than `--force` / `--commit` is still a usage error.

## Contract calls
"`upgrade [--force] [--commit]`: `--commit` commits exactly the files upgrade wrote or deleted and
`managed.json` as `chore(factory): upgrade factory <old> -> <new>`, with the refusals and failure
behavior in Decisions 3–4", approved by the user on 2026-10-31. Additive within v1. The job must
update docs/contract/v1.md ("`init` and `upgrade`" and the CLI synopsis) to match.

## Open
None.
