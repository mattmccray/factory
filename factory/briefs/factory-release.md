# Factory releases and changelog

- Status: ready
- Sources: the explore request of 2026-10-29 (versioning, a stale-version indicator in Andon, an automated changelog shown in Andon); epic plan `factory/epics/factory-versioning.md`
- Date: 2026-10-29

## Intent
The factory gets a real release version that moves when the factory changes, cut at promotion
by a script that computes the bump from the Conventional Commits and writes a user-facing
changelog. That version is what every installed copy is stamped with, so Matt can tell which
release a project runs and read what changed between releases.

## Decisions
1. What carries a version? → **One factory release version for everything shipped from this
   repo (CLI, managed skill and agents, Andon service, UI, Mac app); the contract keeps its own
   `schema: "factory/v1"` major and dated additive-change list, separately.** Why: the parts
   ship together from one clone, so per-part versions would add a compatibility matrix nothing
   needs; the schema answers a different question (can these files be read) than the release
   (how new is this install). A project's installed version is its `managed.json` `version`; a
   machine's is the release its Andon service runs.
2. How and when is the version bumped? → **At promotion, never in a job: a `bun run release`
   script in this repo (root tooling, not a `factory` CLI command), run by a human on `main`
   as promotion's first step. It computes the bump from the Conventional Commits since the last
   `v*` tag (pre-1.0: `feat` → minor, `fix`/`perf` → patch, breaking → minor), writes the
   version into `@factory/templates`' `package.json` (which feeds the stamp), prepends a
   user-facing changelog section, commits `chore(release): vX.Y.Z`, and tags `vX.Y.Z`. Then
   `factory upgrade` installs it as today. The first run tags today's state as the baseline.**
   Why: parallel jobs bumping one `package.json` and changelog would conflict at every merge and
   can't know their release; promotion is already the deliberate "this is a release" step;
   consumers never cut factory releases, so it stays off the v1 CLI surface.
3. Where do changelog entries come from, and who words them? → **One entry per job, from its
   merge commit on `main`, formatted deterministically (no model at release time).** The script
   walks `main`'s first-parent history since the last tag: each job merge is one entry; a
   `Land epic` merge expands into its members' merges (the epic branch's first-parent history);
   direct commits on `main` count only when their type is user-facing. `feat`, `fix`, `perf`,
   and breaking (`!`) changes are in; `chore`, `specs`, `docs`, `test`, and `refactor` are out.
   Entries are grouped under Breaking / Added / Fixed, written as the subject without its type,
   the scope mapped to a friendly area (e.g. `andon-ui`/`andon-service` → Andon, `templates` →
   Skill), with the job id kept. The bump is computed from the same entries. Why: the approver's
   merge line is already a reviewed, one-line, plain-English summary of one job; deterministic
   output is reproducible and keeps promotion model-free. A friendlier per-job line (approver
   template change) or a model rewrite can come later.
4. Where does the changelog live? → **One `CHANGELOG.md` at this repo's root, written only by
   the release script, in a strict format: `## vX.Y.Z (YYYY-MM-DD)`, then `### Breaking` /
   `### Added` / `### Fixed` lists (an empty section is left out), newest release first. Each
   entry is one line, `- <Area>: <text> (<job id>)`: no ` (<job id>)` for a direct commit on
   `main`, and no `<Area>: ` when the commit had no scope (clarified 2026-10-29, shared with
   member `andon-version-service`, which parses it), e.g.
   `- Andon: show epics as sub-lanes, epic page, and epic-level waits (056-andon-epics-ui)`.
   It is not installed into
   consumer projects; a project only says which version it runs (`managed.json`).** Why: one
   human-readable file (renders on GitHub too) with no JSON twin to drift; each machine's Andon
   service parses it from its own clone (member `andon-version-service`), and a script-written
   format keeps that parsing simple.
5. Which `package.json` files carry the version? → **The release script writes the same
   version into the root `package.json` and every workspace package's (`packages/*`,
   `apps/*`); `@factory/templates`' stays the one code reads (the stamp, `managed.json`, the
   service's on-disk release).** Why: one release (decision 1), so no stray `0.0.0` misleads;
   the packages are private, so it's free; the stamp and `upgrade`'s `old -> new` keep working.
6. What does the first release contain? → **With no `v*` tag yet, the first run cuts `v0.1.0`
   (the version already stamped everywhere; no bump) on `main`'s `HEAD`, and its changelog
   section holds the whole history so far: every job merge on `main`'s first-parent history
   (56 today, all Conventional) plus the direct user-facing commits from the hand-seeded days.
   Every later run bumps from the newest `v*` tag.** Why: "What's new" has real content from
   day one, and every project stamped `0.1.0` honestly reads as `v0.1.0` and goes `behind` at
   the next release.
7. What does the script refuse, and never do? → **It refuses, writing nothing, when the
   checkout isn't on `main`, the working tree is dirty, or nothing user-facing merged since the
   last tag ("nothing to release"). `--dry-run` prints the next version and the section it would
   write, changing nothing. It never pushes (commit or tag) and never runs `factory upgrade`:
   promotion stays `bun run release`, then `factory upgrade` + doctor + the existing
   `chore(factory): promote …` commit. A first-parent commit whose subject isn't Conventional is
   skipped and named in its output, not fatal. The tag is annotated (`factory vX.Y.Z`).** Why:
   it matches how the factory treats `main` (refuse on a dirty or unexpected checkout, pushing
   is human, upgrade's managed-file writes are reviewed before committing).

## Scope
- In: a `bun run release` script (root tooling; its code under a workspace package or a root
  `scripts/`, the builder's call) with `--dry-run`; `CHANGELOG.md` at the repo root in the strict
  format of decision 4; the version written to the root and every workspace `package.json`; the
  baseline behavior of decision 6; the refusals of decision 7; tests (`bun:test`) for the bump
  rule, entry selection and formatting (including `Land epic` expansion, `!` breaking, skipped
  non-Conventional subjects), and the refusals, against throwaway git repos; decision 14 in
  `docs/decisions.md` (and the pointer in decision 8, and the new deferred line);
  `docs/upgrade.md` "Self-upgrade of this repo" and `CLAUDE.md` "Promotion" updated to
  release-then-upgrade.
- Out: running the script for real, tagging, or committing a release inside the job (cutting
  `v0.1.0` is the human's first promotion after the epic lands, so the job commits no
  `CHANGELOG.md` content beyond what tests need in fixtures); pushing; any `factory` CLI command
  or `factory/v1` contract change; installing the changelog into consumer projects; Andon
  changes (members `andon-version-service`, `andon-version-ui`); a model-written or per-job
  hand-written changelog line.

## Acceptance sketch
- `bun run release --dry-run` on this repo, with no `v*` tag, prints `v0.1.0` and a section with
  one entry per job merge on `main` (plus the direct user-facing commits), grouped Breaking /
  Added / Fixed, each entry the subject without its type, a friendly area, and the job id; it
  changes nothing.
- On a test repo with a `v*` tag, a `feat` since it bumps the minor, only `fix`/`perf` bump the
  patch, a `!` bumps the minor (pre-1.0), and `chore`/`specs`/`docs`/`test`/`refactor` alone
  give "nothing to release" with nothing written.
- A `Land epic` merge appears as its members' entries, not as one entry.
- A real run writes the version into every `package.json`, prepends the section to
  `CHANGELOG.md` (creating it the first time), commits `chore(release): vX.Y.Z`, and creates the
  annotated tag `vX.Y.Z`; it never pushes and never runs `factory upgrade`.
- Off `main`, or with a dirty tree, it refuses with one line and writes nothing.
- A non-Conventional first-parent subject is skipped and named in the output.
- `docs/decisions.md` has decision 14; `docs/upgrade.md` and `CLAUDE.md` describe promotion as
  release, then upgrade, doctor, and the promote commit.
- The gate (`bun run test && bun run check`) passes.

## Contract calls
- "New binding decision 14, Releases, in `docs/decisions.md` (this brief's decisions in short
  form), a pointer from decision 8 that the stamped version is the release version, and a
  deferred line for a friendlier per-job or model-written changelog", approved by Matt on
  2026-10-29. The job must update `docs/decisions.md` to match.
- "This job may edit `CLAUDE.md`'s Promotion paragraph (outside the paths jobs normally change)
  to describe promotion as `bun run release` on `main`, then `factory upgrade`, doctor, and the
  promote commit", approved by Matt on 2026-10-29. The job must update `CLAUDE.md` and
  `docs/upgrade.md` to match.

## Open
None.
