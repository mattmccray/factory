# Job archive — keep finished jobs' records on an orphan ref in the repo

- Status: draft (decisions below are recommendations, not yet confirmed by Matt)
- Sources: 2026-10-23 design conversation; docs/contract/v1.md (layout, events, id allocation),
  .claude/skills/factory/SKILL.md (Merge, claim), HANDOFF.md (decisions 3, 4, 6; deferred
  "Andon across multiple machines")
- Date: 2026-10-23

## Intent
A job's record (feature, spec, build, every review round, decision, event log) outlives the
machine and the clone it ran on. Today `factory/jobs/` is gitignored runtime state: deleting it,
or cloning on a new machine, loses the whole history, and finished jobs pile up locally with no
way to clear them. The archive keeps every finished job in the repo itself, on a ref that shares
no history with `main`, so history travels with `git clone` / `git fetch` without adding job
files to `main` or making runtime state into a checkout.

## Decisions
1. Where does live job state go? → **It stays where it is: `factory/jobs/` is local and
   gitignored, and the CLI is its only writer.** The archive gets a *copy* of a job once it is
   finished. Ruled out: making `factory/jobs/` (or `factory/.jobs`) a worktree of the archive
   branch. Why: live state changes on every event (`events.jsonl` appends, `job.json`
   rewrites, `.events.lock` dirs), so a worktree is either committed on every event (noisy
   history, git work on the hot path) or left dirty most of the time (history isn't captured
   until someone commits), and concurrent jobs would all write into one shared checkout.
2. What does the archive live on? → **An orphan branch, `factory/jobs`**, with one
   directory per job at its root (`<id>/…`). Ruled out: a custom ref (`refs/factory/jobs`),
   which stays out of branch lists but needs explicit refspecs to push and fetch and can't be
   browsed on GitHub. Why: for personal tooling, being able to browse and share it with
   ordinary git commands is worth one extra branch name. (Note: the branch name `factory/jobs`
   sits beside job branches `factory/<id>`; ids always start with three digits, so they can't
   collide, but the CLI should check this.)
3. How is it written? → **With git plumbing, not a checkout:** `hash-object` / `mktree` (or a
   temporary index via `GIT_INDEX_FILE` + `read-tree` / `update-index` / `write-tree`), then
   `commit-tree` with the current archive tip as parent, then `update-ref` with the old value
   as a compare-and-swap guard. One commit per archived job: `chore(factory): archive job <id>`,
   with `Factory-Job: <id>` and `Merged-As: <main sha>` trailers. Why: it never touches the
   working tree or the index of the main checkout, it can't leave a dirty state, and the CAS
   on `update-ref` makes two concurrent archivers safe (the loser retries from the new tip).
   The merge commit on `main` already says `Factory job <id>.`, so each side points to the
   other.
4. When does a job get archived? → **An explicit CLI command, `factory archive <id>`, which
   the skill's Merge step calls after `job.merged` and before bookkeeping**, plus
   `factory archive --all` to backfill every merged job that isn't archived yet. It refuses a
   job that isn't `merged`. Archiving the same job again is a no-op if the tree is unchanged.
   If the tree differs, it is refused unless `--force` is given, and a forced archive adds a
   new commit (history keeps both). A failed archive is reported but doesn't fail the merge
   (same rule as worktree cleanup). Why: `job.merged` is the only terminal event; adding the
   archive to `factory event` would give an event append a git side effect, and the CLI is
   currently the only writer of *state*, not of git refs.
5. What gets copied? → **Everything under `jobs/<id>/` except `job.json` and lock dirs**
   (`.events.lock`). Andon and `factory show` re-project `job.json` from `events.jsonl` using
   the contract code. Why: the contract calls `job.json` a disposable projection; archiving it
   risks keeping a stale projection that disagrees with the log. Jobs without an event log
   (Minerva's legacy 001–018) are archived as is; they already show no timing.
6. Does archiving delete the local job dir? → **No. Pruning is separate:
   `factory archive --prune`** removes the local dir of a job that is archived *and* settled
   (`endedAt` older than `settleAfterHours`), only after checking that the archived tree
   matches the local files. Why: archiving is copy-only, so nothing is lost if the ref is
   wrong; pruning is the one destructive step, so it gets its own command and its own check.
7. Id allocation once local dirs can be pruned → **A new id is the next number after the
   highest id in `factory/jobs/` *or* on the archive ref.** Why: the claim step currently
   counts only `factory/jobs/NNN-*` dirs, so after a prune it would hand out an id that's
   already used. This is a required change, not an option.
8. Ids across clones/machines → **For now, one clone owns the archive (the one that runs
   jobs).** `factory archive` refuses to write `<id>/` if the ref already has a *different*
   job at that id (compare the `job.claimed` line's `ts` and `id`) and says so. Why: ids are
   allocated locally, so two clones can both create `014`; the real fix (a machine suffix in
   ids, or allocating against a fetched archive) belongs with the deferred "Andon across
   multiple machines" work, and the refusal keeps the archive correct until then.
9. Pushing → **Archiving never pushes.** `git push origin factory/jobs` is a human decision,
   like every other push. For installs in other projects, archiving is **opt-in**:
   `config.json` gets `archive: { enabled: false }` by default (`true` in this repo's
   overlay). Why: job files can contain paths, notes, and pasted material, and pushing makes
   them public on a public remote. HANDOFF decision 6 ("personal now, publishable later")
   makes off the right default for other people's projects.
10. How does Andon read it? → **The agent reads archived jobs directly from the ref**
    (`git ls-tree` / `git cat-file` on `factory/jobs`), projects them with the contract code,
    and lists them in the Settled dialog when no local dir exists. A local dir always wins
    over the archived copy. It watches the ref (`.git/refs/heads/factory/jobs` and
    `packed-refs`) without polling. Why: this is the main payoff. History is still visible
    after a prune or on a fresh clone, and the archive needs no checkout.

## Scope
- In: `factory archive <id> | --all | --prune [--force]` in `packages/cli`; archive
  read/write helpers (plumbing only) in `packages/contract` or a sibling package; id allocation
  that also checks the archive; the `archive` config key and its validation in `doctor`; the skill
  template's Merge step calling `factory archive <id>`; the Andon agent reading archived jobs
  and watching the ref; docs/contract/v1.md updated in the same diff (layout, config,
  CLI, id allocation, read rules).
- Out: archiving unmerged jobs (an escalated job that's abandoned has no terminal event;
  an `abandon` event is its own explore); ids that are unique across machines; pushing or
  fetching for the user; a browse worktree (anyone can run `git worktree add` by hand);
  promoting into this repo's installed copy (that's `factory upgrade`, after the merge).

## Acceptance sketch
- In a scratch repo with a merged job, `factory archive <id>` creates the orphan branch
  `factory/jobs` (when missing) with exactly one commit containing `<id>/` and every
  job file except `job.json` and lock dirs. `git status` in the main checkout is unchanged,
  as are its index and `HEAD`.
- Running it again is a no-op (no new commit). A changed local file without `--force` is
  refused with a non-zero exit; with `--force`, a second commit is added.
- A job that isn't merged is refused. An id that's already on the ref with a different
  `job.claimed` is refused.
- Two concurrent `factory archive` runs for different jobs both land (the CAS retry works); the
  test runs them in parallel.
- `--prune` removes only archived, settled, matching dirs; after a prune, the next claimed id
  is still higher than every archived id.
- `--all` backfills every merged, unarchived job in id order.
- With the archive disabled in config, `factory archive` says it is disabled and exits non-zero;
  `doctor` validates the key.
- The Andon agent lists a pruned job from the archive with the same projected `job.json` the
  local copy produced, and updates when the ref moves.
- The contract doc covers the new layout, config key, command, and id rule; the change is
  additive within v1. The gate passes.

## Contract calls
- New config key `archive` (additive; readers ignore unknown keys, as they already must).
- Id allocation is now defined over local dirs plus the archive ref. This tightens an existing
  rule, so the contract reviewer should check it's still additive for consumers that have no
  archive (with no archive ref, the result is the same as today).
- The archive ref's tree layout (`<id>/<job files>`, no `job.json`) becomes part of the
  contract, so that Andon and future tools can read it.

## Open
- Branch vs. custom ref (decision 2) is a taste call. Revisit if the extra branch gets in the
  way in GitHub's UI or in `git branch` output.
- Should `factory upgrade` / `init` in this repo turn `archive.enabled` on automatically, or does
  Matt set it via `/factory customize`?
- Archiving escalated-then-abandoned jobs needs a terminal "abandoned" event first; worth a
  separate explore if abandoned jobs turn out to be common.
