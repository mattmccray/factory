# Settings and About open centered on the main window

- Status: ready
- Sources: the explore request of 2026-10-30 ("About window shouldn't remember its size or position: it should be a fixed size, centered on the parent window"); briefs `andon-about`, `andon-settings`; `apps/andon/tinyjs.json`, `apps/andon/src/appmenu.ts`, `apps/andon/src/backend.ts`
- Date: 2026-10-30

## Intent
The About and Settings windows always open at their fixed size, centered on the main window, never
where they were last left. The main window keeps remembering its own place.

## Facts (2026-10-30)
- `tinyjs.json` sets `"rememberWindows": true`. Tiny's docs: "A `win.open()` without
  `x`/`y`/`screen` reopens where that window id last was; an explicit position always wins." It
  applies to every window id, so `about` and `settings` come back where they were last left.
- Both windows are opened by `openAbout` / `openSettings` (`backend.ts`) with `win.open(id, …)`,
  options from `aboutWindow` / `settingsWindow` (`appmenu.ts`): a fixed `size` and `minSize`,
  `parent: 'main'`, and no `x`/`y`. Both are made non-resizable after opening.
- `bringBackMain` already shows and restores the main window before either opens, and the main
  window's `getState()` reports its frame.

## Decisions
1. Which windows? → **Both About and Settings; the main window keeps `rememberWindows`.** Why: the
   same cause and the same fix; one behavior for both fixed-size child windows.
2. Where and how big? → **Centered on the main window's frame, at the window's fixed size
   (About 440×400, Settings as today), on every open, whatever placement Tiny remembered.** Why:
   Matt's request.
3. Already open? → **Brought forward and focused where it is, not moved.** Why: the existing
   behavior; re-centering a window the user just moved would fight them.
4. Main window near a screen edge? → **The centered position is clamped so the child window stays
   fully on the main window's screen.** Why: a half-offscreen About or Settings is worse than an
   off-center one.

## Scope
- In: `apps/andon` (the open-time position, and the size if Tiny's remembered size could
  otherwise win, for About and Settings), with tests for the placement math (runtime-neutral, as
  `appmenu.ts`'s other logic is).
- Out: the main window's placement and `rememberWindows` for it; the windows' contents; the UI,
  the service, and the contract.

## Acceptance sketch
- Move or resize About or Settings (where possible), close it, move the main window, open it
  again: it opens at its fixed size, centered on the main window.
- Opening it while it's already open brings it forward without moving it.
- With the main window against a screen edge, the child window opens fully on that screen.
- The main window still comes back where it was left after a relaunch.

## Contract calls
None.

## Open
None.
