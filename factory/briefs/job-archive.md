# Job archive — copy finished jobs to an orphan branch in the repo

- Status: ready
- Sources: 2026-10-23 design conversation; `/factory explore job-archive` on 2026-10-28;
  docs/contract/v1.md (layout, `config.json`, job ids, `claim`, `job.abandoned`, CLI);
  packages/contract/src/store.ts (`claimJob`); packages/templates/assets/skill/SKILL.md (Merge,
  `/factory abandon`, Customize); docs/decisions.md (decisions 3, 4, 6, 8; deferred "Andon
  across multiple machines")
- Date: 2026-10-23 (resumed 2026-10-28)

## Intent
A job's record (feature, spec, build, every review round, decision, event log) should outlive
the machine and the clone it ran on. Today `factory/jobs/` is gitignored runtime state: deleting
it, or cloning on a new machine, loses the whole history. The archive copies every finished job
into the repo itself, on an orphan branch that shares no history with the target branch, so
history travels with `git clone` / `git fetch` without adding job files to the target branch or
turning runtime state into a checkout. This is the first of three briefs: Andon reading the
archive (`andon-reads-archive`) and clearing local dirs (`job-prune`) follow it.

## Decisions
1. Where does live job state go? → **It stays where it is: `factory/jobs/` is local and
   gitignored, and the CLI is its only writer.** The archive gets a *copy* of a job once it is
   in a terminal stage. Ruled out: making `factory/jobs/` a worktree of the archive branch. Why:
   live state changes on every event, so a worktree is either committed on every event (noisy
   history, git on the hot path) or dirty most of the time, and concurrent jobs would all write
   into one shared checkout. Decisions 3 and 4 of docs/decisions.md stay untouched.
2. What does the archive live on? → **An orphan branch, `factory/jobs`,** with one directory per
   job at its root (`<id>/…`). Ruled out: a custom ref (`refs/factory/jobs`), which needs
   explicit refspecs to push and fetch and can't be browsed on GitHub. Why: browsing and sharing
   it with ordinary git commands is worth one extra branch name. `refs/heads/factory/jobs` sits
   beside job branches `refs/heads/factory/<id>` without a ref conflict; ids always start with
   three digits, so they can't collide.
3. How is it written? → **With git plumbing, never a checkout:** blobs and trees built with
   `hash-object` / `mktree` (or a temporary index via `GIT_INDEX_FILE`), `commit-tree` with the
   current archive tip as parent, then `update-ref` with the old value as a compare-and-swap
   guard; on a lost race it retries from the new tip. One commit per archived job:
   `chore(factory): archive job <id>`, with a `Factory-Job: <id>` trailer, plus
   `Merged-As: <target sha>` for a merged job (an abandoned job has none). Why: the main
   checkout's working tree, index, and `HEAD` are never touched, nothing can be left dirty, and
   two concurrent archivers are safe. The merge commit already says `Factory job <id>.`, so each
   side points to the other.
4. Which jobs, and when? → **Both terminal stages, `merged` and `abandoned`; every other stage
   (including `needs-human`, still live) is refused.** One explicit CLI command,
   `factory archive <id>`, and **the skill calls it**: in the Merge step after `job.merged`
   (before bookkeeping), and in `/factory abandon` after `factory abandon` succeeds. The CLI
   never archives on its own (`event` and `abandon` stay free of archive side effects).
   `factory archive --all` backfills every terminal job that isn't archived yet, in id order,
   and is the safety net if an orchestrator skips the step. Archiving the same job again is a
   no-op when the tree is unchanged; when it differs, it is refused unless `--force`, and a
   forced archive adds a new commit (history keeps both). A failed or disabled archive is
   reported in one line but never fails the merge or the abandon (the same rule as worktree
   cleanup). Why: an abandoned job's record is history worth keeping; the merge is run by the
   orchestrator, so the merge path has to go through the skill anyway, and calling it the same
   way after abandon keeps one trigger and one failure rule; a missed archive is late, never
   lost, because the local dir stays and `--all` catches it.
5. What gets copied? → **Everything under `jobs/<id>/` except `job.json` and lock dirs
   (`.events.lock`):** feature, spec, build, rework notes, every round's reviews *and* their
   supporting files (screenshots), decision, and `events.jsonl`. Readers re-project `job.json`
   from `events.jsonl` with the contract code. **Exception:** a legacy job with no
   `events.jsonl` keeps its `job.json`, its only state. Why: `job.json` is a disposable
   projection by contract, and an archived one could disagree with the log; screenshots are part
   of the review record, and size is no concern (this repo's 43 jobs total 3.5 MB).
6. Job ids once the archive exists → **`claim` picks the highest number across the local job
   dirs *and* the `factory/jobs` branch's top-level entries, + 1.** It reads the branch (one
   `git ls-tree`, under `jobs/.claim.lock`) whenever the branch exists, even with archiving off
   in config. With no archive branch the result is exactly today's. The live-slug check is
   unchanged (archived jobs are terminal, never live). Why: a fresh clone that has fetched the
   archive has no local dirs and would otherwise hand out `001` again, and after a prune
   (`job-prune`) local dirs no longer cover every used number; reading the branch regardless of
   config means turning archiving off later can never cause a reused id.
7. Ids across clones → **For now, one clone owns the archive.** `factory archive` reads only the
   local `factory/jobs` branch (it never fetches) and refuses to write `<id>/` when the branch
   already holds a *different* job at that id: its `job.claimed` `id` or `ts` differs from the
   local one, or, for a legacy job with no log, its tree differs. The one-line reason names both.
   Why: Matt runs factory jobs from a single clone today; ids that are unique across machines
   belong with the deferred "Andon across multiple machines" work, and the refusal keeps the
   archive correct until then.
8. Pushing and opt-in → **Archiving never pushes** (`git push origin factory/jobs` is a human
   decision, like every push), **and it is opt-in per project:** no `archive` key means off;
   `"archive": { "enabled": true }` turns it on (an object, like `merge`, so later options fit
   inside it). `parseConfig` and `doctor` validate it (`archive` holds only `enabled`, a
   boolean). `init` writes no `archive` key. `/factory customize` asks about it after
   `merge.target`, and its refusal rules learn the key. When off, `factory archive` says it is
   disabled and exits non-zero, and the skill notes that in one line and carries on; `claim`
   still reads an existing branch (decision 6). This repo turns it on by hand (or with
   `/factory customize`) in the promotion step after the merge, since jobs never touch
   `factory/`; `upgrade` and `init` never turn it on. Why: job files can contain paths, notes,
   and pasted material, and a push to a public remote makes them public; decision 6 of
   docs/decisions.md ("personal now, publishable later") makes off the right default.

## Scope
- In: `factory archive <id> | --all [--force]` in `packages/cli`; the archive's plumbing
  read/write helpers in `packages/contract` (or a sibling package), including listing the
  branch's ids for `claim`; `claimJob` counting the archive; the `archive` config key in
  `parseConfig` and `doctor`; the skill template (`packages/templates/assets/skill/SKILL.md`):
  Merge and `/factory abandon` calling `factory archive <id>`, and Customize asking about and
  validating `archive`; render tests pinning those; docs/contract/v1.md updated in the same diff
  (layout, `config.json`, job ids, `claim`, the new command, the archive's tree layout).
- Out: Andon reading the archive (`andon-reads-archive`); removing local dirs (`job-prune`);
  archiving live jobs (any stage but `merged` or `abandoned`); the CLI archiving by itself from
  `event` or `abandon`; ids unique across machines; pushing or fetching for the user; a browse
  worktree (anyone can `git worktree add` by hand); anything under `.claude/` or `factory/`
  (turning it on here is the promotion step's hand edit).

## Acceptance sketch
- In a scratch repo with archiving on and a merged job, `factory archive <id>` creates the orphan
  branch `factory/jobs` (when missing) with exactly one commit holding `<id>/` and every job
  file except `job.json` and lock dirs, with the `Factory-Job` and `Merged-As` trailers. The main
  checkout's `git status`, index, and `HEAD` are unchanged.
- An abandoned job archives the same way, without `Merged-As`. A job in any other stage is
  refused with a non-zero exit and nothing written.
- Running it again is a no-op (no new commit). A changed local file without `--force` is refused
  with a non-zero exit; with `--force`, a second commit is added.
- An id already on the branch with a different `job.claimed` (or, for a legacy job, a different
  tree) is refused, naming both.
- Two concurrent `factory archive` runs for different jobs both land; the test runs them in
  parallel.
- `--all` archives every terminal, unarchived job in id order and skips the rest.
- With no `archive` key or `enabled: false`, `factory archive` says it is disabled and exits
  non-zero; `doctor` and `parseConfig` accept `{ "enabled": true|false }` and refuse any other
  shape or extra key.
- With a `factory/jobs` branch holding a higher id than any local dir, `claim` picks the number
  after the branch's highest, with archiving on or off; with no branch, `claim` behaves as today.
- The skill template's Merge step and `/factory abandon` call `factory archive <id>` and carry
  on after a failure or a disabled archive; Customize asks about `archive`; render tests pin it.
- docs/contract/v1.md covers the layout, config key, command, id rule, and tree layout; the
  change is additive within v1. The gate passes.

## Contract calls
- "A new optional `config.json` key `archive: { enabled: boolean }`; absent means off", approved
  by Matt on 2026-10-28. Config rejects unknown keys, so it is added the way `name` and `merge`
  were: optional, additive within v1. The job updates docs/contract/v1.md ("`config.json`") and
  the skill template's Customize rules to match.
- "Job id allocation counts the job dirs plus the `factory/jobs` branch's top-level entries",
  approved by Matt on 2026-10-28. It tightens docs/contract/v1.md's "highest number among the job
  dirs + 1" rule; with no archive branch the result is the same as today, so it stays additive
  within v1. The job updates docs/contract/v1.md (job ids, `claim`) to match.
- "The `factory/jobs` branch and its tree layout (`<id>/<job files>`, no `job.json` except for
  legacy jobs) and the `factory archive` command become part of the contract", approved by Matt
  on 2026-10-28, so Andon and future tools can read it. The job adds them to docs/contract/v1.md.

## Open
None.
