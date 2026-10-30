# Installing and upgrading the factory

`factory init` and `factory upgrade` run from the global `factory` command, with the target
project's root as the working directory. That command is either the release bundle, installed
from GitHub, or a clone's source CLI, linked for developing the factory; both install the same
bytes for the same version. What they write, refuse, and exit with is specified in
[`docs/contract/v1.md`](contract/v1.md), "CLI" → "`init` and `upgrade`".

## Installing the `factory` command

On each machine (macOS or Linux), with Bun installed:

```sh
bun add -g github:mattmccray/factory#release     # the newest release; #release-vX.Y.Z pins one
factory --version                                # factory X.Y.Z (release)
```

This installs the release bundle from this repo's `release` branch: a self-contained build (the
CLI with the rendered installed CLI and the contract built in, the Andon service, and the built
Andon UI) that needs only Bun. To take a newer release, run the same command again, then
`factory service restart` so the Andon service runs it.

### The Andon service

Once per machine, make the Andon service a per-user OS service (launchd on macOS, systemd
`--user` on Linux; no `sudo`) that starts at login and restarts after a crash:

```sh
factory service install   # writes the unit, enables it, and starts it
factory service status    # exits 0 only when it is running
```

The unit runs the `factory` that installed it, by its path, so run `factory service install`
again after switching between the global install and `bun run cli:link` (it rewrites the unit and
restarts it). After taking a new release, `factory service restart`. `factory service run` runs it
in the foreground instead (it replaces `bun run andon:service`), and `factory service uninstall`
removes the unit and keeps the registry in `~/.andon`. On Linux, `install` prints the
`loginctl enable-linger` hint when lingering is off; run it yourself if the box is headless.

### Linking a clone instead (developing the factory)

Once per clone of this repo:

```sh
cd /path/to/factory          # the clone's root
bun install
bun run cli:link             # puts `factory` on your PATH (~/.bun/bin), running this clone's source
factory --version            # factory X.Y.Z (source: /path/to/factory)
```

After pulling a new release, run `bun install` again; the link follows the clone. Whichever ran
last on a machine, the global install or `bun run cli:link`, owns `factory`; rerun
`factory service install` after switching, so the Andon service runs the new owner.

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

After installing or pulling a new factory release, and after changing `reviewers` or `roles` in
`factory/config.json` (both are rendered into the managed agents, so a new reviewer has no agent
and a new model takes no effect until you upgrade):

Merge or settle live jobs before upgrading: let every job whose stage isn't `merged` finish
(or merge it with `/factory approve <id>`) first. An upgrade replaces the skill and agents that
are driving those jobs mid-flight, and jobs claimed before a release that records `target` (the
branch a job merges into) have `target: null`, so the new skill falls back to resolving
`merge.target` from the current config for them.

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
names them. Before promoting, check that `factory` runs this checkout's source:

```sh
factory --version   # must print: factory X.Y.Z (source: /path/to/this/checkout)
```

If it says `(release)` (the global install owns `factory`), names another clone, or `factory` is
not found, rerun `bun run cli:link` from this checkout's root, then check again.

Then adopt it with `--force`:

```sh
cd /path/to/factory          # this repo's root, on main, with no job running
factory init --force
bun factory/cli.ts doctor    # the newly installed CLI; exits 0
git diff --stat              # review: .claude/**, factory/cli.ts, factory/CONTRACT.md, factory/managed.json
```

`factory/config.json`, `backlog.md`, `briefs/`, `jobs/`, and the rest of the overlay and runtime
state are left as they were. The vendored `factory/lib/`, `serve.ts`, and `dashboard.html` were
never managed, so they stay where they are as orphans. Nothing uses them any more: the new
`factory/cli.ts` no longer imports `factory/lib/`, and Andon replaces the old dashboard. Remove
`factory/lib/`, `factory/serve.ts`, and `factory/dashboard.html` by hand. The root `tsconfig.json` excludes
`factory/cli.ts`, since it is generated, untyped bundle output.

**Later releases.** Before promoting, check that `factory` runs this checkout's source:

```sh
factory --version   # must print: factory X.Y.Z (source: /path/to/this/checkout)
```

If it says `(release)` (the global install owns `factory`), names another clone, or `factory` is
not found, rerun `bun run cli:link` from this checkout's root, then check again.

Then cut the release, upgrade, and push:

```sh
cd /path/to/factory          # this repo's root, on main, clean, with no job running
bun install                  # refreshes the workspace links the release borrows
bun run release --dry-run    # optional: runs the gate, prints the next vX.Y.Z and its CHANGELOG.md section
bun run release              # runs the gate, builds the bundle, then: the version and CHANGELOG.md,
                             # chore(release): vX.Y.Z, tag vX.Y.Z, the bundle committed onto release,
                             # tag release-vX.Y.Z
factory upgrade              # installs the release: the stamp and managed.json carry vX.Y.Z's version
bun factory/cli.ts doctor
git add .claude factory && git commit -m "chore(factory): promote vX.Y.Z"
bun run release:push         # pushes main, release, vX.Y.Z, and release-vX.Y.Z; prints the install line
factory service restart      # the Andon service runs the new release
```

`bun run promote` does the local half in one step: `factory upgrade`, the doctor, the
`chore(factory): promote vX.Y.Z` commit, and `factory service restart`. It commits only what lies
under `.claude/` and `factory/`, and refuses, changing nothing, off `main`, with changes outside
those two paths, or when `factory --version` does not name this checkout as its source. It never
pushes; run `bun run release:push` after it.

Commit the upgrade's result as its own `chore(factory): promote …` commit, then push with
`bun run release:push` as the last step. Each machine then takes the release with
`bun add -g github:mattmccray/factory#release` (or the pinned `#release-vX.Y.Z` line it prints).

`bun run release` (decision 14 in `docs/decisions.md`) computes the bump from the Conventional
Commits on `main`'s first-parent history since the newest `v*` tag (pre-1.0: `feat` or a `!`
breaking change bumps the minor, `fix` or `perf` the patch), writes the version into the root
and every workspace `package.json`, and prepends the release's section to `CHANGELOG.md`. With
no `v*` tag yet, it cuts `v0.1.0`, the version already stamped, with no bump. It refuses, writing
nothing, off `main`, on a dirty tree, when nothing user-facing merged since the tag, or when
`vX.Y.Z` or `release-vX.Y.Z` already exists.

Right after the `main` and clean-tree checks, before it computes the version, runs the gate, or
builds anything (on `--dry-run` too, gate or no gate), it checks this checkout's workspace links:
every `workspace:*` dependency of the root and each workspace `package.json` must be a symlink, in
the depending package's own `node_modules` or else the root's, that resolves to that workspace
package. A missing link, one that points elsewhere, or a `workspace:*` name no workspace package
declares refuses with ``workspace links are stale: run `bun install`, then retry``, names each
stale link on the lines after, and writes nothing. The script never runs an install itself: run
`bun install`, then retry.

After those checks, and before it writes anything, it stages the tree it is about to commit:
`HEAD` plus the new versions and changelog, in a temp directory that borrows this checkout's
installed `node_modules`. It runs the gate from `factory/config.json` there, each command through
a shell from the staged tree's root, in order, stopping at the first one that exits non-zero. A
red gate exits 1 with `gate is red: <command>` and writes nothing: no commit, no tag, no `release`
change. With no `gate` in `factory/config.json`, it says no gate is configured and goes on; an
unreadable or invalid `factory/config.json` refuses, writing nothing. `--dry-run` runs the gate
too, the same way, then prints the version and section; it builds no bundle and writes nothing.

Once the gate is green, it builds the release bundle (`scripts/bundle.ts`) from the same staged
tree. If the build fails, it exits non-zero with a one-line reason and writes nothing: no commit,
no tag, no `release` change. On success, after the
`chore(release): vX.Y.Z` commit and the `vX.Y.Z` tag, it commits the bundle onto the `release`
branch with git plumbing (the checkout, `HEAD`, and the working tree never move): each `release`
commit's tree is exactly the bundle, its parent is the previous `release` commit (the first is a
root commit), and its message names the `main` commit it was built from. That commit is tagged
`release-vX.Y.Z`. It never pushes and never runs `factory upgrade`.

`bun run release:push` pushes a cut release to `origin`: `main`, `release`, and the newest
version's `vX.Y.Z` and `release-vX.Y.Z` tags, in one `git push --atomic`, never with a force and
never a `factory/*` ref. It prints each ref pushed and that version's install line,
`bun add -g github:mattmccray/factory#release-vX.Y.Z`. It refuses, pushing nothing, with a
one-line reason: off `main` or detached, a dirty tree, the newest `v*` tag without its
`release-v*` tag (no bundle), `origin/main` (or `origin/release`) holding commits the local
branch lacks, or, when that version is already on `origin`, "nothing to push".
