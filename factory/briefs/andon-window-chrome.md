# A full-bleed About window, and ⌘W for the front window

- Status: done
- Job: 073-andon-window-chrome (merged ad969aa via epic andon-window-polish, 2026-10-30)
- Sources: the explore request of 2026-10-30 (Matt's notes: "On the about dialog, I'd like that image to be full bleed to the top … Just the close button only … its parent window is … the main window … I like the way the settings window works"; "Cmd+W doesn't seem to close the settings window, nor does that shortcut close the about window"); briefs `andon-about` (job 065), `settings-window-chrome` (job 037); `apps/andon/src/appmenu.ts` (`aboutWindow`, `settingsWindow`, `appMenu`), `apps/andon/src/backend.ts` (`openAbout`, `openSettings`, `bringBackMain`), `apps/andon-ui/src/About.svelte`; epic `factory/epics/andon-window-polish.md`
- Date: 2026-10-30

## Intent
The About window's lantern art runs to the top edge, with only a close button over it, and the
window sticks to the main window the way Settings does. ⌘W closes whichever Andon window is in
front, and Escape closes the About window, so it is easy to dismiss even with a quiet close
button.

## Decisions
1. How does the frameless About window look and drag? → **`frame: false` with
   `windowControls: ['close']`; the close button stays at its default top-left spot over the art
   (not moved like the main window's); the art band is the drag area (`data-tiny-drag`), and the
   text below stays selectable and the GitHub link clickable. No gradient or other treatment
   behind the close button.** Why: the art reaches the top edge as Matt wants; the default spot
   reads as native in a small window; a close button that is a little hidden is fine because ⌘W
   and Escape close it too.
2. Does Escape close the About window? → **Yes, the About window only (not Settings or the main
   window).** Why: Matt's suggestion; About has nothing to type into, so Escape can't be taken
   from a field.
3. Is About a child of the main window? → **Yes, exactly as Settings: it opens with
   `parent: 'main'` (stays above the board, moves with it, hides and minimizes with it), and
   About Andon brings the main window back first when it is hidden or minimized (restore if
   minimized, show if hidden), then opens About above it, or shows and focuses it if it's already
   open.** Why: Matt likes how Settings behaves; a child of a hidden window would open hidden.
   Accepted: closing (hiding) the main window takes About with it, as it does Settings.
4. Where does ⌘W live, and what does it close? → **A new File menu, right after the app menu,
   holding Close Window (⌘W). It acts on the focused Andon window: Settings or About closes; the
   main window hides, exactly as its close button does (never quits); with no Andon window
   focused it does nothing.** Why: File → Close is where Mac users expect ⌘W, and the File menu
   is where member `andon-explore-menus` puts New Exploration…; hiding main matches its close
   button.
5. How does Escape reach the window? → **One new backend method, `closeAbout`, answered only for
   the About window (checked as `getAbout` is, by Tiny's api meta), which closes only that window.
   The About page calls it on Escape; in a plain browser Escape does nothing. The API gate grows
   by exactly that one method, pinned by the boundary test; `win.close` stays disabled.** Why:
   enabling `win.close` would let the main window's page quit the app; one narrow method is the
   pattern `getAbout` and `startWork` set.

## Facts (2026-10-30)
- The About window opens today with `frame: true`, `windowControls: ['close']`, and no `parent`
  (`appmenu.ts`, "Not a child of the main window"); Settings opens with `parent: 'main'`, and
  `openSettings` brings the main window back first (`bringBackMain`).
- Andon has one main window (`main`); `parent` is open-time only in Tiny.
- The menu bar binds no ⌘W: the Window menu has Minimize (⌘M), Zoom, and Andon (⌘0). The
  backend can read each window's `focused` through `getState()`.
- The main window's page drags by `data-tiny-drag` (toolbar, sidebar top); it needs no backend
  method.
- `tinyjs.json`'s `api` gate disables everything but named methods; `win.close` is not enabled
  (on `main` it quits the app).

## Scope
- In: `apps/andon`: the About window's options (frameless, close button only, `parent: 'main'`)
  and About Andon bringing the main window back first; the File menu with Close Window (⌘W) and
  its action on the focused window; `closeAbout` and its window check, `tinyjs.json`'s gate
  widened by that one method; tests for each (window options, the bring-back step, the File menu
  and ⌘W's target in each case, `closeAbout` answering only the About window, the boundary
  test). `apps/andon-ui`: the about view laid out frameless (the art to the top edge, the art
  band as the drag area, the text selectable, the link clickable, light and dark), and Escape
  calling `closeAbout` in the Mac app; tests for the pure parts.
- Out: New Exploration… in the File menu (member `andon-explore-menus`); any treatment behind
  the close button; Escape on Settings or the main window; changes to Settings' window, the About
  window's size, its text or art; the service and the `factory/v1` contract.

## Acceptance sketch
- The About window has no title bar: the art reaches the top edge, with only the close button
  over it (`manual`); dragging the art moves the window; the window options are pinned by a test.
- About stays above the main window, moves with it, and hides or minimizes with it (`manual`);
  with the main window hidden or minimized, About Andon brings it back and opens About above it;
  a second About Andon focuses the one open window (tests pin both).
- The menu bar has File → Close Window (⌘W) after the app menu: it closes Settings or About when
  focused, hides the main window when focused, and does nothing with no Andon window focused
  (tests pin each).
- Escape in the About window closes it; `closeAbout` from any other window, or with any field,
  is refused; the boundary test pins the gate with exactly one new method.
- In a plain browser, nothing changes.
- The gate passes.

## Contract calls
None.

## Open
None.
