# `factory projects` lists, prunes, and removes registered projects

- Status: ready
- Sources: the explore request of 2026-10-29 (pre-1.0 notes: "Maybe support cleanup too, for projects that we registered but the paths are no longer valid"); `packages/contract/src/registry.ts`; `docs/contract/v1.md` "Andon registry"; `docs/decisions.md` decision 10 and the Deferred list; epic `factory/epics/factory-distribution.md`
- Date: 2026-10-30

## Intent
Projects Matt registered with Andon whose folders are gone (deleted, moved, or no longer factory
projects) stop cluttering the board: the CLI lists the registry with each project's state,
prunes the dead ones, and removes one by hand.

## Decisions
1. The commands, and what counts as dead? → **`factory projects` lists every registered root
   with its state: `ok`, `missing` (the path doesn't exist), or `not a factory project` (it
   exists but has no `factory/` directory). `factory projects prune` removes the `missing` and
   `not a factory project` entries, printing each one; `--dry-run` prints them and changes
   nothing. A root on a removable volume (under `/Volumes/<name>` on macOS, or `/media/…`,
   `/run/media/…`, `/mnt/<name>` on Linux) whose volume isn't mounted is skipped with a note, so
   an unplugged drive keeps its projects. `factory projects remove <path>` unregisters one root
   whatever its state (a path not listed changes nothing and says so).** Why: Matt's set; the
   CLI owns the registry's writes as `init` does, while Andon stays read-only (decision 10's
   deferred "adding or removing projects from Andon" is untouched).

## Facts (2026-10-30)
- `removeRoot` already exists in `packages/contract/src/registry.ts` (atomic write; a root not
  listed writes nothing) and has no caller.
- The Andon service watches the registry's directory, so a prune shows on the board without a
  restart.

## Scope
- In: `factory projects`, `projects prune [--dry-run]`, and `projects remove <path>` in the CLI
  (`packages/cli`), the state check in a pure, `bun:test`-covered module (the filesystem and
  mount checks injected or run against temp dirs); `docs/contract/v1.md` "CLI" (and "Andon
  registry" if it names its writers) updated, additively; the README's Andon section naming the
  commands.
- Out: adding or removing projects from Andon itself (deferred, decision 10); the service
  commands (brief `andon-service-install`); any change to the registry's format.

## Acceptance sketch
- With a registry holding an existing factory project, a deleted path, and an existing folder
  without `factory/`, `factory projects` shows `ok`, `missing`, and `not a factory project`.
- `factory projects prune --dry-run` prints the two dead roots and leaves the file unchanged;
  `factory projects prune` removes exactly them and prints each.
- A root under an unmounted removable volume is skipped by `prune`, with a note.
- `factory projects remove <path>` removes a listed root whatever its state; an unlisted path
  writes nothing and says so.
- An empty or missing registry prints that nothing is registered; nothing is written.

## Contract calls
"`docs/contract/v1.md` "CLI" gains `factory projects`, `factory projects prune [--dry-run]`, and
`factory projects remove <path>`, an additive change within v1", approved by Matt on 2026-10-30.
The job updates the contract doc and its dated changes list to match.

## Open
None.
