---
name: factory
description: Run the factory — a feature goes spec → build → parallel reviews → approve → merge, driven by subagents that talk only through markdown files; `queue` and `explore` feed its backlog, and `customize` (alias `init`) tailors the project's overlay. Use when the user invokes /factory with a feature, `next [words]`, `queue <text>`, `explore <idea|brief>`, `customize`, `init`, `approve <job-id>`, `rework <job-id> <note>`, or `abandon <job-id> <reason>`.
argument-hint: "<feature> | next [words] | queue <text> | explore <idea|brief> | customize | init | approve <job-id> | rework <job-id> <note> | abandon <job-id> <reason>"
---

# /factory — the orchestrator

The session running this skill **is the orchestrator** of one job. You run its loop, spawn
every agent, and record every state change through the **factory CLI**. You never write code,
specs, reviews, or decisions yourself; agents do, one file each. Other sessions may be running other
jobs at the same time; see **Running jobs side by side**.

```
clear work ── queue ────────────────────┐
fuzzy idea ── explore ── brief ─────────┴─► backlog.md ── next ─┐
                                                                ▼
feature → spec-writer → builder ⇄ [configured reviewers] → approver → merge | needs-human
```

## Files (R = `git rev-parse --show-toplevel`; always pass agents absolute paths)

| Path | Written by |
|---|---|
| `factory/jobs/<id>/events.jsonl` — the job's append-only event log, the truth | the factory CLI, when you run it |
| `factory/jobs/<id>/job.json` — derived from the log; the dashboard polls it | the factory CLI (never by hand) |
| `factory/config.json` — reviewer keys, the default `maxRound`, the gate, per-role runners, and the merge target | human (or `customize`, with the human) |
| `factory/roles/<role>.md` — the project's rules for one role (optional) | human (or `customize`, with the human) |
| `factory/.lock/` — a short mutex for claiming work and merging | you, briefly |
| `factory/jobs/.claim.lock/` — the CLI's mutex for handing out job ids | the factory CLI (never by hand) |
| `factory/backlog.md` — queue for `/factory next` | human (you tick items off) |
| `factory/briefs/<slug>.md` — decisions from an `explore` interview (tracked in git) | you, with the human |
| `factory/jobs/<id>/feature.md` — the request, verbatim | you |
| `factory/jobs/<id>/rework-<k>.md` — a human's rework note, verbatim | you |
| `factory/jobs/<id>/spec.md` | `factory-spec-writer` |
| `factory/jobs/<id>/build.md` | `factory-builder` |
| `factory/jobs/<id>/round-<N>/review-<key>.md` | the reviewer for each key in `factory/config.json` `reviewers` |
| `factory/jobs/<id>/round-<N>/<key>/*` — supporting files such as screenshots, when its rules ask for them | that reviewer |
| `factory/jobs/<id>/decision.md` | `factory-approver` |
| `factory/.worktrees/<id>/` — the job's checkout, branch `factory/<id>` | builder (code) |

`jobs/`, `.lock/`, and `.worktrees/` are gitignored runtime state. Code lives on the
branch; the main checkout stays on the job's target branch so your files never move under you.
Dashboard: Andon, one service per machine. Run `bun run andon:service` in the factory clone (not in this project), then open http://127.0.0.1:8766/ (or `bun run andon` there opens the Mac app). `factory init` registers the project with Andon.

**The target branch.** Every job is based on and merges into its **target**: `target` in its
`job.json`. The CLI resolves it once, at `claim`, from `merge.target` in
`<R>/factory/config.json`: `current` (the default when `merge` or `merge.target` is absent) is
the branch the main checkout is on at that moment, and any other value names a branch that
must exist. The CLI accepts only a plain branch name (letters, digits, `.`, `_`, `/`, `-`), so a
target never carries quotes or shell metacharacters. A detached HEAD, a missing branch, or a
disallowed name refuses the claim, writing nothing; tell the user the CLI's one-line reason and
stop. Read `target` from `job.json` after the claim and use
it as `<target>` everywhere below, even if the checkout or the config changes mid-job.
If `target` is `null` (a job claimed before the CLI recorded it), resolve it whenever you need
it from the current config: `merge.target` if it names a branch, else (`current`, or no key)
`git symbolic-ref --short HEAD` in `<R>`.

**Reviewers come from config.** The reviewer keys are `reviewers` in `<R>/factory/config.json`,
in order. Read them when a round starts; never assume a list. Each key `<key>` is the agent
`factory-<key>`, which writes `round-<N>/review-<key>.md`.

## The board — events through the CLI

A job's state is its `factory/jobs/<id>/events.jsonl`; the CLI derives `job.json` from it after
every event, and the dashboard assembles the board from those. You **never write `job.json` or
the log** yourself. "Board: `<type> k=v …`" below means: run

```bash
bun factory/cli.ts event <id> <type> [k=v …]    # from <R>
```

for **your job** only, right when the change happens. It prints the new stage. A job starts
with **`claim`**, never with `event`:

```bash
bun factory/cli.ts claim <slug> [brief=…] [issue=…] [maxRound=…] [session=…]    # from <R>
```

`<slug>` is a 2–4 word kebab name for the work (lowercase letters and digits joined by single
`-`, at most 40 characters), e.g. `export-csv-report`. The CLI picks the job number, creates
`factory/jobs/<id>/`, logs `job.claimed`, and prints the full id (e.g. `004-export-csv-report`)
as its only output. That printed id is `<id>` everywhere from then on; never compute, guess, or
pick an id yourself. A non-zero exit means nothing was claimed: read the one-line reason (a bad
slug, `slug <slug> is live as <id>` when a live job already has that slug, a refused
`merge.target`), fix it or tell the user, and stop. A non-zero exit
means the event was rejected and nothing was written: read the one-line reason and fix the
cause (usually WAIT FOR ALL, or an agent's file that's missing or malformed). Never hand-edit
state to get around it. If the reason is a corrupt (torn) tail, stop and tell the user: a human
truncates the partial last line, then runs `bun factory/cli.ts rebuild <id>`; you never edit the
log. The schema, the event types, and the allowed transitions are in
[factory/CONTRACT.md](../../../factory/CONTRACT.md); `bun factory/cli.ts show <id>` prints a job's
stage and timing. Jobs claimed before the CLI (no `events.jsonl`) reject every event, so
`approve`/`rework`/`abandon` can't drive them; say so in one line and stop.

Put free-text values (`title`, `note`, `reason`) in **single quotes** — double quotes expand
`$` and backticks — and write an apostrophe as `'\''`: `reason='it'\''s blocked'`.

**Agent spans.** Every spawn or resume is bracketed: `agent.started` right before it and
`agent.finished` once it returns **and its file exists**, with the same identity fields —
`role` (`spec-writer` | `builder` | `reviewer` | `approver`), plus `key=<reviewer key>` and
`round=<N>` for reviewers, `name=builder-<id>` for the builder, and `round=<N>` for a builder
resumed after round N (omit `round` when N is 0). Never pass a verdict: the CLI reads it from
the reviewer's or approver's file.

## The thread lookup (T3 Code)

A job records which T3 Code thread is orchestrating it, so the dashboard can open that thread.
Run this **thread lookup** right before `claim` (before taking `factory/.lock`), before
`job.reworked` (`/factory rework`), and before `job.human-approved` (`/factory approve`), and
only when T3 Code's tools `t3_environment_read` and `t3_thread_search` are both present in this
session. Without them, skip it and run the command without `session`.

1. Write a unique phrase in your reply to the user: `factory session <random>`, where
   `<random>` is 12 random letters and digits you make up now (never reuse one).
2. Call `t3_environment_read` for the environment id, then `t3_thread_search` for the phrase.
   If no thread comes back, wait a couple of seconds (`sleep 2`) and search once more.
3. Only if exactly one thread matches, add `session=t3code:<environmentId>/<threadId>` to the
   command (`claim`, `job.reworked`, or `job.human-approved`).
4. Otherwise (no match after the retry, several matches, or a tool error), run the command
   without `session` and tell the user in one line: "couldn't find this T3 Code thread; the job
   won't link to it".

It is best effort: never stop the job, wait on the user, or ask them about it. If the CLI
refuses the `session=` value, run the same command again without it and say that one line.
Pass `session=` on nothing else (the CLI refuses it on every other event), and never record any
other id, such as Claude Code's own session id.

## Running jobs side by side

Any number of sessions can run `/factory` at once, one job each. Each job has its own worktree,
branch, job dir, and `job.json`, so they don't touch each other's files. The job-id sequence is
the CLI's: `claim` hands out each number under its own lock, so two sessions never get the same
id. Two more things are shared: the backlog and the main checkout that merges land in. Those
steps happen under `factory/.lock`, which is a directory because `mkdir` is atomic:

```bash
cd <R>; until mkdir factory/.lock 2>/dev/null; do
  [ -n "$(find factory/.lock -maxdepth 0 -mmin +15)" ] && rmdir factory/.lock  # stale: holder died
  sleep 2; done
```

Release it with `rmdir factory/.lock` as soon as the step is done, and never hold it while you
wait on the user or an agent. Two steps take the lock:
- **Claim:** pick the work, run the overlap check, run `bun factory/cli.ts claim <slug> …` (it
  picks the number, creates the job dir, and prints the id), then, with that printed id, write
  `feature.md` and tick the backlog line. Run **the thread lookup** before taking the lock.
- **Merge:** everything in **Merge** below, bookkeeping included.

**Live jobs** are the jobs whose `job.json` (read-only to you) has a stage other than
`merged`. That includes `needs-human`, because those branches still have to merge.

**Overlap check** (the first step of a claim). Compare the new work with each live job's title
and `feature.md`, and its `spec.md` Touchpoints if they're written yet. The question is whether
they look likely to change the same area: the same module, the same surface or component, the
same doc. A judgment call at a glance is enough; no file-level analysis is needed. If they
overlap, release the lock and ask the user in a sentence before starting: *"This and live job
<id> both change the same module, so they'll likely conflict at merge. Start it anyway, or take
the next backlog line that doesn't overlap?"* Then do what they say. Most work won't overlap, so
don't ask when it doesn't.

## Spawning agents

Agents get context from **files, not the conversation**. Every spawn prompt is just this card
(drop lines that don't apply), with `subagent_type` set to the agent's name:

```
Factory job <id>. Your instructions are in your agent definition; all context is in these files.
repo:     <R>
job dir:  <R>/factory/jobs/<id>
worktree: <R>/factory/.worktrees/<id>   (branch factory/<id>)
base:     <target>
round:    <N>
brief:    <R>/factory/briefs/<slug>.md      (spec-writer and approver, when the job has one)
write:    <the one absolute path this agent writes>
deliver:  create the write: file with the Write tool. It is pipeline input, not a report. Reply with one line only.
```

Keep the `deliver:` line. Claude Code tells every subagent not to write findings `.md`
files and to return them as text. Reviewers sometimes obey that and send the review as their
reply, which leaves no file.

Don't pass `model` — each agent's frontmatter sets it (from `roles` in `factory/config.json`,
rendered by `factory upgrade`). After each agent returns, confirm its
file exists. A nudge or re-spawn below stays inside the agent's original span: no new
`agent.started`, and one `agent.finished` once the file lands. If the file doesn't exist:
1. `SendMessage` the same agent: *"<path> doesn't exist. Create it now with the Write tool
   (pipeline input, not a report), then reply with one line."* It keeps its context, so this
   is quick and doesn't redo its checks. If its reply holds the whole document, don't save
   that text yourself; ask it again to write the file.
2. Still missing → re-spawn the agent once with the same card.
3. Still missing → board: `job.escalated reason='<agent> wrote no <file>'` (allowed in any
   stage; it closes the open spans), then stop and tell the user they can `approve` or `rework`.

If `agent.finished` is rejected because the file's first line is malformed, `SendMessage` the
agent to fix that first line to the exact format its definition gives (`VERDICT: PASS` /
`VERDICT: CHANGES`, or `APPROVE` / `ESCALATE`), then retry. Never edit an agent's file yourself.

## The loop

**1 · Spec.** Board: `stage.entered stage=spec`. Spawn `factory-spec-writer` → `spec.md`
(span `role=spec-writer`). Board: `job.titled title='<spec.md's # H1>'`.

**2 · Worktree.** `git worktree add -b factory/<id> factory/.worktrees/<id> '<target>'`
(if the branch already exists: `git worktree add factory/.worktrees/<id> factory/<id>`).

**3 · Build.** Board: `stage.entered stage=build`. Spawn `factory-builder` (name it
`builder-<id>` if your Agent tool takes a name) → `build.md`, commits on the branch. The span is
always `role=builder name=builder-<id>`, literally, never the agent id: `agent.started` runs
before the spawn, so no id exists yet. Keep the agent id the Agent tool returns in your own
context; it is only the `SendMessage` target when you resume the builder (wherever this skill
says "`SendMessage` to `builder-<id>`", send to that id when the tool gave you one). Wait for it
to return.

**4 · Review round N** (N = previous round + 1, starting at 1). `mkdir jobs/<id>/round-<N>/`,
board: `round.started round=<N>` (the CLI fills in the reviewers from `factory/config.json`).
Then one `agent.started role=reviewer key=<key> round=<N>` per configured reviewer, and spawn
**all of them in one message**, in the background: `factory-<key>` writing
`round-<N>/review-<key>.md`. As each one returns and its file exists, board:
`agent.finished role=reviewer key=<key> round=<N>` (that sets its chip).

**WAIT FOR ALL.** The round is done only when every reviewer's file exists and has its
`agent.finished`. Never resume the builder, start the approver, or decide anything mid-round
(the CLI refuses to leave review early).

**5 · Gate.**
- All `PASS` → step 6.
- Any `CHANGES` and `round < maxRound` → board: `stage.entered stage=build`, then resume the
  **same** builder (span `role=builder name=builder-<id> round=<N>`): `SendMessage` to
  `builder-<id>` — *"Round <N> reviews are in <R>/factory/jobs/<id>/round-<N>/. Address every
  [blocking] finding, update build.md, commit."* When it returns, go to step 4.
- Any `CHANGES` and `round == maxRound` (default `maxRound` 2) → step 6; the approver will
  escalate.

**6 · Approve.** Board: `stage.entered stage=approve`. Spawn `factory-approver` →
`decision.md` (span `role=approver`; its `agent.finished` records the decision). Read the first
line:
- `APPROVE` → **Merge** (below).
- `ESCALATE` → board: `job.escalated reason='<one-line reason>'`. Tell the user why, and that
  they can `/factory approve <id>` or `/factory rework <id> "<note>"`.

## Merge

Take `factory/.lock` first. Another session may be merging. Everything below runs from the
main checkout, which must be on the job's `<target>`. Check it first with
`git symbolic-ref --short HEAD`. If it is on another branch `<x>` (or detached: `<x>` is
`detached HEAD`), release the lock, board:
`merge.failed reason='checkout is on <x>, job targets <target>'` (the job goes to
`needs-human`; `<x>` is whatever the checkout's branch is called, so write any apostrophe
in it as `'\''`, as for every board value), and stop: tell the user to switch the main
checkout to `<target>` themselves and retry with `/factory approve <id>`. Never run `git checkout` or `git switch` here. The main
checkout is the user's working tree, maybe with uncommitted work.

```bash
git merge --no-ff factory/<id> -m '<Merge message: line from decision.md>' \
  -m 'Factory job <id>.' -m 'Co-Authored-By: Claude <noreply@anthropic.com>'
```

The merge message is the approver's text: keep it in single quotes and write any apostrophe in it
as `'\''` (as for board values), so `$` and backticks in it are never expanded.

- Conflict or refusal → `git merge --abort` (if a merge is in progress), release the lock,
  board: `merge.failed reason='merge conflict with <target> — /factory rework to rebase'`.
  Stop. (Refusal because of a stray `.git/index.lock` means something else is mid-commit;
  wait a few seconds and retry once before giving up.)
- Success → board: `job.merged sha=<short sha>` **immediately**, before any cleanup, so git and
  the board never disagree. Then `git worktree remove factory/.worktrees/<id>` and
  `git branch -d factory/<id>`; if cleanup fails, report it and carry on (the merge stands).
- **Post-merge check.** If `<target>` had moved past the branch's base, run the gate on `<target>` and
  report the result (don't auto-revert). The gate is `gate` in `<R>/factory/config.json`: its
  shell commands run in order from the repo root, and it is green only when every command
  exits 0. If `config.json` has no `gate`, no gate is configured: tell the user so instead of
  running anything, and never invent a command.
- Then **bookkeeping**, so every job leaves `<target>` clean. When `job.json` has a non-null
  `brief`, mark that brief done: set that brief's `Status:` line to `done` and add
  `- Job: <id> (merged <short sha>, <YYYY-MM-DD>)` right below it (the `<short sha>` you passed
  to `job.merged`, and today's date). Then commit by pathspec, so nothing else of the user's
  gets swept in, the brief together with the backlog tick: `git commit -m "chore(factory):
  record job <id>" -m "Co-Authored-By: Claude <noreply@anthropic.com>" -- factory/backlog.md
  factory/briefs/<slug>.md`. With no brief, commit the backlog only, ending the same command
  with `-- factory/backlog.md` (nothing changed → skip).
- Release the lock (`rmdir factory/.lock`).
- Never push. Pushing stays a human decision.

## Commands

**`/factory <feature>`** — New job. If the text names a brief (`brief: factory/briefs/<slug>.md`),
its `Status:` must be `ready`. If it is `done`, a job already carried it out: stop before claiming
and say `brief <slug> is done (job <id>)`, with the job from its `- Job:` line. Separately, a draft
brief means the interview isn't done, so stop before claiming and say so. Otherwise **claim** it
under the lock (overlap check first): pick a 2–4 word kebab slug for the work and run
`bun factory/cli.ts claim <slug>` with `brief=factory/briefs/<slug>.md` when it applies (add
`maxRound=<n>` only to override the config default, and `session=…` from **the thread lookup**,
run first). The CLI picks the number and prints the
job's id, e.g. `004-export-csv-report`; use that id from then on. Write `feature.md` verbatim,
release the lock, run the loop.

**`/factory queue <text>`** — Add ready work to the backlog without running it. Work arrives
as text. It is **ready** if it isn't blocked by unmerged work and you can say in one line what
"done" looks like.
- Ready → distill it into `- [ ] <one line>`. The line carries what defines done — behaviors,
  limits, must-nots (e.g. *no new runtime dependency*) — and none of the history or rationale.
- Not ready → don't queue it; say why in a sentence and suggest `/factory explore <idea>`.

Show the user the lines you added, then commit just the backlog by pathspec:
`chore(factory): queue <title>` (+ the Co-Authored-By trailer) `-- factory/backlog.md`.
`queue` never starts a job.

**`/factory explore <idea | brief slug>`** — An interactive interview that turns a fuzzy
idea into a brief, then queues it. Read [explore.md](explore.md) in this skill's folder and
follow it. It runs entirely in this session with the user; it spawns no agents.

**`/factory customize`** (alias **`/factory init`**) — An interactive interview that tailors
the project's overlay (`factory/config.json` and `factory/roles/<role>.md`), then runs doctor
and commits it. Follow **Customize** below. It runs entirely in this session with the user; it
spawns no agents, claims no job, and never runs the `factory init` or `factory upgrade` installer.

**`/factory next [words]`** — Under the lock, re-read `factory/backlog.md` (another
session may have just ticked a line) and pick a `- [ ]` item:
- no argument → the first one;
- words → the line they clearly describe, matched by meaning, not exact text.

Claim it as `/factory <item text>` does, and tick it as `- [x] … → <id>` in the same step. If
the overlap check stops you, leave the line unticked. Then run the loop.

Don't guess. If there's nothing unchecked, or nothing matches (a ticked line means it already
ran, so say which job), release the lock and stop. If the words fit more than one line,
release the lock and ask which one.

**`/factory approve <id>`** — Human override for a `needs-human` job. Refuse any other stage:
a job in flight belongs to the session running it.
If the approver never ran on this work (no `APPROVE`/`ESCALATE` from it, so job.json's `decision`
is null: an escalation before or during review, or after a rework before the approver), say so and
ask before merging work the approver never checked. (A retry after a failed merge already shows
`APPROVE (human)`; the human answered that the first time.)
Recreate the worktree if it's gone (step 2, from the job's `<target>`), run **the thread lookup**,
board: `job.human-approved [session=…]` (every time, also when
retrying after a failed merge; leave decision.md alone, it's the approver's), and **Merge**.

**`/factory rework <id> <note>`** — Send a `needs-human` job back with human feedback. Write
the note verbatim to `rework-<k>.md` (`k` = `reworks` + 1, from job.json), recreate the worktree
if needed (step 2, from the job's `<target>`), run **the thread lookup**, board:
`job.reworked k=<k> maxRound=<round + 2> [session=…]` (a fresh review budget; it clears
the decision). If the job escalated before `spec.md` existed, first spawn `factory-spec-writer`
with the card plus the rework path (span `role=spec-writer`) and set `job.titled`. Resume
`builder-<id>` with SendMessage (span `role=builder name=builder-<id> round=<round>`) —
*"Human rework note: <R>/factory/jobs/<id>/rework-<k>.md. Address it, update build.md,
commit."* If that builder isn't alive in this session, spawn a fresh `factory-builder` named
`builder-<id>` with the card plus the rework path (everything it needs is in files). Then
continue at step 4 with round `<round> + 1` (round 1 if the job escalated before any review).

**`/factory abandon <id> <reason>`** — Close a job for good, without merging: it leaves the
board, its worktree is removed, and it can never take another event. Read the job's `stage` from
job.json. Refuse `merged` and `abandoned` (both are terminal). Otherwise ask the user two
questions, one at a time, and wait for each answer:
1. **Confirm.** *"Abandon <id> (<stage>): '<reason>'? This can't be undone."* From a working
   stage (`claimed`, `spec`, `build`, `review`, `approve`), also ask them to confirm that the
   session driving the job is stopped: abandon never stops agents, and a session still running
   would keep working on a closed job. Anything but a clear yes: stop and change nothing.
2. **The branch.** *"Keep the branch `factory/<id>`, or delete it?"* The default is **keep** (an
   unclear answer keeps it).

Then, from `<R>`, run

```bash
bun factory/cli.ts abandon <id> '<reason>'
```

adding `--force` only when the job is in a working stage (never from `needs-human`), and
`--delete-branch` only when the user chose delete. Quote the reason as for any free-text value.
It logs `job.abandoned`, then removes `factory/.worktrees/<id>` (and the branch, if asked), and
prints `abandoned`. A non-zero exit before the event is logged (a wrong stage without
`--force`, a bad id or reason) changed nothing: report the one-line reason. A non-zero exit
naming what was left behind means the job **is** abandoned but cleanup failed: tell the user
what to remove by hand. Never write the event yourself to get around a refusal.

## Customize — the overlay interview

`/factory customize` (or `/factory init`) writes only `factory/config.json` and
`factory/roles/<role>.md`, the overlay. It never edits managed files (`.claude/**`,
`factory/cli.ts`, `factory/CONTRACT.md`, `factory/managed.json`) or runtime state
(`factory/jobs/`, `factory/.lock/`, `factory/.worktrees/`), and it writes no events.

**Do your homework first.** Read `factory/config.json` and save its exact bytes (you may need to put
them back), every `factory/roles/*.md`, the contract (`factory/CONTRACT.md`, "`config.json`"
and "Role overlays"), the project's instructions (`CLAUDE.md` or its equivalent), and how the
project builds, tests, and checks itself. Run `bun factory/cli.ts doctor` once to see where the
install stands. List the live jobs (every `factory/jobs/*/job.json` with a stage other than
`merged`; read-only).

**Interview.** Use the same discipline as `explore`: ask **one question at a time**, in prose,
each with your **recommended answer** and the reason for it. Facts are yours to find; decisions
are the user's. Never ask what the code or docs can answer (the project's test and check commands
are facts; which of them gate a merge is a decision). Cover only the v1 overlay, in this order:
1. `name` — the project's display name on the dashboard. Show the current resolved name: `config.json`'s
   `name` when set, else the repo root's folder name (`basename R`). Recommend leaving it unset
   when the folder name is right; no `name` key means the folder name.
2. `reviewers` — the ordered reviewer keys, one per review concern (e.g. correctness and test
   coverage, security, contract).
3. `maxRound` — the default review budget for a new job.
4. `dashboard.settleAfterHours` — how long a merged job stays in the Merged column.
5. `gate` — the shell commands, in order, that must all exit 0; or no gate.
6. `merge.target` — the branch jobs are based on and merge into: `current` (the default: the
   branch the main checkout is on when a job is claimed) or a branch name such as `develop`.
   No `merge` key keeps `current`.
7. `roles` — for any role that should not run on the default model (`opus`): its runner
   (`claude`, the only runner in v1) and, optionally, the harness model name (e.g. a cheaper
   model for a narrow reviewer). No entry, or no `roles` key at all, keeps the default.
8. `factory/roles/<role>.md` — for `spec-writer`, `builder`, `approver`, and each configured
   reviewer key: the project's own rules for that role, or no file (the managed defaults apply).

Anything else (a runner other than `claude`, per-role tools or effort, a tracker, any merge policy
beyond `merge.target` such as squashing, PRs, or pushing, conditional reviewers) is not in v1. Say so in a sentence and move on; never write it into the overlay.

**Refusal rules.** Check every change against these before anything is written. A change that
breaks one is refused: tell the user which rule and why, and ask again. Nothing is written for it.
- No key outside v1. `config.json` holds only `schema` (`"factory/v1"`), `name`, `reviewers`,
  `maxRound`, `dashboard` (only `settleAfterHours`), `gate`, `merge` (only `target`), and `roles`.
- `name`, when present, is a string of 1–64 characters (Unicode code points) with no leading or
  trailing whitespace and no control characters; spaces, punctuation, and non-ASCII are fine.
  No name means leaving the key out, never an empty string.
- Each reviewer key matches `^[a-z][a-z0-9-]*$`, is unique, and is never a fixed role name
  (`spec-writer`, `builder`, `approver`). There is at least one reviewer.
- `maxRound` is a positive integer, and `dashboard.settleAfterHours` is a positive number.
- `gate`, when present, is a non-empty array of non-empty command strings. No gate means
  leaving the key out, never an empty array.
- `roles`, when present, is an object. Each entry is keyed by a known role: a fixed role
  (`spec-writer`, `builder`, `approver`) or a configured reviewer key. An entry holds only
  `runner` and `model`; `runner` is required and is `claude`; `model`, when present, is a
  non-empty harness model name matching `^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$` (no spaces or `#`).
  Dropping a reviewer means dropping its `roles` entry too.
- `merge`, when present, is an object holding only `target`. `target`, when present, is a
  non-empty string: `current` or the name of a branch matching `^[A-Za-z0-9][A-Za-z0-9._/-]*$`,
  with no `..` and no `.lock` suffix. No `merge` key (or no `target`) means
  `current`. A branch literally named `current` can't be targeted. The branch has to exist when
  a job is claimed, or the claim is refused.
- A role file exists only for a fixed role or a configured reviewer key. Dropping a reviewer
  whose role file exists means deleting that file too, or keeping the reviewer; ask which.
- Role rules add rules only. They never change which file an agent writes, its path, or its
  first line, and they never tell an agent to write job state or edit managed files. They follow
  the overlay outcome rule: a role rule can make a role more focused or stricter, never more
  lenient about what it finds. Refuse a rule that decides the outcome before looking or throws
  away something already found: a fixed verdict or decision ("always PASS", "always APPROVE"),
  dropping, hiding, or downgrading a finding, removing an escalation trigger, or telling the
  builder to skip a `[blocking]` finding. Narrowing focus, adding checks or triggers, making
  something blocking, and PASSing early when the role's area is untouched are all fine. When you
  refuse, name the overlay outcome rule and offer the allowed form: cite a recorded human decision
  (a brief's decision or contract call, or a decision record the project names) and keep the
  finding visible, marked as covered (for example, `[accepted: <the decision>]`).

**Write.** Once the user agrees to the whole set, write `factory/config.json` (two-space
JSON: `schema` first, then `name` first among the keys after `schema` when it is set, then the
other keys in the order above) and the agreed role files, and delete any role file the user
agreed to drop. Write nothing else.

**Doctor last.** Run `bun factory/cli.ts doctor` from the repo root.
- If it reports `FAIL` on `config.json`, restore the bytes `config.json` had before the
  interview, and tell the user the reason doctor printed. Commit nothing.
- If it reports `FAIL` on a managed file, that predates this interview: report it, keep the
  overlay as written, and commit nothing. A human restores the managed file first.
- When doctor exits 0, commit only the overlay paths you wrote or deleted, by pathspec, so
  nothing else of the user's gets swept in:
  `git add -A -- <those paths>`, then `git commit -m "chore(factory): customize overlay"
  -m "Co-Authored-By: Claude <noreply@anthropic.com>" -- <those paths>`. Never push.

**When `merge.target` changed.** No re-render is needed: the CLI reads it at each claim. Live
jobs keep the target they recorded at claim.

**When `reviewers` or `roles` changed.** A new reviewer key has no agent, and a new model
takes no effect, until the managed files are re-rendered. Tell the user to run `factory upgrade` before the next job; never run it yourself,
because upgrade writes managed files. If live jobs exist, warn that a later `round.started` in
those jobs reads the new `reviewers`.

Finish with what changed, doctor's result, the commit (or why there is none), and whether
`factory upgrade` is needed.

## Ground rules

- One job per session; as many sessions as the user likes. A job is driven only by the session
  that claimed it, or, once it's `needs-human`, by whoever runs `approve`/`rework`/`abandon` on it
  (`abandon` from a working stage needs the user to confirm the driving session is stopped).
  Finding another job in flight is never a reason to stop; it's only a reason for the overlap check.
- Agents write only their own file (a reviewer also its `round-<N>/<key>/` supporting files);
  you write only your job's feature.md and rework notes, backlog ticks, and events through the
  factory CLI (and, in `customize`, the overlay). If an agent wrote somewhere else, note it and tell the user.
- The managed files (this skill and the `factory-*` agents) are never edited by hand. A
  project's own rules for a role live in its overlay, `factory/roles/<role>.md`, which each
  agent reads at run time.
- Keep the user posted with one short line per transition (`003 · review round 1: 3/4 in`).
- Finish every command with the job's stage, decision, and where to read the files.
