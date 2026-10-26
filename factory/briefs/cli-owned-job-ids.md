# CLI-owned job ids

- Status: ready
- Sources: the weakly-todos duplicate `005` incident (two parallel sessions claimed `005-week-view-pager` and `005-links-footer`), `packages/cli/src/core.ts`, `packages/contract/src/store.ts`, `docs/contract/v1.md`
- Date: 2026-10-26

## Intent
Job numbers are meant to be a unique sequence, but today the orchestrator computes them itself,
and nothing in the CLI keeps two sessions from taking the same number. The CLI becomes the only
thing that hands out job numbers. The orchestrator passes a slug, and the CLI prints back the full id.

## Decisions
1. Shape of the claim → **a new `claim <slug> [brief=…] [issue=…] [maxRound=…]` subcommand that
   prints only the full id; `event` no longer accepts `job.claimed` at all.** Why: there is one
   rule, so `claim` is the only way to create a job and `event` only takes ids that already exist.
   `event`'s output (the new stage) stays the same. The user said the factory is pre-1.0 alpha,
   so a clean break is better than keeping the old form around for compatibility.
2. Full ids → **never accepted: `claim` takes a slug only, with no `--id` override.** Why: tests
   get predictable numbers from a temp `factory/` root seeded with dirs, and old jobs are never
   re-created. An override is the same "number picked outside the lock" path that caused the
   incident.
3. Locking → **nested: `claim` takes its own `factory/jobs/.claim.lock` (an `mkdir` with the same
   30 s stale rule as `.events.lock`), held only across scan → pick → create dir → first event.
   The skill keeps `factory/.lock` around the whole claim step (overlap check, `claim`,
   `feature.md`, backlog tick).** Why: if `claim` took `factory/.lock` it would deadlock against
   its own caller. The inner lock keeps numbers unique even when a session gets the outer lock
   wrong. The outer lock is still needed for the backlog, which the CLI can't see. Andon already
   ignores dirs that don't match the job-id pattern.
4. Slug validation → **`^[a-z0-9]+(-[a-z0-9]+)*$`, at most 40 characters. Anything else is
   refused with a one-line reason, and nothing is written. "2–4 words" stays as guidance in the
   skill, not a CLI rule.** Why: a word-count check would refuse fine names like this repo's own
   `011-readme`. The cap keeps branch and worktree names short, and the pattern refuses `--x` and
   `x-`, which the current id pattern lets through.
5. Repeated slug → **refused when a live job already has that slug, meaning its `job.json` stage
   is not `merged` or `abandoned`. The error names that job: `slug <slug> is live as <id>`. When
   the earlier job is settled, the claim goes ahead under a new number. A dir with no readable
   `job.json` (legacy) counts as not live.** Why: this catches one session claiming the same work
   twice, the first weakly-todos failure. Redoing finished work still works, and old projects
   never get stuck.
6. Numbering and existing duplicates → **next = highest number + 1. Gaps are never filled, and
   past `999` the claim is refused. Existing duplicate numbers keep working untouched. `doctor`
   adds a check that reports each number held by more than one dir as a `note` (never `FAIL`):
   `note: job number 005 is used by 005-links-footer, 005-week-view-pager`.** Why: old numbers
   live on in branches, merge commits, and briefs' `- Job:` lines, so reusing one makes history
   ambiguous. A duplicate can't be fixed by renaming (that breaks the branch, the worktree, and
   the log's `id`), and a `FAIL` would block `customize` commits on those projects for good.
7. Versioning → **stay on `factory/v1`; this is a single approved break, recorded as a contract
   call and as a dated line in `docs/contract/v1.md` § Versioning.** Why: the log format doesn't
   change, so every existing `events.jsonl` and `job.json` stays valid v1. A general "breaking
   changes are fine before 1.0" policy is a separate decision and is out of this job.

## Scope
- In: the `claim` subcommand in `packages/cli`, in both the source CLI and the bundled installed
  CLI, with the claim logic, number picking, slug checks, and `.claim.lock` in
  `packages/contract` (the store). `target` resolution moves from `event` to `claim`, with the
  same refusals. `event` refuses `job.claimed` with a one-line reason pointing at `claim`. The new
  doctor duplicate-number `note`. Usage lines for both CLIs. The skill template
  (`packages/templates/assets/skill/SKILL.md`): "Running jobs side by side" and "Commands" stop
  telling the orchestrator to compute ids. The claim step runs `claim <slug> …` under
  `factory/.lock` and reads the printed id, the brief's `done`/`draft` refusals still come before
  claiming, and render tests pin the new text. `docs/contract/v1.md`: CLI section, job-id rule,
  the uniqueness guarantee, the `.claim.lock` in the file layout and Concurrency, the doctor
  check, and the Versioning line. Any README/docs command that shows the old claim form.
- Out: editing anything under `factory/` or `.claude/` (it ships through `factory upgrade`,
  run by a human after merge); renumbering or repairing existing duplicate jobs; a `--id`
  override; a general pre-1.0 versioning policy or any `CLAUDE.md` edit; changing the
  `job.claimed` record's fields or the log format; filling number gaps.

## Acceptance sketch
- `claim week-view-pager` in a project whose highest job is `004-…` creates
  `jobs/005-week-view-pager/` with `events.jsonl` (first line `job.claimed`, with `target`
  resolved as before) and `job.json`, and prints exactly `005-week-view-pager` on stdout,
  exit 0. The printed id is the dir's name and the log's `id`.
- An empty `jobs/` (or none) gives `001-…`. Gaps aren't filled: with `001` and `004`, the next is `005`.
- Many concurrent `claim`s (in-process and as separate processes) against one root all succeed
  with distinct, consecutive numbers.
- A bad slug (uppercase, `--x`, `x-`, `a_b`, 41+ characters, empty) is refused with one stderr
  line, exit 1, and nothing is created. A slug held by a live job is refused, naming that job.
  The same slug after that job is `merged` or `abandoned` is accepted under a new number.
  Past `999`, the claim is refused.
- A `merge.target` refusal (detached HEAD, missing branch, disallowed name) refuses the claim
  with nothing written, and no number is used up.
- `event <id> job.claimed …` exits 1 with a reason naming `claim`, and writes nothing.
- `doctor` on a project with `005-a` and `005-b` prints a `note` naming both and still exits 0
  when nothing else fails.
- A stale `.claim.lock` (older than 30 s) is broken; Andon's board ignores the lock dir.
- The rendered skill never tells the orchestrator to compute an id; it runs `claim` and uses the
  printed id from then on.
- `docs/contract/v1.md` documents all of the above in the same diff; `bun run test && bun run check` is green.

## Contract calls
"`job.claimed` is written only by the new `claim <slug>` command, which picks the job number;
`event` refuses `job.claimed`. Within `factory/v1`, as a single approved pre-1.0 break; the log
format and `job.claimed`'s fields don't change," approved by the user on 2026-10-26. The job
must update `docs/contract/v1.md` (CLI, job id, Concurrency, doctor, and a dated line in
Versioning) to match.

## Open
None.
