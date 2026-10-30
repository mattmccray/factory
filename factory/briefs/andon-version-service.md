# Andon service reports versions and the changelog

- Status: ready
- Sources: the explore request of 2026-10-29; epic plan `factory/epics/factory-versioning.md`; brief `factory-release` (decisions 1, 4)
- Date: 2026-10-29

## Intent
Each machine's Andon service says which factory release it runs, which release each registered
project has installed and whether that is behind, and serves the changelog, so the Andon UI can
show stale installs and what they're missing.

## Decisions
1. What counts as "older"? → **A project is compared with the release its machine's service
   runs: `current` (equal), `behind` (lower; the only state the UI marks visibly), `ahead`
   (higher, e.g. the service's clone isn't pulled; informational only), `unknown` (no
   `managed.json`, or no valid semver in it; neutral). The service reads each project's
   `managed.json` per request, as it resolves `name`, so an upgrade shows without a restart. The
   service reads its own release once at startup and also reports the release on disk in its
   clone; when they differ, the UI notes that the Andon service needs a restart.** Why: the
   restart case is the single-machine form of "this machine runs an older factory" and falls out
   of the same data. Cross-machine comparison waits for multi-machine Andon (still deferred); the
   API already has each service report its own release.
2. Where does the changelog come from? → **The service parses its own clone's `CHANGELOG.md`
   (the strict format of brief `factory-release`, decision 4) into releases (version, date,
   entries per section) and serves it read-only.** Why: one source, no JSON twin; the changelog
   is not installed into consumer projects.
3. What does an entry line look like? → **`- <Area>: <text> (<job id>)`, as fixed in brief
   `factory-release` decision 4 (no job id for a direct commit, no area without a scope),
   parsed into `{ area, text, job }` with `null` for a missing part. A line that doesn't match
   is `{ area: null, text: <the line>, job: null }`, never an error.** Why: plain Markdown that
   reads well; the job id lets the UI link entries later; a tolerant reader degrades a
   hand-edited line instead of breaking the sheet. The two members run in parallel, so the
   format is fixed in both briefs.
4. What's the API's shape? → **Additive within v1. `GET /projects` entries and the `projects`
   SSE event gain `release: { installed, state }` (`installed` the project's `managed.json`
   `version` or `null`; `state` one of `current` | `behind` | `ahead` | `unknown`). The service
   also watches each project's `factory/managed.json` and re-sends `projects` when an installed
   version or state changes, as it does for a name change. A new `GET /release` returns
   `{ running, onDisk, changelog }`: `running` the release read at startup, `onDisk` the clone's
   templates `package.json` version now (or `null` when unreadable), `changelog`
   `[{ version, date, sections: { breaking, added, fixed } }]` newest first, each section a list
   of `{ area, text, job }` (`[]` when `CHANGELOG.md` is missing). A new `release` SSE event has
   the same body, sent on connect and again when the clone's `CHANGELOG.md` or templates
   `package.json` changes (a `git pull`). States come from a small semver comparison against
   `running`. `main.ts` passes the clone's root in (as it does `uiDir`), so tests use fixtures.**
   Why: `release` on the project entry keeps the sidebar's data in the event it already hears; a
   machine-level `/release` keeps the changelog out of every board payload; each service
   reporting `running` is what multi-machine Andon needs per machine later.

## Scope
- In: reading each project's `managed.json` version per request and computing its state; the
  `managed.json` watch and the `projects` re-send; the service's running and on-disk releases;
  parsing the clone's `CHANGELOG.md` (format of decision 3); `GET /release` and the `release`
  SSE event, behind the existing guards (`Host`/`Origin` 403, `GET` only, `cache-control:
  no-store`); the clone root passed from `main.ts`; tests (`bun:test`) with fixtures;
  `docs/contract/v1.md` ("Andon service", plus a dated entry under "Versioning") in the same
  diff.
- Out: the release script and `CHANGELOG.md` itself (member `factory-release`); any UI or Mac
  app change (member `andon-version-ui`); cross-machine comparison (deferred); writing
  anything (the service stays read-only); restarting itself; telling a project to upgrade.

## Acceptance sketch
- A project whose `managed.json` says `0.1.0` under a service running `0.2.0` is listed with
  `release: { installed: "0.1.0", state: "behind" }`; equal is `current`, higher is `ahead`;
  no `managed.json`, an unreadable or invalid one, or a non-semver `version` is
  `{ installed: <the string or null>, state: "unknown" }`, and the project is still listed.
- Running `factory upgrade` in a project (its `managed.json` changes) re-sends `projects` with
  the new `release`, with no restart; a `managed.json` write that changes neither `installed`
  nor `state` sends no `projects` event.
- `GET /release` returns `running`, `onDisk`, and the parsed changelog, newest first; changing
  the clone's templates `package.json` version makes `onDisk` differ from `running` and sends a
  `release` event; editing `CHANGELOG.md` sends one too.
- A missing `CHANGELOG.md` is `changelog: []`; a line that doesn't match the entry format is
  `{ area: null, text: <line>, job: null }`; lines missing the job id or area parse with `null`
  there.
- `/release` sits behind the same guards as every endpoint; the service writes nothing.
- The contract doc describes `release` on project entries, `GET /release`, and the `release`
  event, and records the addition under "Versioning".
- The gate passes.

## Contract calls
- "Additive within v1: `release: { installed, state }` on `GET /projects` entries and the
  `projects` SSE event (re-sent when it changes), the new `GET /release` endpoint, and the new
  `release` SSE event, as in decision 4", approved by Matt on 2026-10-29. The job must update
  `docs/contract/v1.md` ("Andon service" and "Versioning") to match.

## Open
None.
