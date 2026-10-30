# An About window for Andon

- Status: done
- Job: 065-andon-about-window (merged 793092e, 2026-10-30)
- Sources: the explore request of 2026-10-29 (pre-1.0 notes: "Add custom About dialog … paper lanterns drifting upwards over a river at dusk … Show the version number and whether there's an update available (eventually)"); briefs `andon-settings`, `andon-version-ui`; `apps/andon/src/appmenu.ts`
- Date: 2026-10-30

## Intent
Andon gets its own About window: a quiet illustration of paper lanterns rising over a river at
dusk, the app's name and version, and, when they differ, the service's. It replaces the stock
About and gives the app a face.

## Decisions
1. Where does the art come from? → **Generated with Codex's image tool from three candidates;
   Matt chose the illustrated one. It is committed on `main` before the job runs, as
   `apps/andon/assets/about.png` (1774 × 887, 2:1), with its prompt in
   `apps/andon/assets/source/about-prompt.md` (commit 5ec8c3b).** Why: the factory's agents can't
   make images; the lantern icons set the precedent of art supplied before the job. The job may
   copy or move it to wherever the Andon UI serves static files from, but never edits the image.
2. What does the window show, and how does it open? → **The art across the top; "Andon"; "Version
   X.Y.Z", the Mac app's own release (its `package.json`, which the release script stamps); the
   service's release only when it differs, as "Service X.Y.Z · restart needed" when the service's
   `/release` says so (the data the footer already uses); a "Factory on GitHub" link (the same
   constant as Help's); and "© 2026 Matt McCray". No update check yet. App → "About Andon"
   replaces Tiny's stock About item and opens a separate fixed-size window like Settings,
   rendered by the Andon UI as an about view; closed by ⌘W or its close button; opening it again
   brings it forward.** Why: Matt's outline; "update available" has nothing to compare against
   until the repo is public and has a `release` branch (epic `factory-distribution`), so it is a
   later brief.

## Facts (2026-10-30)
- The app menu holds only Settings… (⌘,) besides Tiny's stock items (`appmenu.ts`).
- The Settings window is a second Tiny window showing an Andon UI view served by the service
  (`/?shell=mac&view=settings`); it set the pattern this window follows.
- `apps/andon/package.json` carries the release version (0.1.0); the release script writes every
  `apps/*` version.

## Scope
- In: `apps/andon`: the "About Andon" item in the app menu replacing the stock one, the About
  window (fixed size, opened or brought forward), and anything the page needs from the backend to
  show the app's version (if it needs a backend method, exactly one, answered only for the About
  window, pinned by the boundary test); `apps/andon-ui`: the about view (art, name, versions,
  link, copyright, light and dark), served with the image; tests for both.
- Out: an update check or "update available" (later, after the distribution epic); editing or
  regenerating the art; the View menu (brief `andon-view-menu`); the service and the contract.

## Acceptance sketch
- App → About Andon opens the About window (again: brings it forward); the stock About is gone.
- It shows the art across the top, "Andon", "Version <the app's version>", the GitHub link
  (opening in the browser), and the copyright, in light and dark.
- With the service on a different release, it adds "Service <version>", and "restart needed"
  when the service's `/release` says the on-disk release moved.
- ⌘W or the close button closes it; the main window is unaffected.
- A plain browser gets no About window (the view needs the Mac app); nothing else changes there.

## Contract calls
None.

## Open
None.
