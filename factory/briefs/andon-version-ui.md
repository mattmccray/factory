# Andon shows stale installs and what's new

- Status: ready
- Sources: the explore request of 2026-10-29; epic plan `factory/epics/factory-versioning.md`; briefs `factory-release`, `andon-version-service`
- Date: 2026-10-29

## Intent
In Andon, Matt can see at a glance, without alarm, that a project runs an older factory than
the machine has, read what changed in the releases it's missing ("What's New"), and notice when
the Andon service itself needs a restart to pick up a pulled release.

## Decisions
1. How does Andon show it? → **Quietly.** A behind project's sidebar row gets a small muted
   "update available" glyph after its name (never like the red needs-human badge), with hover
   text `factory <installed> installed · <release> available`; ahead and unknown get hover text
   only. The sidebar footer's service line adds the machine's release, and becomes a "restart
   the Andon service" note when running and on-disk releases differ. A "What's New" sheet (like
   the Settled and Shortcut sheets) shows the changelog: the footer's version opens it whole; a
   behind project's glyph opens it scoped to the releases that project is missing. The tray
   badge stays the needs-human count, All Projects gets no aggregate, and there are no
   notifications for releases. Why: an outdated install is something to notice, not an alarm;
   decision 10 keeps the Mac app thin.
2. How is it reached, and what does it copy? → **The scoped sheet copies
   `cd '<project root>' && factory upgrade && bun factory/cli.ts doctor`, copy-first like the
   Rework and Approve command sheets; the restart note copies `bun run andon:service` the same
   way. Andon never runs either. The sheet is routable like the other sheets (the URL holds it
   and its project scope; back, forward, and reload work; Escape closes it), with no new
   keyboard shortcut. A behind project's scope is the releases after its installed version up to
   and including the service's running release, newest first, with a "Show all releases" link
   to the whole changelog. A missing `release` field or `/release` endpoint (an older service)
   is unknown and shows nothing.** Why: every piece reuses a pattern the board already has, so
   the surface is a sibling of the others; Andon stays a reader (decision 10).
3. A Mac app menu item? → **Yes: Help → What's New, above "Factory on GitHub". The Mac app only
   shows the main window and routes the board to the whole-changelog sheet; nothing else in the
   Mac app changes.** Why: Help is where macOS apps put release notes; routing keeps the Mac app
   thin.
4. What's it called? → **"What's New" everywhere: the sheet's title, the Help menu item, and the
   footer version's hover text ("What's new in v<release>"). The file stays `CHANGELOG.md`.**
   Why: the changelog is meant to be user-facing, and the scoped view is literally what's new
   since a project's version; "Changelog" reads as a developer artifact.

## Scope
- In: the sidebar's behind glyph and hover text for every state; the footer's release and
  restart note; the "What's New" sheet (whole and project-scoped, "Show all releases", the copy
  of the upgrade and restart commands), routed; reading `release` from the `projects` event and
  `/release` plus the `release` SSE event from member `andon-version-service`; tolerance of an
  older service; the Help → What's New menu item in the Mac app (`appmenu.ts` and its action,
  routing the main window); light and dark; keyboard and screen-reader labels; tests
  (`bun:test`).
- Out: any service or contract change (member `andon-version-service`); the release script and
  changelog (member `factory-release`); running `factory upgrade` or restarting the service from
  Andon; a keyboard shortcut; the tray badge, All Projects, or notifications; cross-machine
  views (deferred); linking changelog entries to jobs (later).

## Acceptance sketch
- A behind project shows the muted glyph after its name, with hover text
  `factory 0.1.0 installed · 0.2.0 available`; current, ahead, and unknown projects show no
  glyph, each with its own hover text; the red needs-human badge is unchanged and never
  confused with it.
- The sidebar footer shows the machine's release (e.g. `v0.2.0`) next to the connection; when
  the service's on-disk release differs from the running one, it shows a "restart the Andon
  service" note that copies `bun run andon:service`.
- Clicking the footer's release, or Help → What's New in the Mac app, opens "What's New" with
  every release, newest first, grouped Breaking / Added / Fixed with each entry's area and job
  id.
- Clicking a behind project's glyph opens it scoped to the releases after the installed version
  up to the running one, with a "Show all releases" link and a copy button for
  `cd '<root>' && factory upgrade && bun factory/cli.ts doctor`.
- The sheet is in the URL (reload and back/forward restore it and its scope) and Escape closes
  it.
- A `projects` or `release` event updates the glyph, footer, and open sheet live (after a
  `factory upgrade` or a `git pull`).
- Against a service with no `release` data, nothing new shows and nothing breaks.
- Works in light and dark, with screen-reader labels; the gate passes.

## Contract calls
None.

## Open
None.
