# The Settings window shows only a close button

- Status: done
- Job: 037-settings-window-chrome (merged ee5509c, 2026-10-28)
- Sources: Matt's request (2026-10-28); brief `factory/briefs/andon-settings.md` (decision 2: a separate, fixed-size, modeless Settings window); `apps/andon/src/appmenu.ts` (`settingsWindow`), `apps/andon/src/backend.ts` (`openSettings`); `apps/andon/types/tiny.d.ts` (`TinyChromeOptions.windowControls`, `TinyOpenWindowOptions.parent`, `dialog`)
- Date: 2026-10-28

## Intent
The Settings window today shows all three traffic lights, but minimizing or zooming a small,
fixed-size settings window makes no sense. Showing only the close button makes it feel like a
normal Mac settings window.

## Decisions
1. Which window controls does Settings show? → **Close only.** Why: minimize and zoom have no
   use on a small fixed-size settings window; Tiny supports it directly
   (`chrome.windowControls: ['close']`).
2. Modal, child, or separate? → **A child of the main window (`parent: 'main'` at open), not
   modal.** Why: Tiny has no window-modal sheet (its dialogs are app-modal alerts only); a child
   stays above the board without floating over other apps, moves with it, and hides, minimizes,
   and closes with it, which is the polish Matt wants. Accepted: since closing the main window
   only hides it, Settings goes away with it.
3. Settings… while the main window is hidden or minimized? → **Bring the main window back first
   (restore it if minimized, show it if hidden), then open Settings, or show and focus it if
   it's already open, above it.** Why: a child of a hidden window stays hidden, so ⌘, would
   otherwise seem to do nothing; this way ⌘, always visibly works.

## Scope
- In: `apps/andon`: the Settings window opens with only the close button, as a child of the
  main window; Settings… brings the main window back first when it is hidden or minimized; the
  existing tests for the Settings window's options updated, with new ones for the
  bring-back step.
- Out: a modal or sheet; any change to the Settings page, its two methods, the API gate, the
  window's size, or Window → Minimize/Zoom (they still act on the main window); any
  `apps/andon-ui`, service, or contract change.

## Acceptance sketch
- The Settings window shows a close button and no minimize or zoom button (`manual`); the
  window options are pinned by a test.
- Settings stays above the main window, moves with it, and hides or minimizes with it; the
  board stays usable while it's open (`manual`).
- With the main window hidden (closed) or minimized, App → Settings… (⌘,) brings it back and
  shows Settings above it; a second ⌘, still focuses the one open window (tests pin both).
- The gate passes.

## Contract calls
None.

## Open
None.
