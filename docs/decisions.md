# Decisions

The factory's binding decisions, the invariants carried over from the Minerva build, and what is
deferred. Decisions are binding unless revisited with Matt. The spec-writer cites them by
number, so the numbers don't change. A retired decision keeps its number and says so. Deferred
work is out of scope for any job until it's moved onto the backlog.

How the repo is laid out, the gate, and the promotion rules are in `CLAUDE.md`. The `factory/v1`
contract is `docs/contract/v1.md`.

## Decisions

1. **This repo is the factory itself,** not just a dashboard. Minerva is its first consumer and
   the reference it was extracted from.
2. **The contract was proven in use before it was fixed.** v1 started as Minerva's working
   draft and is now `docs/contract/v1.md`. Within v1 it changes only additively, and a change to
   its surface updates the doc in the same diff.
3. **An append-only per-job event log** (`jobs/<id>/events.jsonl`) is the truth. It records
   per-stage *and* per-agent timing, because parallel reviewers hide each other's durations
   in stage-level timing.
4. **A CLI is the only writer.** It takes timestamps from the system clock (never from the
   model), validates events and transitions (including WAIT FOR ALL), reads verdicts from the
   agents' files, appends to the log, and regenerates `job.json` as a disposable projection.
   The orchestrator runs commands; it never writes JSON.
5. **Andon's UX is the accepted design,** `docs/design/andon-overview/design.md` (accepted
   2026-10-26), which replaced the Kanban board ported from Minerva. Carried over from that
   board:
   - live timers show time in stage, total time, each reviewer's time, and how long a
     needs-human job has been waiting, all computed from the snapshot's timestamps;
   - needs-human work comes first (the design's "Trouble first");
   - "settled" is a view: merged jobs older than `settleAfterHours` (default 24) leave the
     overview for the Settled sheet;
   - a settled job's timing (stage bar, stage table, agent table) stays reachable in the
     inspector after it leaves the overview.
6. **Personal now, publishable later.** Keep the contract and the boundary between managed
   files and overlay clean enough that publishing never needs a rewrite. Don't spend effort on
   public polish yet.
   - Amended 2026-10-30 (approved by Matt; brief `factory/briefs/cli-global-install.md`):
     installable from GitHub on Matt's own machines (macOS and Linux) is in scope:
     `bun add -g github:mattmccray/factory#release` installs the release bundle (decision 14).
     Public publishing stays deferred: no npm registry, no name-collision work, no docs site, no
     public polish. The bundle is shaped like a package (a `package.json` with `bin: factory`),
     so an npm publish later is only a publish.
7. **Names:**
   - "factory" is the contract identifier: `/factory`, a `factory/` folder in each project,
     a `factory` CLI, and `schema: "factory/v1"`;
   - the dashboard is called **Andon** (its parts are named in decision 10);
   - in prose it's "the factory", with no "The";
   - everything lives in one repository, here.
8. **Managed core plus project overlay.**
   - Managed files (skill, role templates, CLI) are stamped with a version and hash and must
     not be edited. The stamped version is the factory's release version (decision 14), read
     from `@factory/templates`' `package.json`.
   - The overlay is `factory/config.json` (reviewers, per-role model/runner, gate commands,
     issue tracker, merge policy, `maxRound`, settle threshold) plus `factory/roles/<role>.md`
     (each project's rules for a role).
   - `/factory customize` (alias `init`) edits only the overlay. `factory doctor` verifies
     managed hashes and validates config. `factory upgrade` replaces managed files and leaves
     the overlay alone.
   - Fixed: the lifecycle stages, event types, file layout and CLI. Configurable: reviewers,
     rules, models, gates, tracker and merge policy. Decision 13 (epics, 2026-10-29) added to
     what is fixed: the epic events and `epic.json`, the plan file and `jobs/epics/<slug>/` in
     the file layout, and the `epic` commands and `claim`'s `epic=`/`kind=` in the CLI; and to
     what is configurable: `epic.maxParallel`.
   - Required roles: spec-writer, builder, approver, and at least one reviewer.
9. **Harnesses:**
   - v1 targets Claude Code only (Matt uses it for about 99% of his work).
   - The design stays harness-neutral: a role's `runner` is part of the config (for example
     `{"runner": "claude", "model": "opus"}`), so other harnesses can *fill roles* (such as a
     Codex reviewer, for cross-model review) before they can *orchestrate*.
   - Codex, Pi and OpenCode as orchestrators come later, one adapter at a time, each starting
     with a research task.
   - Resuming the same builder between rounds is optional. The fallback is a fresh builder
     working from files (the rework path already does this).
10. **Andon architecture:**
    - Names (2026-10-27, job 029): the daemon is the **Andon service** (`packages/andon-service`),
      the board is the **Andon UI** (`apps/andon-ui`), and the Mac app is **Andon**
      (`apps/andon`). "Agent" means only the factory's subagents. The daemon was "andon-agent"
      and the Mac app "the shell" before then.
    - The Andon service is a Bun daemon per machine. It knows the projects registered on that
      machine, watches their `factory/` trees (no polling), reuses the CLI's contract code,
      and streams changes over server-sent events. It is read-only.
    - The Andon UI is a Svelte web app that connects to one or more services. Supporting
      multiple machines later just means adding more service URLs.
    - Andon, the Mac app, is a thin **Tiny JS** wrapper (https://tinyjs.app) around the UI. It
      starts the local service if needed (amended 2026-10-30, below: it no longer does) and adds
      a tray badge with the needs-human count, plus native notifications on escalate and merge.
    - The Mac app must stay thin enough to swap out. Tiny JS moves fast and has had breaking
      changes, and its backend is txiki.js, not Node, so the contract code must not run there.
    - Registration: `factory init` registers a project with the local service. (Adding or
      removing projects from Andon itself is deferred.)
    - Amended 2026-10-30 (approved by Matt; brief `factory/briefs/andon-service-install.md`):
      the OS service manager is the Andon service's only owner. `factory service install` makes
      it a per-user launchd LaunchAgent (`dev.factory.andon`, macOS) or systemd `--user` unit
      (`andon.service`, Linux), with no `sudo`, started at login and restarted after a crash,
      running the installing `factory`'s `service run`. The Mac app no longer starts the service
      (or stops it on quit): when its probe finds none, it shows a notice naming
      `factory service install`. One owner, so an app-spawned copy and a launchd copy never race
      for the port, and a Linux box with no Mac app works the same way.
11. **The factory builds itself.**
    - This repo was seeded by hand once (2026-10-22) with a vendored v0 copy of Minerva's
      factory. Everything since goes through `/factory`.
    - **The factory being built is never the factory doing the building.** Source is
      `packages/` and `apps/`. The installed copy that runs the jobs is `.claude/` and
      `factory/`, like any consumer's, and jobs never change it. What a job may change is in
      `CLAUDE.md` ("Source and state").
    - After a merge, an explicit self-upgrade (`factory upgrade` run against this repo) promotes
      the new version. A job never modifies its own orchestrator mid-run.
    - `factory/` holds only the installed copy, the overlay, and runtime state, so the builder
      rule "never write under `factory/`" holds unchanged.
12. **This repo's reviewers:**
    - **code**;
    - **security** (the Andon service serves HTTP, and the CLI writes files);
    - **contract**, which checks every change against the schema and versioning rules;
    - **ui**, for Andon changes; it simply PASSes when Andon isn't touched.

13. **Epics** (2026-10-29, accepted by Matt): the design is `docs/design/epics/design.md`, and
    it binds the briefs that build it.
    - An epic is a new first-class thing, kept thin: a tracked plan, `factory/epics/<slug>.md`,
      listing member briefs and their `after:` edges; its own CLI-written log and derived
      `epic.json` under `factory/jobs/epics/<slug>/`; and member jobs that stay ordinary jobs,
      tied to it only by `epic` and `kind` on `job.claimed`. One run per plan.
    - An epic has its own integration branch, `factory/epic/<slug>`, and worktree; members
      branch from it and merge into it, and the epic lands on its target with one merge.
    - The CLI owns the epic's setup and teardown and all of its scheduling (`epic next`, and the
      checks `claim … epic=` makes, including `epic.maxParallel`); every merge stays with the
      orchestrator.
    - It extends decisions 3 and 4 across files: the epic's log is the truth, `epic.json` is a
      disposable projection over the log, the plan, and the epic's jobs, and the CLI is its only
      writer. It amends decision 8's fixed list (above). The contract is `docs/contract/v1.md`,
      "Epics".
    - On `factory/archive`, an epic is `epics/<slug>/` with its `events.jsonl` and its plan as
      `plan.md`, not its `epic.json`, as jobs omit `job.json`. This narrows decision 7 of brief
      `epic-cli` (`factory/briefs/epic-cli.md`), which also listed `epic.json`; the narrowing was
      approved by Matt on 2026-10-29. A reader re-projects `epic.json` from the archived epic log,
      that plan, and the archived member logs (brief `andon-epics-service`).

14. **Releases** (2026-10-29, accepted by Matt; brief `factory/briefs/factory-release.md`).
    - One release version for everything shipped from this repo (CLI, skill and agents, Andon
      service, UI, Mac app). The contract keeps its own `schema: "factory/v1"` and dated additive
      changes, separately. A project's installed version is its `managed.json` `version`.
    - The version moves only at promotion, never in a job: `bun run release` (root tooling,
      `scripts/release.ts`, not a `factory` command), run by a human on `main` as promotion's
      first step, then `factory upgrade` as before. The bump comes from the Conventional Commits
      since the newest `v*` tag: pre-1.0, `feat` and breaking (`!`) bump the minor and
      `fix`/`perf` the patch.
    - The changelog is deterministic, with no model at release time: one entry per job merge on
      `main`'s first-parent history (a `Land epic` merge expands into its members' job merges),
      plus direct commits on `main` whose type is user-facing. `feat`, `fix`, `perf`, and `!` are
      in; `chore`, `specs`, `docs`, `test`, and `refactor` are out. The text is the subject
      without its type, the scope maps to an area (`andon*` → Andon, `templates` → Skill, `cli`
      → CLI, `contract` → Contract), and the job id is kept. The bump comes from the same entries.
    - `CHANGELOG.md` at this repo's root, written only by the release script, in a strict format
      (Andon's service parses it): `## vX.Y.Z (YYYY-MM-DD)`, then `### Breaking` / `### Added` /
      `### Fixed` (empty ones left out), newest release first, each entry
      `- <Area>: <text> (<job id>)`, with no job id for a direct commit and no area without a
      scope. It is not installed into consumer projects.
    - The version is written into the root `package.json` and every `packages/*` and `apps/*`
      one; `@factory/templates`' stays the one code reads (the stamp, `managed.json`).
    - The first release, with no `v*` tag, is `v0.1.0` (the version already stamped, no bump) on
      `main`'s `HEAD`, and its section covers the whole history. Every later run bumps from the
      newest `v*` tag.
    - The script refuses, writing nothing, off `main` (or detached), on a dirty tree, or with
      nothing user-facing since the tag ("nothing to release"). `--dry-run` prints the version
      and section and changes nothing. A non-Conventional first-parent subject is skipped and
      named. It commits `chore(release): vX.Y.Z`, tags `vX.Y.Z` annotated (`factory vX.Y.Z`),
      and never pushes or runs `factory upgrade`.
    - Amended 2026-10-30 (approved by Matt; brief `factory/briefs/cli-global-install.md`):
      `bun run release` also builds the self-contained release bundle (`scripts/bundle.ts`: the
      CLI with the rendered installed CLI and the contract built in, the Andon service, the built
      Andon UI, `CHANGELOG.md`, and a `package.json` with `bin: factory`), from the tree it is
      about to commit and before it writes anything, so a failed build writes nothing: no
      commit, no tag, no `release` change, and a version never exists without its bundle. After
      the `vX.Y.Z` tag, it commits the bundle onto the `release` branch with git plumbing (never
      moving the checkout), each commit naming the `main` commit it was built from, and tags it
      `release-vX.Y.Z` (annotated). The branch and tags stay out of the `factory/` namespace,
      and no tag has a `/`. `bun run release:push` (`scripts/release-push.ts`), run by Matt as
      promotion's last step after the `chore(factory): promote …` commit, pushes `main`,
      `release`, `vX.Y.Z`, and `release-vX.Y.Z` to `origin` in one `git push --atomic`, never
      forced and never a `factory/*` ref, and prints the install line; `bun run release`
      itself still never pushes.

## Invariants

Lessons from the Minerva build that the contract and CLI must keep:

- **Span labels can't be harness agent IDs.** `agent.started` runs *before* the spawn, so the
  agent's ID doesn't exist yet, and Claude Code's Agent tool has no name parameter. The builder
  span is always labeled `builder-<id>`; the returned agent ID is only the resume target. Any
  harness adapter must keep span identity independent of the harness's own agent IDs.
- **Escalation is allowed from any working stage,** not just approve. That's the recovery path
  when an agent never writes its file. Escalating closes any open agent spans, and the
  escalation or merge-failure reason becomes the card's note.
- **`job.merged` is recorded right after `git merge` succeeds,** before worktree and branch
  cleanup, so a failed cleanup can't leave git and the board disagreeing.
- **`job.human-approved` is idempotent while needs-human,** so a session that dies between
  approving and merging can retry.
- **The CLI's value parsing is narrow on purpose.** Only `round`, `maxRound` and `k` are
  integers, `reviewers` is a JSON array and `null` is null; everything else is a string, so an
  all-digit short sha stays a sha. Free-text values are single-quoted in the skill.
- **The CLI defends itself.** It takes a per-job lock (`.events.lock`), refuses legacy jobs and
  a log with a torn last line, creates nothing when it rejects an event, and checks job IDs
  before building any path.
- **The gate typechecks.** Strict `tsc` with `noUncheckedIndexedAccess` and Bun types is part of
  the gate, never a step agents remember to run by hand.

## Known gaps

Deliberately unfixed, but real:

- The stale-lock break has a check-then-act race: two waiters can both see a stale lock, and
  the second can remove the lock the first just took (`packages/contract/src/store.ts`,
  `acquire`).
- A spec-writer rerun after a spec-stage rework is timed under `build`, because `job.reworked`
  always enters `build`.

## Deferred (don't build yet)

- Codex, Pi and OpenCode orchestrator adapters, each starting with a research task.
- Andon across multiple machines (the service design already allows it).
- Adding or removing projects from Andon (decision 10). Today only `factory init` registers one,
  and the service is read-only.
- Reviewers that run only when certain files change.
- Distribution for publishing: name collision checks, a package registry, docs site.
- Reconstructing timing for legacy jobs (001–018) from git history; they show no timing.
- A friendlier changelog line per job (an approver template change) or a model-written rewrite;
  today the entry is the job's merge subject (decision 14).
