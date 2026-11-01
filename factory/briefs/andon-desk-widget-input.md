# Andon desk widget: mouse input

- Status: draft
- Sources: `factory/briefs/andon-desk-widget.md` (job 092-andon-desk-widget, merged 27d134a);
  window layers as listed on Matt's Mac with `CGWindowListCopyWindowInfo`, 2026-11-01
- Date: 2026-11-01

## Intent
The desk widget shipped and looks right: it sits on the desktop, stays put on every Space, and
never shows over a fullscreen app. But it gets no mouse input, so you can't drag it, hover a pill
for its tooltip, or click a pill to open its job (brief decision 5). This happens whether or not
jobs are running. This follow-up makes the widget take input again without lifting it above
normal windows.

## Findings
- **Cause: the window level.** The widget opens at Tiny JS's `setLevel('desktop')`, which is
  macOS's desktop window level, `-2147483623` (`kCGDesktopWindowLevel`). Two transparent,
  screen-sized windows sit above it at `-2147483603` (`kCGDesktopIconWindowLevel`): Finder's
  desktop-icon window and WindowManager's "Event Shield Window". They take every click and hover
  before it reaches the widget.
- **Where it should sit.** Apple's own desktop widgets (the Notification Center's) sit at
  `-2147483601`. That's just above the desktop-icon layer and still below normal windows, so they
  take input and stay behind apps. The desk widget needs a level in that band.
- **What Tiny JS offers (v0.68.0).** `setLevel` accepts only `'normal'`, `'floating'`,
  `'overlay'`, and `'desktop'` (`apps/andon/types/tiny.d.ts:130`). None of them is in that band.
- **What isn't the cause.** The empty state isn't to blame: its glass keeps
  `pointer-events` on, and only its rows and footer turn them off (`apps/andon-ui/src/app.css:707`).
  The page's drag code (`DeskWidget.svelte`, `widget.ts` `pressMove`/`startDrag`) never receives a
  `mousedown`.
- **Resizing is by design.** Brief 092 left it out of scope. The width is fixed at 332, and the
  height fits the content (`fitWidget`).
- **What already works (checked by Matt on 2026-11-01).** The widget is pinned to the desktop, on
  every Space, and never over a fullscreen app (AC3 of job 092, which was unverified at the time).

## Options
1. **Preferred: a widget level in Tiny JS.** Tiny JS gains a level at the desktop-icon level + 1,
   where Apple's widgets sit (for example, `setLevel('widget')`). Andon then changes one line,
   `WIDGET_BEHAVIOR.level` in `apps/andon/src/appmenu.ts:512` (and its test), bumps the Tiny
   version it needs, and drag, tooltips, and clicks all work as designed. It needs a check that the
   new level still stays off fullscreen Spaces with `setAllSpaces(true)` and `chrome.panel`.
2. **Fallback: an "Arrange Desk Widget" mode in Andon.** A toggle in the tray and Window menus
   raises the widget to `'normal'` so it can be dragged and its place remembered, then sends it back
   to `'desktop'`. Placement works, but tooltips and pill clicks still don't on the desktop, so it
   would amend brief decision 5.

## Open
- Can Tiny JS add the level? Matt is looking into it. If it can, take option 1. If not, take
  option 2 and settle its details (how arrange mode starts and ends, what it looks like while on).
