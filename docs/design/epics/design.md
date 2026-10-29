# Epics: design

- Status: accepted by Matt, 2026-10-29 (`/factory explore`, this session)
- Mock-ups: `epics-overview.html` (interactive; open it in a browser), `overview.png`,
  `panels.png`, `panel-board.html`, `panel-inspector.html`, built on
  `../andon-overview/chosen/` and the compact merged token of job 038
- Sources: Matt's notes from running multi-brief work with `/goal` (2026-10); the multi-brief
  explore of 2026-10-28 (`e0fc4f9`: backlog-open-only, job-archive, andon-reads-archive,
  job-prune, run one at a time as jobs 044–048); docs/decisions.md (decisions 3, 4, 8, 9, 11);
  docs/contract/v1.md ("File layout", "`events.jsonl`", "Transitions the CLI enforces",
  "`job.json`", "Runners"); packages/templates/assets/skill/SKILL.md and explore.md;
  docs/design/andon-overview/design.md

## Why

Explorations often end in several briefs with a natural order, and today they are run one at a
time by hand, with the order living only in prose and in backlog line order. An **epic** collects
those briefs, runs them with as much parallelism as their dependencies allow, and drives them to
done, doing everything it can to avoid escalating, including resolving merge conflicts itself
instead of handing them to a human.

Matt approved changing the factory's existing constructs (the contract, events, layout, and
skill) for this work; where these decisions differ from earlier ones, these take precedence. Every
contract change they need is additive (a new event, a new optional field, a new config key, new
files), so it stays within `factory/v1`.

## Decisions

These bind every brief below. Each brief cites them by number and records only its own slice.

1. Is an epic a job whose work is running other jobs, or a new kind of thing? → **A new
   first-class thing, kept thin: a tracked plan file (written by `explore`, next to the briefs)
   that lists the member briefs and their dependencies; a small CLI-written event log of its own;
   and member jobs that stay ordinary jobs, with one new back-reference to their epic.** Why: a
   job's stages don't fit an epic, its work isn't a reviewable diff, one member's escalation
   would stall the parent and every independent member, and on the board it would look like one
   stuck card. This departs from decision 8's "fixed: lifecycle stages, event types, file layout
   and CLI"; Matt approved changing those constructs for this work (2026-10-29), so new decisions
   here take precedence.
2. Does an epic have its own integration branch? → **Yes.** Starting an epic resolves its target
   with `claim`'s rule (`merge.target`), creates branch `factory/epic/<slug>` from it and a
   worktree at `factory/.worktrees/epic-<slug>/`. Each member job is claimed with the epic branch
   as its target: it branches from, is reviewed against, and merges into the epic branch, in the
   epic's worktree. A member is claimed only once every member it depends on has merged into the
   epic branch. The epic brings in its target's changes before claiming each member and again
   before landing; when every member has merged it runs the gate and lands with one `--no-ff`
   merge into its target from the main checkout. Why: the target never holds half an epic, and
   abandoning one is deleting one branch; member merges never touch the main checkout (no
   "checkout is on `<x>`", no waiting on the user's uncommitted work, no global `factory/.lock`);
   one merge commit tells the story; and in this repo nothing reaches `main` mid-epic, so no
   self-upgrade happens partway (decision 11, applied to a whole epic). Accepted cost: value lands
   only at the end, and catch-up merges can conflict (handled as in the conflict decision).
3. Who drives the member jobs? → **One session drives the epic and all its members**, running
   each member's loop itself, interleaved, with every agent spawned in the background; when an
   agent returns it advances that job, and it claims the next member whose dependencies have
   merged. **Everything needed to continue is on disk** (the plan file, the epic's log, the
   members' logs), so `/factory epic resume <slug>` continues from any session
   after the driver dies, runs out of context, or is closed. **A new overlay key caps how many
   members run at once (default 3).** The skill's "one job per session" becomes "one job, or one
   epic, per session". Why: an orchestrator is light (CLI events and first lines; agents do the
   heavy work), so one session can carry several jobs and resume covers the worst case; Matt
   watches and steers one thread, and every member's `session` links to it; no job-loop question
   (overlap check, abandoned brief) is stranded in a headless session; and it stays
   harness-neutral (decision 9). Ruled out for now: a dispatcher launching one headless session
   (`claude -p`) or one T3 Code thread per member; either could come later as another driver of
   the same plan file and log.
4. Who resolves a merge conflict, and what checks it? → **The job's own builder, then a full
   review round and the approver.** On a conflict the orchestrator aborts the merge and logs a new
   event (`merge.conflicted`) that moves the job from `approve` to `build` with a
   fresh review budget (`maxRound = round + 2`, as for a rework). The builder is resumed with a
   generated note: merge the base into your branch in the job worktree, resolve keeping both
   sides' intent, run the gate, update `build.md`, commit. Then a normal review round, the
   approver, and the merge again. After two automatic conflict passes on one job, the next
   conflict escalates as `merge.failed` does today. A conflict while bringing the target into the
   epic branch (catch-up, or right before landing) is resolved by a **sync job** the epic claims
   inside itself, with a generated `feature.md` ("merge `<target>` into the epic branch and
   resolve"), which runs the normal loop and merges into the epic branch. Why: the builder has the
   job's context, so resolving is one more resume; a full round keeps "everything that merges was
   reviewed", and conflict resolution is where subtle bugs (a silently dropped side) creep in;
   reviewers whose area is untouched simply PASS. Ruled out: a gate-only check after resolution.
5. Does automatic conflict handling apply only inside epics? → **No: to every job, standalone
   ones included, and it is the first brief in the split.** For a standalone job the orchestrator
   aborts the failed merge in the main checkout, releases `factory/.lock`, logs `merge.conflicted`,
   and resumes the builder, which merges the target into the job branch in the job worktree. A
   non-conflict failure (such as "checkout is on `<x>`") still logs `merge.failed` and goes to
   `needs-human`. The overlap check stays as it is for now. Why: standalone jobs are where
   conflicts happen today (sessions side by side), "minimize escalation" shouldn't depend on
   membership, and the piece stands alone and is useful at once.
6. What happens when a member escalates (approver `ESCALATE`, budget exhausted, no file, conflict
   past the limit)? → **Strict: the member goes to `needs-human` exactly as a standalone job does,
   its dependents are not claimed (shown as blocked on it), and independent members keep running
   until nothing else can; then the epic shows as waiting on Matt, not stuck.** Matt `approve`s,
   `rework`s, or `abandon`s the member in the epic's session (or a resumed one) and the epic
   continues. Abandoning a member others depend on makes the epic ask whether to drop those
   dependents from the plan or abandon the epic. The epic never auto-retries or overrides an
   escalation. Escalations are reduced up front instead: every member brief is fully interviewed
   before the epic starts, and the plan file can give a member a larger `maxRound`. Why: an
   approver's `ESCALATE` is a judgment that a human decision is needed; overruling it would loosen
   the gate, which the overlay outcome rule forbids a role rule from doing. Revisit if minor
   escalations turn out to deserve an automatic retry.
7. How does an epic land? → **Automatically when the gate is green; a red gate becomes a fix job
   inside the epic.** When every member has merged: catch up with the target (a conflict → a sync
   job, decision 4); run the gate in the epic worktree; if green, take `factory/.lock`, check the
   main checkout is on the target, `--no-ff` merge with a message naming the epic and listing its
   jobs, remove the epic worktree and branch, do the bookkeeping, release the lock, and mark the
   epic done. If red, claim a **fix job** in the epic (generated `feature.md`: "make the gate
   green on the epic branch", with the failing output), run it through the normal loop into the
   epic branch, and start landing again; if the fix job escalates, the epic waits on Matt
   (decision 6). If the main checkout isn't on the target, the epic waits on Matt with "checkout
   is on `<x>`" and never switches branches; resuming retries. **Member briefs are marked `done`
   (with their `- Job:` lines) at landing, not when each member merges into the epic branch.**
   Why: every member was already reviewed and approved, as a standalone `APPROVE` merges without
   asking; a human step at the end would make every epic an escalation by design; a red gate after
   all members merge almost always means two members don't fit together, which a builder can fix
   under review; and the target never says "done" for work it doesn't have yet.
8. Where does the plan live, and how is an epic produced and started? → **A tracked markdown
   plan file in its own folder, `factory/epics/<slug>.md`,
   with `Status: draft | ready | done | abandoned` (`abandoned` added in brief `epic-skill`, decision 5), a `- Landed: <short sha> (<YYYY-MM-DD>)` line written
   only at landing, an Intent, and a `## Members` list of brief slugs, each with optional
   `after: <slug>[, <slug>]` and `maxRound: <n>`.** Members with no path between them may run in
   parallel. Live state (running, blocked, waiting) is never written to the file; it comes from the
   epic's log. **Members are briefs only, each `ready` before the epic starts** (generated sync and
   fix jobs aren't plan members and need none). **`explore` writes the plan** when its size check
   splits an idea: it proposes the `after:` edges from what each brief touches, Matt confirms, the
   briefs are interviewed one at a time, and Finish marks all of them ready and appends **one**
   backlog line for the epic (`— epic: factory/epics/<slug>.md`), not one per brief. `explore`
   can also group existing ready briefs into a plan, replacing their backlog lines with the
   epic's one. **`/factory next` (or `/factory epic <slug>`) on an epic line starts the epic**;
   the line is ticked `→ epic <slug>` while it runs and removed at landing; member jobs never get
   backlog lines. Out for now: hand-editing a running epic's plan; changes go through `explore`,
   and a running epic picks up added members at its next scheduling step (removal only as in
   decision 6). Why: briefs and plans are different things, Andon can watch one folder, and the
   brief/job split (intent tracked, state in a log) carries over.
9. How does Andon show an epic? → **As in the mock-ups in `docs/design/epics/`
   (`epics-overview.html`, `overview.png`, `panels.png`), accepted by Matt on 2026-10-29.** A
   running epic gets a **sub-lane** directly under its project's lane (same six columns; an
   indented gutter with an elbow connector and a faint tint), holding only its member jobs, with
   generated jobs tagged `sync` / `fix`. The sub-lane **gutter** has three lines: the epic name
   with a status dot; progress ("3/6 merged · 2 running · 11h 40m"); and what's waiting ("1
   blocked on 052 · 1 queued", "Landing…", or in red "Waiting on you: checkout is on `<x>`").
   **Members merged into the epic branch** use the compact one-line merged token (job 038) with a
   dashed green edge and a branch-merge **icon** before the time, with a tooltip (and label)
   "Merged into `factory/epic/<slug>` · lands on `<target>` with the epic"; no text badge.
   **Queued and blocked members are never ghost tokens**, only gutter counts and inspector rows.
   The **epic inspector page** (from the gutter name) has a state pill, `factory/epic/<slug> →
   <target>`, timing, a thin progress bar by member state, a **Members** list in plan order (each
   with its `after:` edges, state, and job link), a **Generated** group for sync and fix jobs, the
   plan file and member briefs as documents, and, when the epic is waiting on Matt, a red box with
   the note and the `/factory epic resume <slug>` command to copy; a member job's page links back
   to its epic. **Trouble first:** an escalated member is an ordinary needs-human token and
   counts once; an epic waiting on Matt for an epic-level reason (landing blocked) counts as one
   more needs-human item and turns its gutter red. Andon stays read-only. Why: Matt sees members
   move through the stations instead of one stuck card, and the gutter carries the epic's state.
10. The name? → **Epic.** `/factory epic <slug>`, `factory/epics/<slug>.md`, branch
    `factory/epic/<slug>`. Why: it reads cleanly in every sentence the factory says ("the epic is
    waiting on you", "the epic landed on main", "a member of the epic"), it's short, and humans
    and models alike already know it as a large body of work split into pieces. Considered:
    campaign (accurate, collision-free, a bit grand), convoy, plan (half the thing, and the most
    overloaded word for model readers), track (a verb, and collides with "issue tracker"), train
    (reads as model training), lot, work order, assembly, batch, slate. Matt set aside the word's
    literary connotations for its clarity.

## Briefs

Epics don't exist until these land, so this set runs as standalone jobs in backlog order (as
044–048 did), with a self-upgrade after 1 and after 3 so later jobs use conflict handling and the
new skill.

| # | brief | delivers | after |
|---|---|---|---|
| 1 | `merge-conflict-rework` | decisions 4 and 5 for every job: the `merge.conflicted` event, the conflict count and two-pass limit, the skill's Merge step, the builder's conflict note | — |
| 2 | `epic-cli` | the epic in the contract and CLI: plan file format and parser, the epic's runtime log and snapshot, its events, `epic start` / `show` / `next`, `claim … epic=<slug>`, the `epic.maxParallel` key (default 3), `doctor` and `archive`; an "Epics" decision in `docs/decisions.md` and an amended decision 8 | 1 |
| 3 | `epic-skill` | `/factory epic`, `resume`, driving several members, sync and fix jobs, landing and its bookkeeping, `next` on an epic line, `explore` writing plan files and one backlog line per epic | 1, 2 |
| 4 | `andon-epics-service` | the Andon service reads plan files and epic logs and serves epics with the board, plus an epic endpoint | 2 |
| 5 | `andon-epics-ui` | decision 9 and the mock-ups: sub-lanes, gutters, "in epic" tokens, the epic inspector page, the epic-level needs-human count (the Mac app's badge too) | 4 |
