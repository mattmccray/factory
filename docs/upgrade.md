# Installing and upgrading the factory

`factory init` and `factory upgrade` run from this repo's source CLI (`packages/cli/src/main.ts`)
with the target project's root as the working directory. What they write, refuse, and exit with
is specified in [`docs/contract/v1.md`](contract/v1.md), "CLI" → "`init` and `upgrade`".

## Installing into a project

```sh
cd /path/to/project
bun /path/to/factory/packages/cli/src/main.ts init
```

This writes the stamped skill and agents under `.claude/`, the self-contained `factory/cli.ts`,
`factory/CONTRACT.md`, a default `factory/config.json` (only if there is none), and
`factory/managed.json`, and adds the runtime-state lines to `.gitignore`. Check the result with
`bun factory/cli.ts doctor`, then commit it.

## Upgrading a project

After pulling a new factory release (and after changing `reviewers` in `factory/config.json`):

```sh
cd /path/to/project
bun /path/to/factory/packages/cli/src/main.ts upgrade
bun factory/cli.ts doctor
```

Upgrade refuses if a managed file was edited locally. Move the change into the overlay
(`factory/config.json` or `factory/roles/<role>.md`), then rerun with `--force` to restore the
rendered bytes.

## Self-upgrade of this repo

This repo runs its own jobs with an installed copy (`.claude/`, `factory/`) that is kept
separate from the source (CLAUDE.md, "Source and state"). Promotion is a human step, done on
`main` after a merge, never inside a job.

**First time (adopting the vendored v0).** The vendored v0 is unstamped (there is no
`factory/managed.json`), and its files differ from the render, so plain `init` refuses and
names them. Adopt it with `--force`:

```sh
cd /path/to/factory          # this repo's root, on main, with no job running
bun packages/cli/src/main.ts init --force
bun factory/cli.ts doctor    # the newly installed CLI; exits 0
git diff --stat              # review: .claude/**, factory/cli.ts, factory/CONTRACT.md, factory/managed.json
```

`factory/config.json`, `backlog.md`, `briefs/`, `jobs/`, and the rest of the overlay and runtime
state are left as they were. The vendored `factory/lib/`, `serve.ts`, and `dashboard.html` were
never managed, so they stay where they are as orphans. The new `factory/cli.ts` no longer
imports `factory/lib/`. Remove the orphans by hand once nothing uses them: `bun run factory`
still serves the old dashboard until Andon replaces it. The root `tsconfig.json` excludes
`factory/cli.ts`, since it is generated, untyped bundle output.

**Later releases.**

```sh
cd /path/to/factory
bun packages/cli/src/main.ts upgrade
bun factory/cli.ts doctor
```

Commit the result as its own `chore(factory): promote …` commit.
