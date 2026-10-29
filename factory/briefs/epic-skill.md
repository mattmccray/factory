# The skill runs epics, and explore writes them

- Status: done
- Job: 053-epic-skill (merged a2619ac, 2026-10-29)
- Sources: docs/design/epics/design.md (decisions 2–8, 10; brief 3 of 5); factory/briefs/epic-cli.md
  (the CLI this drives) and merge-conflict-rework.md (the conflict path it reuses); `/factory
  explore` on 2026-10-29; packages/templates/assets/skill/SKILL.md (Running jobs side by side,
  the loop, Merge, Commands, Customize, Ground rules) and explore.md (Size check, Finish)
- Date: 2026-10-29

## Intent
The `/factory` skill learns to drive an epic end to end from one session: start or resume it, claim
members as the CLI's `epic next` allows, drive several job loops at once, merge members into the
epic branch, handle catch-up conflicts and a red gate with sync and fix jobs, land the epic, and do
its bookkeeping. `explore` learns to write a plan file when it splits an idea, so a multi-brief
exploration becomes one backlog line that runs as one epic.

## Decisions
1. The command surface? → **`/factory epic <slug>` starts or resumes, idempotently: `epic start`
   when the epic hasn't started; when it is `running` or `waiting`, log `epic.resumed` and take
   over driving. `/factory next` on an epic line does the same and ticks the line
   `→ epic <slug>`. `/factory epic abandon <slug> <reason>` ends it, with a job abandon's two
   questions (confirm; keep or delete the branch), then its bookkeeping. `/factory approve`,
   `rework`, and `abandon <id>` on a member are handled by the session driving its epic, and
   approve merges into the epic branch, not the target; any other session refuses with "<id> is
   in epic <slug>; run it in the epic's session, or `/factory epic <slug>` to take it over".**
   Andon's copied command (brief 5) is `/factory epic <slug>`, not the mock-up's
   `/factory epic resume <slug>`. Why: one verb drives an epic whatever its state; and routing
   member commands through the driving session guarantees one actor merges into the epic branch,
   so no epic-level lock is needed.
2. When does the epic catch up with its target? → **Before each member claim and before landing,
   and only when the target has moved** (`git merge-base --is-ancestor <target>
   factory/epic/<slug>` fails): the driver merges the target into the epic branch in the epic
   worktree, as a merge commit, never a rebase. **On a conflict it aborts and claims a sync job**
   (`kind=sync`; generated `feature.md` naming the target, its sha, and the conflicting paths).
   **While a sync job is live no new member is claimed; running members keep going** (one that
   merges first makes the sync job conflict, which brief 1's path handles). When the sync job
   merges, claiming resumes. Before landing, the same check, then the gate (design decision 7).
   Why: new members start from the newest base; skipping the merge when nothing moved keeps the
   branch quiet; pausing only new claims stops conflicts compounding without stalling work in
   flight.
3. The overlap check and the abandoned-brief question? → **Both are asked once, when
   `/factory epic <slug>` starts the epic, and never for a member claim or on resume.** At start
   the driver lists every member brief with `- Abandoned:` lines (latest attempt and reason) and
   asks once: start anyway, or revise first with `/factory explore`. It compares the epic as a whole
   (all member briefs) with live standalone jobs and other running epics, and asks once if they
   overlap. No overlap checks between members: the `after:` edges decided parallelism, and their
   conflicts are handled automatically. Why: an epic's promise is driving to done without Matt,
   and both questions are about the epic as a whole; later conflicts cost a review round, not his
   time.
4. How does `explore` produce epics? → **When the size check splits an idea into two or more
   briefs, `explore` proposes an epic by default (Matt can decline and get separate backlog lines
   as today).** On agreement it writes `factory/epics/<slug>.md` as a draft (Intent; `## Members`
   with the briefs and proposed `after:` edges from what each touches, which Matt confirms or
   changes). Each member brief is interviewed as today; its Finish marks it `ready` and commits it
   (`specs(factory): add brief <slug> (epic <epic>)`) with **no backlog line**. When every member
   is ready, `explore` plays back the plan (members, edges, what runs in parallel), and on
   confirmation sets it `ready`, appends **one** backlog line
   (`- [ ] <Title> — <done looks like> — epic: factory/epics/<slug>.md`), commits under the lock,
   and asks whether to run it now (`/factory epic <slug>`). **Grouping:** an idea naming existing
   `ready` briefs yields a plan grouping them, and their backlog lines are replaced by the epic's
   one, in the same commit; running or done briefs can't be grouped. **Resuming:**
   `/factory explore <epic slug>` resumes a draft plan at its first unfinished member; on a running
   epic it adds members (design decision 8); a `done` plan isn't reopened. Why: the default captures
   the sequencing multi-brief explorations always have, declining keeps today's behavior one word
   away, per-member commits keep an interrupted exploration resumable, and one backlog line makes
   the epic one unit of work.
5. Bookkeeping? → **A member merging into the epic branch** (in the epic worktree): `job.merged`,
   remove its worktree and branch, `archive <id>`; nothing is committed on the target (no backlog
   line; its brief waits for landing). **Landing**, under `factory/.lock` in the main checkout:
   `--no-ff` merge, then `epic event <slug> epic.landed sha=<short sha>` at once, before any
   cleanup (the `job.merged` invariant); remove the epic worktree and branch; `archive <slug>`;
   the backlog check; remove the epic's backlog line; each member brief gets `Status: done` and
   `- Job: <id> (merged <member's merge sha> via epic <slug>, <YYYY-MM-DD>)`; the plan gets
   `Status: done` and `- Landed: <short sha> (<YYYY-MM-DD>)`; one pathspec commit,
   `chore(factory): land epic <slug>`. **Abandoning**: `epic abandon`, `archive <slug>`, then under
   the lock: remove the backlog line; the plan gets **`Status: abandoned`** and
   `- Abandoned: <YYYY-MM-DD>: <reason>`; each member brief that had a job gets
   `- Abandoned: <id> (<YYYY-MM-DD>): epic <slug> abandoned: <reason>` with `Status` still
   `ready` (a new plan can reuse it); one pathspec commit, `chore(factory): abandon epic <slug>`.
   Why: the target never says done before it has the work; the landed event follows the merge at
   once so git and the board never disagree; a plan has one run (epic-cli decision 1), so an
   abandoned plan can't stay `ready` (`epic-cli` was amended to accept the `abandoned` status, and
   `doctor` skips it).

6. The rest of the skill (settled defaults, confirmed in the playback) → **The ground rule
   becomes "one job, or one epic, per session"; the driver spawns every agent in the background and
   advances each job as its agent returns; after a compaction or a resume it re-reads state from
   `epic show` and each member's `job.json`, never from memory, and spawns a fresh builder from
   files when the old one isn't alive (the rework path). It runs the thread lookup once, at start
   or resume, and passes that `session=` on `epic.started` / `epic.resumed` and on every claim it
   makes. Status lines name the epic (`archive-record · 027 review round 1: 3/4 in`). `customize`
   asks one new question, `epic.maxParallel` (recommend 3, the default; no key keeps it), with
   refusal rules matching the CLI (an object holding only `maxParallel`, a positive integer).**
   Why: these follow from the design and briefs 1–2 and need no new judgment.

## Scope
- In: `packages/templates/assets/skill/SKILL.md` (the `/factory epic` command and its loop, `next`
  on an epic line, member approve/rework/abandon routing, member merges into the epic branch,
  catch-up and sync jobs, fix jobs, landing, epic abandon, bookkeeping, the start-time questions,
  ground rules, status lines, `customize`'s new question and refusal rules) and
  `packages/templates/assets/skill/explore.md` (proposing an epic at the size check, writing and
  resuming plans, per-member Finish without backlog lines, the plan's Finish, grouping existing
  briefs); any template test that pins skill text.
- Out: the CLI and contract (brief 2, `epic-cli`, and brief 1, `merge-conflict-rework`, which this
  relies on), Andon (briefs 4 and 5), a dispatcher of headless or per-member sessions (design
  decision 3), automatic retries of escalations (design decision 6), hand-editing a running
  epic's plan, and any change to how a standalone job runs.

## Acceptance sketch
- `/factory epic <slug>` on a ready plan asks the abandoned-brief and overlap questions once,
  runs `epic start`, and drives the epic: it claims what `epic next` prints (with `session=`), runs
  each member's loop with agents in the background, and merges approved members into the epic
  branch in the epic worktree, logging `job.merged` and archiving each, with no commit on the
  target. On a running or waiting epic it logs `epic.resumed` and continues from the files.
- `/factory next` on an epic backlog line does the same and ticks it `→ epic <slug>`.
- Before each claim and before landing, the driver merges the target into the epic branch only
  when the target has moved; a conflict aborts and claims a `kind=sync` job, and no member is
  claimed until it merges.
- A member's merge conflict follows brief 1's path against the epic branch. A member escalation
  leaves independent members running and dependents unclaimed (design decision 6); an abandoned
  member others depend on makes the driver ask whether to drop the dependents or abandon the epic.
- When `epic next` prints `land`: catch up, run the gate in the epic worktree; red → a
  `kind=fix` job with the failing output; green → `epic.landing`, then under the lock the main
  checkout check (`epic.waiting` with "checkout is on `<x>`" if wrong), the `--no-ff` merge,
  `epic.landed` at once, cleanup, `archive <slug>`, and the landing bookkeeping in one commit.
- `/factory approve|rework|abandon <id>` on a member works only in the session driving its epic
  (approve merges into the epic branch); elsewhere it refuses with the one-line pointer to
  `/factory epic <slug>`.
- `/factory epic abandon <slug> <reason>` asks the two abandon questions, runs `epic abandon`
  (with `--force` when members are working, after the user confirms), archives, and commits the
  abandon bookkeeping (plan `Status: abandoned`, member briefs' `- Abandoned:` lines).
- `explore` proposes an epic when it splits an idea, writes and resumes the draft plan, commits
  each member brief without a backlog line, and finishes the plan with one backlog line; it can
  group existing ready briefs, replacing their backlog lines.
- `customize` asks about `epic.maxParallel` and refuses invalid values.

## Contract calls
None. The contract surface this uses is approved in `merge-conflict-rework` and `epic-cli`; this
brief changes only the managed skill text.

## Open
None.
