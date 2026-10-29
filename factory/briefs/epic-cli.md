# Epics in the contract and the CLI

- Status: ready
- Sources: docs/design/epics/design.md (decisions 1–3, 6–8, 10; brief 2 of 5); `/factory
  explore` on 2026-10-29; docs/contract/v1.md ("File layout", "`config.json`", "`events.jsonl`",
  "Transitions the CLI enforces", "`job.json`", "CLI", "Job archive"); packages/contract/src
  (contract.ts, store.ts); packages/cli/src (core.ts, archive.ts, prune.ts, install.ts:
  `GITIGNORE_LINES`); packages/andon-service/src/index.ts (what it watches)
- Date: 2026-10-29

## Intent
The factory's contract and CLI learn what an epic is, so an orchestrator (brief 3) can run one and
Andon (briefs 4 and 5) can show one: the plan file's format, the epic's own event log and derived
snapshot, the commands to start an epic, ask which members can run, and claim a member into it, and
the bookkeeping (`doctor`, `archive`, `prune`) that keeps epics as safe as jobs.

## Decisions
1. Where does an epic's runtime state live, and what identifies a run? → **`factory/jobs/epics/<slug>/`
   holds the epic's `events.jsonl` and derived `epic.json`; the plan's slug
   (`factory/epics/<slug>.md`) is the epic's id, with one run per plan.** The branch is
   `factory/epic/<slug>` and the worktree `factory/.worktrees/epic-<slug>/`. Abandoning an epic
   is final: trying again means a new plan through `explore` that lists the old one under
   `Sources:`, and the abandoned plan gets an `- Abandoned:` line as a brief does. Why: `jobs/` is
   already gitignored in every project by `init` and watched by the Andon service, so no
   consumer's `.gitignore` or watch roots change; `epics` isn't a job id, so `claim` numbering,
   `prune`, and `archive` already skip it; numbered attempts per slug would cost a second id
   sequence for a rare case.
2. What does the epic's log record, and how is `epic.json` derived? → **The log records only
   epic-level facts; `epic.json` is a projection over the epic's log, the plan file (members and
   `after:` edges, read live), and every job whose `job.json` names the epic.** Events:
   `epic.started` (`schema`, `slug`, `target` resolved by the CLI with `claim`'s rule,
   `session?`) → `running`; `epic.waiting` (`reason`) → epic-level needs-human, `note = reason`;
   `epic.resumed` (`session?`) → clears waiting, records the driving session; `epic.landing` →
   `landing`; `epic.landed` (`sha`) → terminal, `endedAt`; `epic.abandoned` (`reason`) →
   terminal, `endedAt`. No member events: a member's `job.claimed` names its epic and its own log
   records the rest. `epic.json` carries the state (`running`, `waiting`, `landing`, `landed`,
   `abandoned`; `waiting` also derived when nothing can run and some member is `needs-human`),
   each member's state (`queued`, `blocked` on a job, `running` at a stage, `merged`,
   `needs-human`), the generated sync and fix jobs, counts, and timing. The CLI rebuilds it after
   every epic event and after every event on a member job; `rebuild` and `epic show` regenerate
   it. Why: each fact has one truth, so the epic's view can't disagree with a job's; it's the
   job pattern (log is truth, snapshot disposable) extended across files. Accepted cost: a hand
   edit to the plan shows at the next event or `epic show`.
3. How does a job record its epic? → **`claim` takes `epic=<slug>`, and `kind=sync|fix` for
   generated jobs; `job.claimed` stores optional `epic` and `kind`, and `job.json` carries both
   (`null` for a standalone job).** With `epic=`, the epic must have `epic.started` and not be
   `landed` or `abandoned`; the CLI sets `target` to `factory/epic/<slug>` and checks the branch
   exists (a caller-supplied `target` is still rejected). `kind` defaults to `member`, which needs
   a `brief=` listed in the plan's `## Members`; `sync` and `fix` take no brief; `kind` without
   `epic` is rejected. Why: the job carries its membership, which decision 2's projection needs;
   sync and fix both lack a brief, so only an explicit kind tells them apart for Andon's tags; and
   the target stays CLI-resolved, never trusted from the caller.
4. How much scheduling does the CLI own? → **All of it: `epic next <slug>` prints what to do now,
   and `claim … epic=` refuses anything that breaks the plan.** `epic next` prints one line per
   action: `claim <member>` for each member whose `after:` members have all merged into the epic
   branch, that has no job yet, while working members are under `epic.maxParallel`; `land` when
   every member has merged and no sync or fix job is live; nothing when the epic must wait
   (`epic show` says why). `claim` refuses (writing nothing) a member whose `after:` members
   haven't all merged, a member that already has a job that isn't abandoned, and a member claim
   past the cap. The cap counts working members only (a member in `needs-human` holds no slot);
   sync and fix jobs bypass it. An abandoned member is `abandoned` in `epic.json`, blocks its
   dependents, and is never reclaimed by `epic next` (the decision 6 point where the orchestrator
   asks Matt). Why: the CLI defends the plan as it defends WAIT FOR ALL, so an orchestrator
   juggling several jobs, after a compaction or a resume, can't start a member early or twice;
   the loop becomes "ask `epic next`, do it"; judgment and git work stay with the orchestrator.
5. Who does the epic's git work? → **The CLI owns setup and teardown; the orchestrator owns every
   merge.** `epic start <slug>` is all-or-nothing: validate the plan (`Status: ready`, every
   member a `ready` brief, every `after:` names a member, no cycles), resolve the target with
   `claim`'s rule, create `factory/epic/<slug>` from it and its worktree, then log `epic.started`;
   on any failure it writes nothing, removes any git state it created, and exits with a one-line
   reason. `epic abandon <slug> '<reason>'` logs `epic.abandoned` and removes the epic worktree
   (and the branch with `--delete-branch`); it refuses while any member or generated job is in a
   working stage unless `--force`, which abandons those jobs too (as `abandon --force` does); jobs
   in `needs-human` are abandoned with it. Merges (members into the epic branch, catch-ups,
   landing) stay with the orchestrator, which records outcomes (`job.merged`, `epic.landing`,
   `epic.landed`). Why: the CLI already runs git where correctness matters (target resolution,
   archive plumbing, `abandon`), an atomic start means an epic never exists without its branch or
   the reverse, and merges need judgment (a conflict → sync job, a red gate → fix job, a wrong
   checkout → `epic.waiting`).
6. The config key and plan validation? → **`"epic": { "maxParallel": <positive integer> }`, an
   object holding only `maxParallel`; no key means 3** (`parseConfig`, the contract doc, and a test
   together; the `customize` interview is brief 3's). **One plan parser serves `epic start`,
   `epic next`, `doctor`, and the projection.** `doctor` checks each `factory/epics/*.md`: a
   `ready` plan that `epic start` would refuse (a missing or non-ready brief, an `after:` naming a
   non-member, a cycle, a malformed `## Members` line) is a `FAIL` with the same one-line reason; a
   `draft` plan is checked for parse errors only, as a `note`; a `done` plan isn't checked. Why:
   one parser means `doctor` and `epic start` never disagree; a ready plan that can't run is a
   defect like a bad `config.json`, while a draft is mid-interview; the key follows the shape of
   `merge` and `archive`.

7. How do `archive` and `prune` treat epics? → **`archive <slug>` copies a terminal epic
   (`landed` or `abandoned`) to the `factory/archive` branch under `epics/<slug>/`
   (`events.jsonl`, `epic.json`, and a copy of the plan file as it stood at the end), with the
   jobs' plumbing and compare-and-swap commit, a `Factory-Epic: <slug>` trailer, and
   `Landed-As: <sha>` when it landed; `archive --all` includes terminal epics.** Member jobs are
   archived one by one as today, when each merges into the epic branch (calling `archive` at
   landing or abandon is brief 3's skill step). **`prune` removes a terminal epic's local dir once
   it is archived and settled (landed more than `settleAfterHours` ago, or abandoned), and never
   prunes a member or generated job whose epic isn't terminal**, even when that job is merged,
   archived, and past the settle window. Why: an epic's record outlives the machine as a job's
   does; the settle rule is reused; and a running epic's view is built from its members'
   `job.json`s, so pruning one would make a merged member read as missing.

## Scope
- In: `packages/contract` (plan file parser; epic events, transitions, and the `epic.json`
  projection; `epic` and `kind` on `job.claimed` and `job.json`; the `epic` config key) and
  `packages/cli` (`epic start`, `epic event`, `epic next`, `epic show`, `epic abandon`;
  `claim … epic= kind=`; rebuilding `epic.json` after member events and in `rebuild`; `doctor`,
  `archive`, `prune`); `docs/contract/v1.md`; `docs/decisions.md` (a new decision "Epics" that
  points at docs/design/epics/design.md, and decision 8's "fixed" list amended to say epics were
  added by it); tests for all of it.
- Out: the skill and `explore` (brief 3), the Andon service and UI (briefs 4 and 5), merges of any
  kind (the orchestrator's), epic attempts or restarts on one slug, a configurable conflict limit,
  and any change to how standalone jobs behave beyond the new optional fields.

## Acceptance sketch
- `epic start <slug>` on a valid ready plan creates `factory/epic/<slug>` from the resolved
  target, its worktree at `factory/.worktrees/epic-<slug>/`, and `factory/jobs/epics/<slug>/`
  with `epic.started`; on an invalid plan, a non-ready member brief, a cycle, a bad target, an
  existing branch, or a second start, it writes nothing, leaves no branch or worktree, and prints a
  one-line reason.
- `epic event <slug> <type> [k=v …]` logs `epic.waiting`, `epic.resumed`, `epic.landing`, and
  `epic.landed` with their transitions enforced (waiting from running or landing; resumed from
  waiting; landing only when every member has merged and no sync or fix job is live; landed from
  landing; nothing after landed or abandoned); `session` is accepted on `epic.started` and
  `epic.resumed` only. A rejected event writes nothing.
- `claim <slug> epic=<epic> [kind=sync|fix] [brief=…]` targets the epic branch and records
  `epic` and `kind`; it refuses an epic that isn't running, a member not in the plan or without
  `brief=`, a member whose `after:` members haven't all merged, a member that already has a
  non-abandoned job, a member past `epic.maxParallel` (members in `needs-human` hold no slot; sync
  and fix bypass), `kind` without `epic`, and a brief on a sync or fix job.
- `epic next <slug>` prints `claim <member>` lines, `land`, or nothing, matching the rules above;
  `epic show <slug>` prints the epic's state, each member's state, and why it waits.
- `epic.json` is rebuilt after every epic event and every event on a member job, and by `rebuild`;
  it reports `running`, `waiting` (logged, or derived when nothing can run and some member is in
  `needs-human`), `landing`, `landed`, or `abandoned`, and each member as `queued`, `blocked` (on
  which job), `running` (at which stage), `merged`, `needs-human`, or `abandoned`, plus the
  generated jobs, counts, and timing. Members added to the plan mid-run appear.
- `epic abandon <slug> '<reason>'` logs `epic.abandoned` and removes the epic worktree (and the
  branch with `--delete-branch`); it refuses while a member or generated job is in a working stage
  unless `--force`, which abandons them; jobs in `needs-human` are abandoned with it.
- `config.json` accepts `epic.maxParallel` (positive integer; default 3) and rejects any other key
  under `epic`.
- `doctor` FAILs a ready plan `epic start` would refuse, with the same reason; notes a draft plan's
  parse errors; skips done plans.
- `archive` copies terminal epics under `epics/<slug>/` on `factory/archive` (with
  `Factory-Epic` and, when landed, `Landed-As`), and `archive --all` includes them; `prune`
  removes archived, settled epic dirs and never prunes a job whose epic isn't terminal.
- Standalone jobs, logs without any epic fields, and configs without `epic` behave exactly as
  before.

## Contract calls
- "Epics join `factory/v1`: the plan file `factory/epics/<slug>.md` and its format; runtime state
  under `factory/jobs/epics/<slug>/` (`events.jsonl`, `epic.json`); the epic events, their
  transitions, and the `epic.json` projection; optional `epic` and `kind` on `job.claimed` and
  `job.json`; `claim`'s `epic=` and `kind=`; the `epic start|event|next|show|abandon` commands;
  the `epic` config key; `doctor`'s plan checks; epics on the `factory/archive` branch and in
  `prune`." Approved by Matt on 2026-10-29. It is additive within `factory/v1` (new files, events,
  optional fields, a config key with a default, and new commands; no existing transition or field
  changes). The job updates `docs/contract/v1.md` to match, and records the decision in
  `docs/decisions.md` (a new "Epics" decision; decision 8's fixed list amended).

## Open
None.
