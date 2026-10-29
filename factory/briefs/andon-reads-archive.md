# Andon reads the job archive

- Status: ready
- Sources: `/factory explore job-archive` on 2026-10-28 (split from it);
  factory/briefs/job-archive.md; packages/andon-service/src/index.ts (`board`, `docs`, watchers,
  debounce); docs/contract/v1.md ("Andon service"); docs/decisions.md (decisions 5, 10)
- Date: 2026-10-28

## Intent
Once finished jobs are archived on the `factory/archive` branch, Andon should show them even when
their local dir is gone: after a prune, or on a fresh clone that has fetched the archive. The
Andon service reads archived jobs straight from the branch, so the Settled sheet and the
inspector keep every job's history with no checkout and no UI change. Needs `job-archive`
merged first; `job-prune` comes after this, so a pruned job never drops out of Andon.

## Decisions
1. Who changes → **Only the Andon service.** For each job on the `factory/archive` branch with no
   local dir, it reads the archived files, re-projects `job.json` from `events.jsonl` with the
   contract code (a legacy job uses its archived `job.json`), and adds it to the project's
   board payload in the **same shape** as a local job. A local dir always wins over the archived
   copy. Why: archived jobs are terminal, so the UI already lists them as settled (Settled sheet,
   inspector, timing).
2. A marker → **None: no Andon UI change, no "archived" field, no payload or endpoint shape
   change.** Why: a marker means a contract change to the board endpoint for little gain.
3. Documents → **The docs endpoint serves an archived job's markdown from the branch,** in the
   same reading order and with the same paths as a local job.
4. Live updates → **The service watches the ref without polling:** the `refs/heads/factory/`
   dir and `packed-refs` under the git common dir (`git rev-parse --git-common-dir`, so linked
   worktrees work), so an archive commit or a fetch shows up live. A missing branch is fine (no
   archived jobs).
5. Read-only → **Only read-only git commands, with fixed arguments and no shell.** The service
   stays read-only (decision 10 of docs/decisions.md).
6. Performance (required) → **Archived projections are cached in memory per project, keyed by
   the branch's tip sha.** A `jobs/` change (the hot path while a job runs) reuses the cache and
   runs **no git command**. A ref move (or startup) rebuilds it with one `git ls-tree` and **one
   `git cat-file --batch`** for every file, never one process per file. Why: pushes are per
   project and the archive moves rarely, so the hot path stays as cheap as today with a dozen or
   two projects. Sending settled jobs on every `board` event is a separate, pre-existing cost:
   `factory/briefs/settled-on-demand.md`.

## Scope
- In: `packages/andon-service` (archive reading, projection, cache, ref watch, docs endpoint);
  its tests; docs/contract/v1.md "Andon service" (archived jobs in `board` and `docs`, the ref
  watch).
- Out: any Andon UI or Mac app change; writing the archive (`job-archive`); pruning
  (`job-prune`); the settled-payload split (`settled-on-demand`); fetching for the user.

## Acceptance sketch
- With a job present only on the branch, `GET /projects/<pid>/board` includes it with the same
  projected `job.json` the local copy produced before it was removed; its docs come back in the
  same order and paths.
- With the job both local and archived, the local copy is served.
- Moving the ref (a new archive commit, or `update-ref` from a fetch) sends a `board` event with
  the new job, with no polling.
- A `jobs/` change runs no git command; a ref move runs one `ls-tree` and one `cat-file --batch`
  (a test counts the invocations).
- No branch, or a project that isn't a git repo, behaves exactly as today.
- docs/contract/v1.md "Andon service" describes archived jobs; additive within v1. The gate
  passes.

## Contract calls
None beyond describing, in docs/contract/v1.md "Andon service", that `board` and `docs` include
archived jobs in the existing shapes (additive).

## Open
None.
