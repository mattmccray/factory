# Andon's app menu

- Status: done
- Job: 032-andon-app-menu (merged c2571a5, 2026-10-28)
- Sources: Matt's notes on context and application menu additions (2026-10-28); `apps/andon/types/tiny.d.ts` (`TinyMenu`, `app.menu`, `app.push`)
- Date: 2026-10-28

## Intent
Andon, the Mac app, gets a proper menu bar: the app menu, View, Window, and Help menus a Mac user
expects, so common actions (showing or hiding the status bar, window handling, reaching the
project on GitHub) live where they look for them.

## Decisions
1. One job or two? → **Two briefs: this one (the app menu) first, then `project-context-menu`.**
   Why: the context menu opens the page's Tiny API gate and deserves its own focused security
   review; the menu bar is mostly backend wiring, and its backend → page channel (for the status
   bar toggle) can be reused by the second job.
2. What does App → Settings… do? → **It's present but disabled (grayed out), in the app menu's
   Settings slot with ⌘,; clicking it does nothing.** Why: Andon has no settings yet; the
   disabled item is a deliberate placeholder to hook up later, and a rough edge is fine at this
   late-alpha stage.
3. How does View → Show/Hide Status Bar work? → **Like Finder's: one item whose label flips
   ("Hide Status Bar" / "Show Status Bar"), shortcut ⌘/, the choice remembered across launches
   by the Mac app and applied by the page when it loads; when hidden, the board takes the freed
   28px with no gap. In a plain browser there's no menu and the status bar always shows (no
   page-only shortcut).** Why: it's the Mac convention Matt expects, and keeping the toggle in
   the Mac app avoids a key that sits next to `?`. The cost, accepted: the page's Tiny API gate
   opens just enough for the page to receive the backend's pushed event.
4. What's in the Window menu? → **Minimize (⌘M), Zoom, a separator, then "Andon" (⌘0), which
   shows the main window and brings it forward. No Close Window item, no tiling items, no window
   list.** Why: Tiny has no stock Window menu, so these are the Mac standard items built by hand;
   closing only hides the window, so a menu way back matters; Andon has a single window.
5. What does Help → GitHub open? → **A Help menu (Tiny's `help` role, so it sits last with
   macOS's search field) holding one item, "Factory on GitHub", which opens
   `https://github.com/mattmccray/factory` in the default browser. The URL is a constant in the
   Mac app.** Why: personal now, publishable later (decision 6): one constant is easy to change
   when it's published, and reading the remote at build time buys nothing.

## Scope
- In: `apps/andon` sets the app menu at startup: the app menu's disabled Settings… (⌘,); View with
  the Show/Hide Status Bar toggle (⌘/); Window (Minimize ⌘M, Zoom, separator, Andon ⌘0); Help
  with "Factory on GitHub". Tiny's stock Edit menu stays as it is.
- In: the status bar choice persisted by the Mac app and pushed to the page; `apps/andon-ui`
  hides or shows its status bar on that event and on load, and the board fills the freed space.
- In: the narrowest widening of `tinyjs.json`'s `api` gate that lets the page receive the pushed
  event (and nothing more), with its boundary test updated to pin the new gate exactly.
- In: the menu's ids and click handling kept runtime-neutral where possible (a pure module, like
  `trayclick.ts`), with `bun:test` coverage; `backend.ts` stays the only file touching Tiny.
- Out: the sidebar's project context menu (brief `project-context-menu`); a settings window or
  any working Settings…; a Close Window item, tiling items, or a window list; a page-only status
  bar shortcut or toggle in a plain browser; any change to the service or the contract.

## Acceptance sketch
- In the Mac app the menu bar reads Andon, Edit, View, Window, Help.
- The Andon menu has Settings… (⌘,), grayed out; choosing or pressing it does nothing.
- View → Hide Status Bar (⌘/) hides the status bar and the board grows into the space; the item
  then reads Show Status Bar, and choosing it brings the bar back.
- Quit and relaunch: the status bar is still hidden (or shown), and the menu label agrees.
- Window → Minimize (⌘M) minimizes; Zoom zooms; after closing the window, Window → Andon (⌘0)
  brings it back to the front.
- Help → Factory on GitHub opens https://github.com/mattmccray/factory in the default browser.
- In a plain browser the UI looks and behaves as before: the status bar always shows.
- The page's API gate allows only what it did before plus the event subscription; a test pins it.
- Menu wiring has `bun:test` coverage; the gate passes.

## Contract calls
None.

## Open
None.
