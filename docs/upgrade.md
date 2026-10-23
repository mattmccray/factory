# Installing and upgrading the factory

`factory init` and `factory upgrade` run from this repo's source CLI, linked onto your PATH as
`factory`, with the target project's root as the working directory. What they write, refuse, and exit with
is specified in [`docs/contract/v1.md`](contract/v1.md), "CLI" → "`init` and `upgrade`".

## Linking the `factory` command

Once per clone of this repo:

```sh
cd /path/to/factory          # the clone's root
bun install
bun run cli:link             # puts `factory` on your PATH (~/.bun/bin), running this clone's source
```

After pulling a new release, run `bun install` again; the link follows the clone.

## Installing into a project

```sh
cd /path/to/project
factory init
```

This writes the stamped skill and agents under `.claude/`, the self-contained `factory/cli.ts`,
`factory/CONTRACT.md`, a default `factory/config.json` (only if there is none), and
`factory/managed.json`, and adds the runtime-state lines to `.gitignore`. Check the result with
`bun factory/cli.ts doctor`, then commit it.

To tailor the overlay (`factory/config.json` and `factory/roles/<role>.md`) after installing,
run `/factory customize` (alias `/factory init`) in Claude Code: an interview that writes only the
overlay, refuses changes that would break `factory/v1`, runs doctor, and commits the overlay.

## Upgrading a project

After pulling a new factory release, and after changing `reviewers` or `roles` in
`factory/config.json` (both are rendered into the managed agents, so a new reviewer has no agent
and a new model takes no effect until you upgrade):

```sh
cd /path/to/project
factory upgrade
bun factory/cli.ts doctor
```

Upgrade refuses if a managed file was edited locally. Move the change into the overlay
(`factory/config.json` or `factory/roles/<role>.md`), then rerun with `--force` to restore the
rendered bytes.

## Self-upgrade of this repo

This repo runs its own jobs with an installed copy (`.claude/`, `factory/`) that is kept
separate from the source (CLAUDE.md, "Source and state"). Promotion is a human step, done on
`main` after a merge, never inside a job. Run it with the `factory` command linked from this
checkout, so the source it installs is the source on `main`.

**First time (adopting the vendored v0).** The vendored v0 is unstamped (there is no
`factory/managed.json`), and its files differ from the render, so plain `init` refuses and
names them. Before promoting, check that `factory` is linked to this checkout:

```sh
readlink -f "$(which factory)"   # must print a path inside this checkout: …/packages/cli/src/main.ts
```

Use `-f`: plain `readlink` stops at Bun's global link (`../install/global/node_modules/…`)
and never shows the clone. If it prints a path in another clone, or nothing, rerun
`bun run cli:link` from this checkout's root, then check again.

Then adopt it with `--force`:

```sh
cd /path/to/factory          # this repo's root, on main, with no job running
factory init --force
bun factory/cli.ts doctor    # the newly installed CLI; exits 0
git diff --stat              # review: .claude/**, factory/cli.ts, factory/CONTRACT.md, factory/managed.json
```

`factory/config.json`, `backlog.md`, `briefs/`, `jobs/`, and the rest of the overlay and runtime
state are left as they were. The vendored `factory/lib/`, `serve.ts`, and `dashboard.html` were
never managed, so they stay where they are as orphans. The new `factory/cli.ts` no longer
imports `factory/lib/`. Remove the orphans by hand once nothing uses them: `bun run factory`
still serves the old dashboard until Andon replaces it. The root `tsconfig.json` excludes
`factory/cli.ts`, since it is generated, untyped bundle output.

**Later releases.** Before promoting, check that `factory` is linked to this checkout:

```sh
readlink -f "$(which factory)"   # must print a path inside this checkout: …/packages/cli/src/main.ts
```

Use `-f`: plain `readlink` stops at Bun's global link (`../install/global/node_modules/…`)
and never shows the clone. If it prints a path in another clone, or nothing, rerun
`bun run cli:link` from this checkout's root, then check again.

Then upgrade:

```sh
cd /path/to/factory
factory upgrade
bun factory/cli.ts doctor
```

Commit the result as its own `chore(factory): promote …` commit.
