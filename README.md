# Factory & Andon

> Andon is mission control for your AI development: see every feature moving from spec to merge at a glance, and know the moment one needs you.

The factory runs everyday development as a loop of Claude Code agents that talk only through
markdown files. You hand it a feature, and it comes back merged into your local target branch, or
stopped with a written reason for a human to decide on. Andon is its dashboard.

This page covers what the factory is and how to install, upgrade, and use it. For depth, see the
contract ([`docs/contract/v1.md`](docs/contract/v1.md)), installing and upgrading
([`docs/upgrade.md`](docs/upgrade.md)), and runners other than Claude Code
([`docs/runners.md`](docs/runners.md)).

## What it is

One feature is one **job**, and a job moves through a fixed loop:

```
spec → build → parallel reviews → approve → merge
                     ↑      │
                     └──────┘  (a review asks for changes: the builder takes another round)
```

- **spec**: a spec-writer turns the request into `spec.md`, the job's acceptance criteria.
- **build**: a builder implements it on its own branch and worktree, runs the project's gate,
  and commits.
- **reviews**: the configured reviewers (the `reviewers` keys in `factory/config.json`, for
  example `code`, `security`, `contract`) each review the diff in parallel. The round is done
  only when every one of them has answered. Any `CHANGES` sends the job back to the builder,
  up to `maxRound` rounds.
- **approve**: an approver checks the result against the spec and writes `APPROVE` or
  `ESCALATE`.
- **merge**: an approved job is merged locally into its target branch: `merge.target` in
  `factory/config.json`, by default `current`, the branch your checkout is on when the job is
  claimed (set it to a name such as `develop` to land work there). The target is recorded at
  claim, so the job keeps it for its whole life. The factory never pushes, and never switches
  your checkout's branch: if the checkout isn't on the target at merge time, the job stops in
  `needs-human` and says so. An escalated job stops in `needs-human` until a person approves it
  or sends it back.

The rules that hold it together, from the `factory/v1` contract:

- **The event log is the truth.** Each job has an append-only `factory/jobs/<id>/events.jsonl`.
  `job.json` is a derived snapshot that can be deleted and rebuilt from the log at any time.
- **The CLI is the only writer of job state.** The orchestrator (the Claude Code session running
  `/factory`) runs `factory/cli.ts claim …` to start a job and `factory/cli.ts event …` after
  that; the CLI hands out every job id, takes every timestamp from the system clock,
  enforces the allowed transitions, reads verdicts from the agents' files, appends to the log, and
  rebuilds `job.json`. No agent or model writes job state by hand.
- **Reviewers are configured.** Which reviewers run, the review budget, the gate commands, and
  each role's model are project settings in `factory/config.json`.
- **Managed files vs. the overlay.** The skill, the agents, the installed CLI, and the installed
  contract are **managed files**: rendered by the factory, stamped with a version, hashed in
  `factory/managed.json`, and never edited by hand. A project's own choices live in the
  **overlay**: `factory/config.json` and `factory/roles/<role>.md` (that project's rules for one
  role). Upgrades replace managed files and never touch the overlay.

## Install

You need [Bun](https://bun.sh), git, and Claude Code, on macOS or Linux. Install the `factory`
command globally from GitHub:

```sh
bun add -g github:mattmccray/factory#release     # or #release-vX.Y.Z to pin a version
factory --version                                # factory X.Y.Z (release)
```

This installs the release bundle, a self-contained build on this repo's `release` branch (the
CLI with its installer, the Andon service, and the built Andon UI), and links `factory` into
`~/.bun/bin`. It needs only Bun: no clone, no build step, no dev dependencies. Then install the
factory into a project from that project's root:

```sh
cd /path/to/project      # a git repo
factory init
bun factory/cli.ts doctor
git add .claude factory .gitignore && git commit -m "chore(factory): install the factory"
```

There are two CLIs, and they do different jobs:

| Command | What it is | Runs |
|---|---|---|
| `factory …` | the global command: the release bundle, or a clone's source CLI (below) | `init`, `upgrade`, `projects`, `--version` (it also has the core commands, but use the installed copy for those) |
| `bun factory/cli.ts …` | the project's installed copy, a self-contained managed file | `doctor`, `show`, `claim`, `event`, `rebuild`, `abandon` |

`factory init` writes the skill and agents under `.claude/`, `factory/cli.ts`,
`factory/CONTRACT.md`, a default `factory/config.json` (only if there is none), and
`factory/managed.json`. It adds `factory/jobs/`, `factory/.lock/`, and `factory/.worktrees/` to
`.gitignore`, and registers the project with Andon. Details are in
[`docs/upgrade.md`](docs/upgrade.md).

**Developing the factory.** To run `factory` from a clone's source instead, link it from the
clone's root:

```sh
cd /path/to/factory      # the clone's root
bun install
bun run cli:link         # factory --version now says: factory X.Y.Z (source: /path/to/factory)
```

Whichever ran last, the global install or `bun run cli:link`, owns `factory` on that machine;
`factory --version` tells you which.

## Upgrade

Run the install command again (`bun add -g github:mattmccray/factory#release`) to take the newest
release. With a linked clone, pull instead (`git pull && bun install`); the link follows the
clone. Then, in each project:

```sh
cd /path/to/project
factory upgrade
bun factory/cli.ts doctor
git add .claude factory .gitignore && git commit -m "chore(factory): upgrade the factory"
```

Run `factory upgrade` also after you change `reviewers` or `roles` in `factory/config.json`:
both are rendered into the managed agents, so a new reviewer has no agent, and a new model takes
no effect, until you upgrade. If a managed file was edited locally, upgrade refuses and names it;
see step 7 below.

## Using it

This section follows one feature in an example project, `notes-app`, a small web app with a
`bun test` suite, which wants a "CSV export" button. The `/factory …` commands are typed into a
Claude Code session opened at the project's root.

### 1. Set up once

```sh
cd ~/code/notes-app
factory init
```

Then, in Claude Code:

```
/factory customize
```

`customize` (alias `/factory init`) is an interview that writes only the overlay: the ordered
`reviewers` (say `code` and `security`), the `maxRound` review budget, the Andon settle time, the
`gate` (say `["bun test", "bun run typecheck"]`), each role's model under `roles`, and any
`factory/roles/<role>.md` rules (for example, "tests are colocated as `*.test.ts`" for the
builder). It refuses anything `factory/v1` doesn't allow, runs doctor, and commits the overlay.
Check the install and commit what `init` wrote:

```sh
bun factory/cli.ts doctor        # one line per check; exits 0 when nothing failed
git add .claude factory .gitignore && git commit -m "chore(factory): install the factory"
```

If `customize` changed `reviewers` or `roles`, run `factory upgrade` before the first job.

### 2. Get work in

Work reaches the factory through `factory/backlog.md`:

- **Fuzzy, or touching a contract or a recorded decision:** `/factory explore csv export`. It
  is an interview, one question at a time, that writes a brief, `factory/briefs/csv-export.md`,
  and, once the brief is `ready`, adds a backlog line that points at it. The brief binds the
  spec-writer and approver later.
- **Clear work:** `/factory queue add a CSV export button to the notes list`. It distills the
  text into one `- [ ]` backlog line with what defines done, and commits the backlog. It
  starts nothing.

### 3. Run it

```
/factory next             # the first unchecked backlog line
/factory next csv export  # or the line these words describe
```

The session claims the line (ticking it as `- [x] … → 001-csv-export` and committing the tick
at once, so a running job stays visible and no other session picks it) and runs the loop. Each
stage leaves its file in `factory/jobs/001-csv-export/`:

| Stage | Who | Writes |
|---|---|---|
| claim | the orchestrator | `feature.md` (the request, verbatim) |
| spec | spec-writer | `spec.md` (scope, acceptance criteria, touchpoints) |
| build | builder, in `factory/.worktrees/001-csv-export/` on branch `factory/001-csv-export` | commits on the branch, and `build.md` |
| review | each configured reviewer, in parallel | `round-<n>/review-<key>.md`, e.g. `round-1/review-code.md` |
| approve | approver | `decision.md` (`APPROVE` or `ESCALATE` on its first line) |

Throughout, the CLI keeps `events.jsonl` (the log) and `job.json` (the snapshot) in the same
folder. On `APPROVE`, the orchestrator merges the branch into the job's target branch locally with `--no-ff`,
removes the worktree and branch, removes the job's line from the backlog (which holds only open
and running work), and commits that with the brief's `done` mark. It never pushes: pushing is
yours.

### 4. When it stops

A job stops in `needs-human` when the approver escalates (for example, reviews still ask for
changes after `maxRound` rounds, or the work hits a contract question) or when the merge
conflicts. Read why in `factory/jobs/001-csv-export/decision.md` (and the last round's
reviews), then either:

```
/factory approve 001-csv-export
/factory rework 001-csv-export "keep the export to the visible columns; drop the settings toggle"
```

`approve` merges it as is. `rework` saves your note as `rework-<k>.md`, gives the job a fresh
review budget, and sends it back to the builder.

### 5. Watch it

Andon shows every registered project's board live (see [Andon](#andon)). From the terminal:

```sh
bun factory/cli.ts show 001-csv-export   # stage and timing summary
```

### 6. Side by side

Run as many Claude Code sessions as you like, one job each: each job has its own worktree,
branch, and job folder. Job ids come from the CLI: `bun factory/cli.ts claim <slug>` picks the
next number under its own lock and prints the id, so two sessions never get the same one. The
shared steps, claiming work (running `claim`, then ticking and committing the backlog line),
merging into the target branch, and every other backlog edit, happen under a short lock,
`factory/.lock/`. Each backlog edit is committed at once by the step that makes it, so parallel
jobs never mix; a step that finds uncommitted hand edits in `factory/backlog.md` stops and asks
you to commit or discard them first. Before
claiming, each session runs an **overlap check** against the live jobs; if the new work looks
likely to change the same area, it asks you whether to start it anyway or take a different
backlog line.

### 7. Upgrade

After a new factory release, or after changing `reviewers` or `roles`:

```sh
factory upgrade
bun factory/cli.ts doctor
```

If someone edited a managed file (say `.claude/agents/factory-builder.md`), upgrade refuses and
names it, and doctor reports it as `FAIL … changed`. Move the change into the overlay (here,
`factory/roles/builder.md`), then rerun with `--force` to restore the rendered file:

```sh
factory upgrade --force
```

## Andon

Andon is the dashboard: a board per project, with live timers for each stage and each reviewer,
a needs-human row, and a job drawer with the files and timing. It has three parts: the Andon
service (a daemon), the Andon UI it serves, and Andon, the Mac app.

The Andon service is one Bun daemon per machine. `factory service install` makes it a per-user
OS service (a launchd LaunchAgent, `dev.factory.andon`, on macOS; a systemd `--user` unit,
`andon.service`, on Linux) that starts at login and restarts after a crash, with no `sudo`:

```sh
factory service install   # write the unit, enable it, start it: http://127.0.0.1:8766/
factory service status    # installed, running (pid), the URL, the running and on-disk release, the logs
factory service restart   # after taking a new release (Andon says "Restart service")
factory service start     # or stop; uninstall removes the unit and keeps ~/.andon
factory service run       # the service in the foreground, without installing it
```

The unit runs the installing `factory`'s `service run` with the installing `bun`, so run
`install` again after switching between the global install and `bun run cli:link` to re-point
it. `ANDON_PORT` and `ANDON_HOME`, when set at `install`, are recorded in the unit. `install`
refuses, naming the pid, when another process (an old terminal service, say) holds the port.
Logs go to `~/.andon/service.log` on macOS and to the journal on Linux
(`journalctl --user -u andon.service`). On a headless Linux box, `install` prints the
`loginctl enable-linger` hint when lingering is off, since user services stop at logout without
it; it never changes that setting itself.

From a clone, build the UI the service serves once, and after pulling:

```sh
bun run andon:ui:build
```

The service watches the projects in `~/.andon/projects.json` (`factory init` adds each project;
set `ANDON_HOME` to move the file and `ANDON_PORT` to change the port), streams changes to the
UI, and never writes job state.

A project you delete or move stays registered until you remove it with the linked source CLI:

```sh
factory projects                     # each registered root: ok, missing, or not a factory project
factory projects prune --dry-run     # what prune would remove
factory projects prune               # unregister the missing roots and the non-factory folders
factory projects remove <path>       # unregister one root, whatever its state
```

`prune` skips a root on a removable volume that isn't mounted (`/Volumes/<name>`, `/media/…`,
`/run/media/…`, `/mnt/<name>`), so unplugging a drive doesn't unregister its projects.

Andon, the Mac app, wraps the UI in a window with a tray badge counting needs-human jobs and
native notifications on escalate and merge. It is only a client of the service: it never starts
or stops it, and when none answers it shows a notice naming `factory service install` and
connects once the service is up:

```sh
bun run andon:build   # build the Mac app (and the UI)
bun run andon         # run it
```

## This repo's self-hosting

This repo builds the factory with the factory, but the factory being built is never the factory
doing the building. The source is `packages/` and `apps/`. The installed copy that runs this
repo's jobs is `.claude/` and `factory/`, and no job changes it. Promoting merged source into the
installed copy is a deliberate human step on `main`, after a merge and never mid-job:
`factory init --force` the first time (adopting the vendored v0), then `bun run release` and
`factory upgrade`, each run from this repo's root with `factory` linked to this checkout, and
finally `bun run release:push`. See [`docs/upgrade.md`](docs/upgrade.md), "Self-upgrade of this
repo".

## Rules of thumb

- **One job is one reviewable diff.** If a feature needs several branches, split it into
  several backlog lines.
- **Contract changes go through `/factory explore`.** Six of the first ten jobs here escalated
  for lacking a brief. Settle contract and decision questions in the interview, where they are
  cheap, not after a whole build.
- **Never edit managed files.** Put project rules in the overlay (`factory/config.json`,
  `factory/roles/<role>.md`), and run `factory upgrade` to re-render.
- **Never push.** The factory merges locally; pushing stays a human decision.
