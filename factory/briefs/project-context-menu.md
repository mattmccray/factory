# A context menu on the sidebar's projects

- Status: done
- Job: 033-project-context-menu (merged 8d21dcf, 2026-10-28)
- Sources: Matt's notes on context and application menu additions (2026-10-28); brief `factory/briefs/andon-app-menu.md` (runs first); `apps/andon/types/tiny.d.ts` (`app.menu.setContext`, `TinyShell`, `clipboard`)
- Date: 2026-10-28

## Intent
In Andon, the Mac app, right-clicking a project in the sidebar gives quick ways to get at that
project on disk: copy its path, reveal it in Finder, or open it in an editor or terminal. It saves
hunting for the folder while watching its jobs.

## Decisions
1. Who runs the actions, and what may the page ask for? → **The Mac app's backend. The page sends
   only a project id, through one custom backend method named in the API gate; the backend looks
   the project's root up in its own `/projects` feed (keeping `root` beside `id` and `name`),
   builds the native right-click menu, and runs a fixed action itself. An unknown id does
   nothing. The page never sends a path, an app name, or a command. The menu exists only in the
   Mac app; in a plain browser a right-click shows the browser's own menu.** Why: one named gate
   entry for the security reviewer to judge, no arbitrary path or app reachable from the page,
   and Andon stays thin (decision 10: a lookup in a list it already follows, no contract code).
   A browser can't launch anything anyway.
2. Which items, in what order? → **A fixed list in code: Copy Project Path, Reveal in Finder, a
   separator, then Open in ▸ VS Code, T3 Code, Terminal. No user-configurable app list.** Why:
   Andon has no settings yet (Settings… is a disabled placeholder, brief `andon-app-menu`); a
   configurable list is a natural first thing to hook up there later.
3. Which terminal? → **Ghostty, and only Ghostty, under Open in…: so the list is VS Code, T3 Code,
   Ghostty.** Why: it's Matt's daily driver, and Ghostty 1.3.1 declares folders
   (`public.directory`) as a document type it opens, so `open -a Ghostty <root>` opens a window
   there, as Terminal.app would.
4. How is T3 Code opened, and what about missing apps and failures? → **T3 Code opens with
   `t3 app <root>`, which opens the project in the running desktop app. The backend looks for
   `t3` when the menu is built, at `~/.t3/bin/t3` and then `/opt/homebrew/bin/t3` (never fixed at
   build time). When the menu is built, an item whose app (VS Code, Ghostty) or `t3` isn't
   installed is grayed out. An action that fails anyway (a non-zero exit, `t3 app` with T3 Code
   not running, a rejected reveal or clipboard write) shows a native notification, e.g.
   "Couldn't open factory in T3 Code: …", and is logged.** Why: `open -a` won't turn a folder
   into a T3 project (T3 Code only takes HTML documents), a Dock-launched app's PATH lacks
   `/opt/homebrew/bin`, and `t3` updates itself behind the stable `~/.t3/bin/t3` launcher.
   Graying out shows what's unavailable before trying; notifications are already how Andon
   speaks up, so there's no new UI.
5. Where does the menu appear, and does a right-click select? → **On the sidebar's project rows
   and on each board lane's project gutter (the 148px left column: name, meta line, settled
   link; collapsed idle lanes too, and in a focused project's view). Not on All Projects and not
   on the lane's job cells. A right-click or control-click doesn't change the selection or focus;
   the row or gutter the menu is for shows a highlight ring while the menu is open, if Tiny tells
   the page when the menu closes (otherwise no ring).** Why: with the sidebar hidden (it
   auto-hides below 1640px with the inspector open) the gutter is the only place to reach a
   project; All Projects has no single folder; leaving the selection alone matches Finder's
   sidebar. Revised by Matt mid-interview from sidebar-only.

## Scope
- In: `apps/andon`: the backend keeps each project's `root` from `/projects`; one custom backend
  api method takes a project id and shows that project's native context menu; the backend runs
  the chosen action (clipboard write, `shell.reveal`, `open -a "Visual Studio Code" <root>`,
  `t3 app <root>`, `open -a Ghostty <root>`), grays out missing apps, and notifies on failure.
- In: `apps/andon-ui`: in the Mac app (`?shell=mac`), a right-click or control-click on a
  sidebar project row or a lane's project gutter asks the backend for that project's menu; in a
  plain browser, nothing changes.
- In: `tinyjs.json`'s `api` gate widened by that one named method (on top of what
  `andon-app-menu` allowed), its boundary test pinning the gate exactly.
- In: the menu's items, ids, app lookup, and command building in a pure module with `bun:test`
  coverage (unknown id → nothing; argv built from a looked-up root only, never a string the page
  sent); `backend.ts` stays the only file touching Tiny or txiki.
- If Tiny can't show a native menu for the row that was right-clicked reliably, the job
  escalates; it never draws a fake HTML menu instead (the design: "never fake chrome").
- Out: All Projects and a lane's job cells getting a menu; Terminal.app, iTerm, or Warp; a
  user-configurable app list; a menu in a plain browser.
- Out: linking a job to its T3 Code thread (`t3code://threads/<environmentId>/<threadId>`
  opens one; recording the ids would be a contract change). A separate exploration.
- Out: any app menu work (brief `andon-app-menu`); any change to the service or the contract.

## Acceptance sketch
- In the Mac app, right-clicking (or control-clicking) a project in the sidebar, or a lane's
  project gutter on the board (with the sidebar shown or hidden), opens a native menu: Copy Project Path, Reveal in Finder, a separator, Open in ▸ VS Code, T3 Code, Ghostty.
- The selection and focus don't change; the board keeps showing what it showed.
- Copy Project Path puts the project's absolute root on the clipboard.
- Reveal in Finder opens Finder with that folder selected.
- Open in ▸ VS Code / Ghostty opens the folder in that app; T3 Code opens it as a project in the
  running T3 Code app (`manual`).
- With an app not installed (or no `t3` at either path), its item is grayed out.
- A failing action (e.g. T3 Code not running) shows a "Couldn't open <project> in <app>: …"
  notification.
- All Projects and the job cells show no project menu. In a plain browser, a right-click shows the browser's menu.
- The page can't name a path, app, or command: an unknown id does nothing; tests pin it, and the
  API gate allows exactly one more method than after `andon-app-menu`.
- The gate passes.

## Contract calls
None.

## Open
None.
