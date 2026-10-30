# The factory CLI installs globally from GitHub

- Status: ready
- Sources: the explore request of 2026-10-29 (pre-1.0 notes, "Prepare for publishing", "`bun install -g …` then `factory service install`"); `docs/decisions.md` decisions 6, 10, 14 and the Deferred list; epic `factory/epics/factory-distribution.md`
- Date: 2026-10-30

## Intent
Matt installs the factory on any of his machines (the Mac Studio, the Linux boxes) with one
`bun` command from GitHub, with no clone to keep around, and gets a `factory` command that can
`init` and `upgrade` projects. It is the base the service commands build on.

## Decisions
1. Amend decision 6? → **Yes: "Installable from GitHub on Matt's own machines (macOS and Linux)
   is in scope. Public publishing stays deferred: no npm registry, no name-collision work, no
   docs site, no public polish." The Deferred line "Distribution for publishing" stays.** Why:
   it covers "if only for ease of my own use" without committing to a public release. Matt
   prefers a direct GitHub install; npm stays possible if the install shape points that way
   later, so the shape shouldn't rule it out.
2. Private repo? → **Matt flips `mattmccray/factory` to public himself when it's ready to be
   the distribution source; no job does it.** Why: verified 2026-10-30, a private repo makes
   `bun add -g github:mattmccray/factory` 404 (bun fetches GitHub's tarball API without
   credentials); public, that short form works with no token or SSH key.
3. What gets installed? → **A built release branch: a self-contained bundle (the CLI with its
   installer, the templates, the contract and the rendered installed `cli.ts` built in; the
   Andon service; the built Andon UI) with a `package.json` `bin`, so a machine needs only bun:
   no clone, no build, no dev dependencies. Upgrading is the same install command again.** Why:
   `main` stays free of build output, and the branch is exactly what an npm package would hold,
   so an npm publish later is only a publish. The cost, accepted: the installer must work
   without the source tree (`bundle.ts` today runs `bun build` over it at install time).
4. The branch, its tags, and their writer? → **Branch `release`, tags `release-vX.Y.Z`
   (install: `bun add -g github:mattmccray/factory#release`, or `#release-v0.2.0` to pin).
   `bun run release`, after its `chore(release)` commit and `vX.Y.Z` tag, builds the bundle and
   commits it onto `release` with git plumbing (as `factory archive` writes `factory/archive`),
   never moving the checkout; each `release` commit's message names the `main` commit it was
   built from. It never pushes: Matt pushes `main`, `release`, and the tags. If the build
   fails, it writes nothing at all, no release commit or `vX.Y.Z` tag either, so a version
   never exists without its bundle.** Why: `vX.Y.Z` must stay on `main` (the script bases each
   release on the newest `v*` tag reachable from `HEAD` and refuses an existing tag); `release`
   stays out of the `factory/` namespace of job, epic, and archive branches; a `/` in a tag may
   not survive bun's GitHub tarball URL.
5. The global command's surface? → **The same commands as the source CLI (`init`, `upgrade`,
   `doctor`, and the core commands), plus `factory --version`, which prints the release and how
   it runs: `factory <version> (release)` or `factory <version> (source: <clone path>)`. On a
   machine, whichever of the global install and `bun run cli:link` ran last owns `factory`; the
   self-upgrade steps check `factory --version` says `source` in this checkout.** Why: Matt
   treats the global install exactly as the link; one code path behaves the same everywhere,
   and the job skills keep calling the project's own `bun factory/cli.ts`.

## Facts (verified 2026-10-30, bun 1.4.2)
- `bun add -g git+ssh://git@github.com/mattmccray/factory.git` installs the raw repo as one
  package: no `factory` bin (the root `package.json` has none), workspace packages unlinked
  (`@factory/contract` doesn't resolve), and no built Andon UI (`apps/andon-ui/dist` is
  gitignored). The repo as it stands can't be used as a global install.
- `bun add -g "git+…#<branch>"` of a branch whose `package.json` has a `bin` links it into
  `$BUN_INSTALL/bin` and runs.
- `init` and `upgrade` run only from source today: `packages/cli/src/bundle.ts` runs
  `bun build` over the source tree and reads `docs/contract/v1.md` at install time.

## Scope
- In: an installer that needs no source tree (the rendered managed core, the installed
  `cli.ts`, and the contract text built into the bundle); a bundle entry with a `package.json`
  `bin: factory`, holding the CLI, the Andon service, and the built Andon UI; `bun run release`
  building it and committing it onto `release` with plumbing, tagged `release-vX.Y.Z`, writing
  nothing on a failed build; `factory --version`; README "Install" and `docs/upgrade.md`
  rewritten around the global install (`cli:link` kept, for developing the factory);
  `docs/decisions.md` decisions 6 and 14 amended.
- Out: an npm publish; any push (Matt pushes `main`, `release`, and the tags); the Mac app's
  install; flipping the repo public; the service commands (brief
  `andon-service-install`); pruning the registry (brief `registry-prune`)

## Acceptance sketch
- `bun run release` (in a test repo) makes its `chore(release)` commit and `vX.Y.Z` tag, then a
  `release` commit naming that `main` commit, tagged `release-vX.Y.Z`; the checkout and working
  tree don't move; nothing is pushed.
- A failing bundle build leaves no release commit, no tags, and no `release` commit.
- `bun add -g "git+file://<test repo>#release"` into a temp `BUN_INSTALL` links a `factory` that
  runs with no clone present: `factory --version` prints `factory <version> (release)`, and
  `factory init` then `factory doctor` in a fresh git repo install and pass, byte-identical to a
  source install of the same version.
- `factory upgrade` from the global install replaces a project's managed core and leaves its
  overlay alone, as from source.
- From source, `factory --version` prints `(source: <clone path>)`.
- The bundle's Andon service runs and serves the built UI.

## Contract calls
"Decision 6 amended: installable from GitHub on Matt's own machines (macOS and Linux) is in
scope; public publishing stays deferred", approved by Matt on 2026-10-30. The job updates
`docs/decisions.md` decision 6 to match.

"Decision 14 amended: `bun run release` also builds the self-contained bundle and commits it
onto the `release` branch, tagged `release-vX.Y.Z` (decision 4 above); a failed build writes
nothing", approved by Matt on 2026-10-30. The job updates `docs/decisions.md` decision 14 and
`docs/upgrade.md`'s release steps to match.

## Open
None.
