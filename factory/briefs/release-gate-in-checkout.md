# Release runs its gate in the checkout

- Status: ready
- Sources: scripts/release.ts (`stageTree`, `mirrorModules`, `release`), scripts/release.test.ts, docs/decisions.md (decision 14 and its 2026-10-30 amendment), docs/upgrade.md ("Later releases"), factory/briefs/factory-release.md; the failed release of 2026-10-31 (`packages/andon-service/src/archive.test.ts:89`, `git remote -v` exiting 128 in the `git archive` export)
- Date: 2026-10-31

## Intent
`bun run release` runs the gate in a `git archive` export of `HEAD` with a borrowed
`node_modules`, not in the checkout every job gate runs in. Tests that pass in every job then fail
at release for reasons that exist only in the export (no `.git`), which blocked two releases on
2026-10-31. The release should run the gate where everything else runs it, so "green in a job"
means "green at release".

## Decisions
1. Keep the `git archive` export? → **No. Release runs the gate in the checkout, after the `main`
   and clean-tree refusals and before writing anything; a red gate still refuses and writes
   nothing. The export (`stageTree`, `mirrorModules`) goes.** Why: release already requires a
   clean `main`, so the checkout is `HEAD`; the export only adds failures that can't happen
   anywhere else (no `.git`, drift in the borrowed `node_modules`), and a slower, more complex
   script.
2. A failed bundle build? → **Order: gate in the checkout (red → refuse, nothing written), then
   write the versions and `CHANGELOG.md`, then build the bundle from the checkout into a temp
   dir. A failed build restores exactly the files release wrote (`git checkout -- <paths>`) and
   exits 1 with a one-line reason: no commit, no tag, no `release` change. On success, commit,
   tag, and the bundle commit run as today.** Why: the bundle carries `CHANGELOG.md` and the
   versioned `package.json`, so it has to be built after those writes; the tree is known clean,
   so the restore touches only release's own writes, and a version still never exists without
   its bundle. A temp `git worktree` was rejected: it needs its own `bun install`, slower and
   possibly online, the same kind of drift this removes.
3. `--dry-run`? → **Runs the gate in the checkout, then prints the version and section; builds
   no bundle and writes nothing.** Why: today's behavior minus the export.
4. The workspace-links check? → **Kept, unchanged (same place, same message).** Why: the bundle is
   still built from the checkout's `node_modules`, so a stale `bun install` should still refuse
   up front.
5. `archive.test.ts`'s `remote -v` assertion? → **Fixed in this job: it runs in a temp repo the
   test creates (`git init` plus an `origin` remote), not `import.meta.dir`.** Why: not needed to
   unblock the release once the gate runs in the checkout, but a test that depends on where the
   tree sits breaks again in a tarball or sandbox; it's a few lines.

## Scope
- In: `scripts/release.ts` (drop `stageTree`, `mirrorModules`, `moduleDirs`, and the `modules`
  option; gate in the checkout; write, build, restore-on-failure); `scripts/release.test.ts`;
  `packages/andon-service/src/archive.test.ts` (the `remote -v` assertion); docs/decisions.md
  (decision 14's 2026-10-30 amendment); docs/upgrade.md ("Later releases" and the release
  paragraphs); the header comment in `scripts/release.ts`.
- Out: dropping the release gate altogether; any change to `scripts/bundle.ts`, `release:push`,
  `promote`, the bump or changelog rules, or the refusals (off `main`, dirty tree, nothing to
  release, existing tags, stale links); the factory's job gate; other tests.

## Acceptance sketch
- `bun run release` runs each gate command from the checkout's root; a test that needs `.git`
  (like `git remote -v` from its own folder) passes there.
- A red gate refuses with `gate is red: <command>` and leaves the tree, `HEAD`, tags, and
  `release` exactly as they were.
- A failed bundle build exits 1 with a one-line reason; the version and changelog edits are
  restored, so the tree is clean and no commit, tag, or `release` change exists.
- A successful release makes the same commits, tags, and bundle commit as before.
- `--dry-run` runs the gate in the checkout, prints the version and section, and writes nothing.
- The workspace-links check and every other refusal behave as before.
- No `git archive` export or temp copy of the source tree is made (a temp dir for the bundle
  output and the plumbing index is fine).
- `archive.test.ts` passes when its directory isn't inside a git repo.
- docs/decisions.md and docs/upgrade.md describe the gate in the checkout and the restore on a
  failed build.

## Contract calls
"Decision 14's 2026-10-30 amendment: the gate runs in the checkout before anything is written,
and the bundle is built from the checkout after the version and changelog writes; a failed build
restores those writes, so no commit, tag, or `release` change exists and a version never exists
without its bundle", approved by the user on 2026-10-31. The job must update docs/decisions.md
(decision 14) and docs/upgrade.md to match.

## Open
None.
