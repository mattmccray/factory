# App icons in the project menu's Open in submenu

- Status: done
- Job: 043-open-in-app-icons (merged 9e831f4, 2026-10-28)
- Sources: brief `factory/briefs/project-context-menu.md` (job 033, the menu this extends); `apps/andon/src/projectmenu.ts`; `apps/andon/types/tiny.d.ts` (`TinyMenuItem`, `thumbnail`); tinyjs.app/docs/menus and /changelog (checked through 0.68.0, 2026-10-28); Tiny 0.68.0's `apps/andon/types/tiny.d.ts` (`TinyMenuItem.icon`, `TinyApp.thumbnail`)
- Date: 2026-10-28

## Intent
In Andon, the Mac app, the project menu's **Open in ▸** submenu shows each app's own icon beside
VS Code, T3 Code, and Ghostty, the way Finder's "Open With" does. It makes the submenu quicker to
scan.

## Decisions
1. What happens while Tiny JS can't put an image on a menu item? → **Park this brief as a draft,
   waiting on Tiny JS.** Why: `TinyMenuItem` has no image field (through 0.67.1), its native
   protocol's `ITEM` line carries only id, label, and key, and a fake HTML menu is ruled out
   ("never fake chrome", brief `project-context-menu`). Matt asked Tiny's developer on 2026-10-28;
   they said they'd look into it, with no shape or release promised. **Unblocked 2026-10-28:**
   Tiny 0.68.0 ships `icon?: string` on `TinyMenuItem` (menu bar, right-click, tray): a png path
   (absolute or project-relative, scaled to menu size keeping aspect, own colors; ship 32px+ for
   high-DPI), `sf:<symbol>` (macOS), or `emoji:<glyph>`; an icon that can't be drawn leaves the
   label alone. No `file:`/`app:` form. The docs don't say how a disabled item's icon looks.
2. Where each icon comes from? → **The installed app's own icon: the backend finds each `.app` by
   bundle id (`com.microsoft.VSCode`, `com.t3tools.t3code`, `com.mitchellh.ghostty`) via Spotlight
   (`mdfind`), falling back to `/Applications` and `~/Applications`, calls
   `app.thumbnail(<.app>, 32)`, and hands the png path to the item's `icon`; looked up alongside the
   installed-app check and kept for the session.** Why: the real, current icon wherever the app
   lives (VS Code is in `~/Applications` here, T3 Code is `T3 Code (Beta).app`), and no other app's
   artwork committed to the repo; `sf:` symbols would be generic.
3. A grayed-out item's icon? → **An item carries its icon whenever the icon was found, enabled or
   not; dimming is left to Tiny and macOS (no hand-made dimmed png). An app with no `.app` found
   has no icon.** Why: a grayed T3 Code that keeps its icon shows the app is there and only `t3`
   is missing; Tiny's docs don't say how a disabled icon draws, so the human's smoke test checks
   it, and if it draws undimmed the follow-up is to drop icons on disabled items.
4. When are icons looked up? → **Once at launch, in the background; again for one app only when its
   found/missing state changes on an app check; the menu is set again when a lookup lands (as it
   is today when availability changes). The menu never waits on an icon. Each `thumbnail()` temp
   png is kept for the session and deleted when replaced.** Why: the menu is armed on hover and
   must open at once; `mdfind` + `thumbnail()` is slower than `open -Ra`, and a missing icon on a
   right-click in the first second after launch is harmless.
5. The Tiny pin? → **The job raises `minTinyjsVersion` in `apps/andon/tinyjs.json` to `0.68.0` and
   updates the pin test in `boundary.test.ts` to match (still "the version it was smoke-tested
   on"); nothing else in `tinyjs.json` moves.** Why: `icon` exists only from 0.68.0. Matt rebuilt
   and opened the current Andon on Tiny 0.68.0 before the job (2026-10-28) and it works; the
   `tinyjs update-project` output (`apps/andon/types/tiny.d.ts`, the bundled tinyjs skill docs) is
   committed by hand before the job, so the job starts from 0.68 types. The icons themselves are
   smoke-tested by the human after merge.

## Scope
- In: `apps/andon/src/projectmenu.ts` gives each Open in item an optional `icon` (a png path)
  from a pure, `bun:test`-covered shape: the bundle ids, the fallback `.app` locations, and which
  item gets which icon; `ContextItem` gains `icon`.
- In: `apps/andon/src/backend.ts` finds each `.app` (`mdfind` by bundle id, then `/Applications`,
  `~/Applications`), calls `app.thumbnail(<.app>, 32)`, keeps the png paths for the session
  (deleting a replaced one), looks up at launch and on a found/missing change, and re-sets the
  armed project menu when a lookup lands.
- In: `minTinyjsVersion` `0.68.0` in `apps/andon/tinyjs.json`, and its pin test.
- Out: icons on Copy Project Path or Reveal in Finder, or on the job menu; a hand-made dimmed png;
  committed copies of other apps' icons; `sf:`/`emoji:` stand-ins; a fake HTML menu; reaching
  around Tiny to AppKit; any change to the service, the API gate, `andon-ui`, or the `factory/v1`
  contract.

## Acceptance sketch
- In the Mac app, Open in ▸ shows VS Code's, T3 Code's, and Ghostty's own icons beside their names,
  wherever each app is installed.
- An app with no `.app` found keeps its grayed-out item with no icon; a grayed item whose `.app`
  was found (T3 Code without `t3`) keeps its icon. The menu still opens.
- An icon that can't be found or drawn leaves the item without one; the action still works.
- The menu opens at once even before the icons are ready; once they land, the next right-click
  shows them. Installing or removing an app changes its icon on a later app check.
- `minTinyjsVersion` is `0.68.0` and its test says so; nothing else in `tinyjs.json`, the API gate,
  the job menu, or a plain browser changes. The gate passes.

## Contract calls
None.

## Open
None.
