# Rename the archive branch to `factory/archive`

- Status: ready
- Sources: validating `factory archive --all` on 2026-10-29 (bare `git log factory/jobs` fails as
  ambiguous); factory/briefs/job-archive.md (decision 2; job 045); docs/contract/v1.md ("Job
  archive", job ids, `config.json` `archive`, CLI); packages/cli/src/archive.ts
  (`ARCHIVE_BRANCH`); packages/contract/src/store.ts; packages/templates/assets/skill/SKILL.md
- Date: 2026-10-29

## Intent
Job 045 put the archive on the orphan branch `factory/jobs`. Every factory project also has a
`factory/jobs/` directory on disk, so bare git commands on the branch (`git log factory/jobs`)
fail with "ambiguous argument: both revision and filename", and the name doesn't say the branch
is an archive. Renaming it to `factory/archive` fixes both, and it's cheapest now: the branch
exists only on Matt's machine (never pushed), no other project has the archive code, and nothing
reads the branch yet.

## Decisions
1. The new name → **`factory/archive` (`refs/heads/factory/archive`).** Why: it stays in the
   `factory/` namespace beside job branches `factory/<id>` (ids start with three digits, so they
   can't collide), no project has a `factory/archive` path, so bare git commands work, and it
   says what it is. Ruled out: `factory/archived-jobs` (longer, no gain).
2. The old name → **No fallback or migration code.** Nothing reads or writes `factory/jobs` as
   a branch after this job; the only existing copy (this repo's 45 archived commits) is renamed
   by hand at promotion with `git branch -m factory/jobs factory/archive`. Why: it was never
   pushed or used outside this repo, so compatibility code would guard nothing.
3. Only the branch changes → **The `factory/jobs/` directory (live job state), its gitignore
   line, the tree layout, commit messages, trailers, and the `archive` config key stay as they
   are.** The builder must tell the branch name apart from the directory path everywhere the
   string `factory/jobs` appears.

## Scope
- In: `ARCHIVE_BRANCH` and every mention of the *branch* in `packages/cli` (archive, claim's id
  read), `packages/contract`, their tests and refusal messages; the skill template
  (`packages/templates/assets/skill/SKILL.md`) and its render tests; docs/contract/v1.md ("Job
  archive", job ids, `config.json` `archive`, CLI, changelog) and the README where they name the
  branch.
- Out: the `factory/jobs/` directory and anything about live job state; migration code for the
  old name; Andon (`andon-reads-archive`, next); pruning; anything under `.claude/` or `factory/`
  (the rename of this repo's branch is the promotion step's hand step).

## Acceptance sketch
- `factory archive` writes `refs/heads/factory/archive`, and `claim` counts ids on it; nothing
  creates or reads `refs/heads/factory/jobs`.
- In a scratch factory project, bare `git log factory/archive` works.
- Every mention of the `factory/jobs/` *directory* is unchanged; `git grep` finds no remaining
  mention of `factory/jobs` as a branch in `packages/`, `docs/`, or the README.
- Tests, render tests, and docs/contract/v1.md use the new name. The gate passes.

## Contract calls
- "Rename the job archive branch from `factory/jobs` to `factory/archive`", approved by Matt on
  2026-10-29. It renames a v1 addition made on 2026-10-28 (job 045) that was never released or
  used outside this repo; the job updates docs/contract/v1.md ("Job archive", job ids, `archive`
  config, CLI) to match and notes the rename in the changelog.

## Open
None.
