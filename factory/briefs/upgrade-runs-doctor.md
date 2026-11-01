# `factory upgrade` runs doctor

- Status: done
- Job: 089-upgrade-runs-doctor (merged e5ec1e9, 2026-10-31)
- Sources: packages/cli/src/install.ts (`upgrade`), packages/cli/src/doctor.ts, scripts/promote.ts, docs/upgrade.md, docs/contract/v1.md ("`init` and `upgrade`", `doctor`), factory/briefs/upgrade-commit-flag.md
- Date: 2026-10-31

## Intent
Every upgrade flow is `factory upgrade` followed by `bun factory/cli.ts doctor`, and the second
step is easy to forget. `factory upgrade` should run doctor itself, so one command upgrades and
checks the result, and a red doctor makes the upgrade exit non-zero.

## Decisions
1. Doctor on every upgrade, or behind a flag? → **On by default, no opt-out flag for now.**
   Why: the two always run in sequence; an opt-in flag brings back the forgettable step, and a
   `--no-doctor` can be added later if a need shows up.
2. In-process doctor or the installed CLI? → **A subprocess: `bun factory/cli.ts doctor` from
   the project root, with the Bun running `factory` (`process.execPath`), its lines passed
   through as they print.** Why: it's the one thing upgrade can't check itself, that the freshly
   written `factory/cli.ts` loads and runs; an in-process call would pass even with a broken
   installed bundle.
3. A failing doctor? → **Any `FAIL` (or a doctor that doesn't start or exits non-zero) makes
   upgrade exit 1, with no rollback: the files stay written, and the last line names the
   upgrade's summary and that doctor failed. With `--commit`, doctor runs after the writes and
   before the commit; a failing doctor means no commit, and the line adds "commit the upgraded
   files by hand once doctor passes". `note` lines never fail.** Why: a 0 exit next to a red
   doctor is what this change prevents; never commit an install doctor rejects (promote already
   runs doctor before committing). A doctor failure unrelated to the upgrade (a broken `ready`
   epic plan) still exits 1, the same red the manual step gives, rather than splitting doctor's
   checks.
4. When does doctor run? → **After every upgrade that completes its writes, including one that
   changed nothing (0 written, 0 removed). Never on a refused upgrade or a usage error.** Why: it's
   cheap and it's the check you'd run anyway; a refusal already writes nothing and exits 1 with a
   one-line reason that doctor's output would bury.
5. `bun run promote`? → **`scripts/promote.ts` drops its separate `bun factory/cli.ts doctor`
   step; `factory upgrade` failing (doctor included) still stops it before its commit.** Why: the
   upgrade now covers it; running it twice adds nothing.
6. `init`? → **Out: `init` keeps its manual doctor step.** Why: a first install is usually
   reviewed by hand before anything else (the same reason `init --commit` was deferred).
   Deferred: `init` running doctor.
7. Docs? → **docs/upgrade.md drops the separate doctor command after `factory upgrade` (in
   "Upgrading a project" and "Later releases") and says upgrade runs it; CLAUDE.md's "Promotion"
   paragraph is a hand edit at promotion, not part of the job.** Why: CLAUDE.md is the project's
   instructions, outside a job's usual scope; the skill and role templates never pair upgrade with
   doctor, so they're unchanged.

## Scope
- In: `factory upgrade [--force] [--commit]` in `packages/cli` (both the source CLI and the
  release bundle) running the installed doctor as above; output order: the upgrade's summary
  line, then doctor's lines, then (with `--commit`) the commit line; `scripts/promote.ts` and its
  tests; the contract (docs/contract/v1.md, "`init` and `upgrade`"); docs/upgrade.md; tests.
- Out: an opt-out flag (`--no-doctor`); doctor on `init`; splitting doctor's checks; rolling back
  on a doctor failure; CLAUDE.md, the skill, and role templates; any change to doctor's own
  checks or output.

## Acceptance sketch
- A successful `factory upgrade` prints its summary line, then doctor's lines from the installed
  `factory/cli.ts`, and exits 0 when doctor passes.
- An upgrade that changed nothing still runs doctor.
- When doctor reports a `FAIL` (e.g. a broken `ready` epic plan), upgrade exits 1; the upgraded
  files stay written; the last line names the summary and that doctor failed.
- A broken installed `factory/cli.ts` (doctor can't run) makes upgrade exit 1 the same way.
- `upgrade --commit` with a passing doctor commits as before; with a failing doctor it makes no
  commit, exits 1, and says to commit by hand once doctor passes.
- A doctor `note` line (e.g. a duplicate job number) doesn't change the exit code.
- A refused upgrade or a usage error runs no doctor and prints only its one-line reason.
- `bun run promote` no longer runs doctor as its own step, and still refuses to commit when
  `factory upgrade` exits non-zero.
- docs/upgrade.md no longer lists `bun factory/cli.ts doctor` after `factory upgrade`.

## Contract calls
"`upgrade` runs the installed `factory/cli.ts doctor` after its writes (also when nothing
changed, never on a refusal or usage error), prints doctor's lines after its summary, exits 1
when doctor fails (no rollback), and with `--commit` runs doctor before the commit and makes no
commit when doctor fails", approved by the user on 2026-10-31. Additive within v1. The job must
update docs/contract/v1.md ("`init` and `upgrade`") to match.

## Open
None.
