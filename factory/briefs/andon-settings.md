# A Settings window for Andon

- Status: ready
- Sources: Matt's nitpicks (2026-10-28), item 4 and the follow-up asking for settings; brief `factory/briefs/andon-app-menu.md` (the disabled Settings… placeholder, the stored status bar choice); `apps/andon/src/appmenu.ts`, `apps/andon/src/backend.ts`; `apps/andon/types/tiny.d.ts` (`app.win.open`, `TinyOpenWindowOptions`, `TinyApiMeta.window`)
- Date: 2026-10-28

## Intent
Andon's app menu has had a grayed-out Settings… since job 032. This makes it real: a Settings
window with a first setting, whether the status bar shows, kept in step with View → Hide/Show
Status Bar. It's the home for the T3 Code hand-off's options next (brief C2), and for later
settings such as a configurable "Open in" list.

## Decisions
1. How does this fit with the rest of Matt's list? → **Brief C1 of four, run in order: A
   `andon-polish`, C1 (this one), C2 a T3 Code hand-off that adds its own section here, B the
   minimized-window icon.** Why: C1 is mostly Tiny window plumbing and C2 is the part that runs
   a program, so each gets its own focused review.
2. A separate window or a sheet? → **A separate native Settings window, as Mac apps have:
   titled "Settings", fixed size (not resizable), opened (or brought forward if open) by
   App → Settings… (⌘,), closed by ⌘W or its close button; changes apply at once, with no Save
   button. Mac app only: a plain browser has no Settings, and its status bar always shows.**
   Why: it's what ⌘, means on a Mac, and it doesn't block the board the way a sheet would. The
   cost, accepted: a second page and a way for it to reach the backend, which widens the Tiny
   API gate.
3. Where does its page live, and how does it read and write settings? → **The page is a
   settings view of the Andon UI (`apps/andon-ui`) at a URL the service already serves (e.g.
   `/?shell=mac&view=settings`, or a second built HTML entry; the service serves only the UI's
   built files, with no fallback route, and doesn't change), which the Mac app opens in the
   Settings window. The Mac app's backend
   owns the stored settings (as it already owns the status bar choice, same store key) and
   exposes exactly two named methods, "get settings" and "set one setting". It answers them
   only when Tiny's call metadata says the call came from the Settings window (`meta.window`);
   from any other window they do nothing. "Set" accepts only known keys with a value of the
   right type and ignores anything else; that check lives in a pure, `bun:test`-covered module.
   The API gate grows by exactly those two methods, pinned by the boundary test. A change from
   either side shows everywhere at once: toggling the status bar in Settings shows or hides it in
   the main window and flips the View menu label; ⌘/ or the menu updates the Settings checkbox
   if it's open.** Why: the Andon UI owns all UI and shares its tokens, light and dark, and
   build, so the Mac app stays thin (decision 10) with no UI files of its own; one owner for
   stored settings; the main page can't change settings, and the security reviewer judges two
   named methods.

## Scope
- In: `apps/andon`: App → Settings… enabled (⌘,), opening or focusing the Settings window;
  the two settings methods, restricted to the Settings window; a backend → Settings page push so
  an open window stays current; the API gate widened by exactly the two methods.
- In: `apps/andon-ui`: the settings view (one General section with a "Show status bar"
  checkbox), styled with Andon's tokens in light and dark, reachable only in the Mac app.
- In: the settings keys, their types, and the "set" validation in a pure module with
  `bun:test` coverage; `backend.ts` stays the only file touching Tiny or txiki.
- Out: the T3 Code settings (C2); starting jobs from Andon (a later exploration); a
  configurable "Open in" list; Settings in a plain browser; any service or contract change.

## Acceptance sketch
- In the Mac app, App → Settings… (⌘,) is enabled and opens a "Settings" window; pressing ⌘,
  again brings the open window forward rather than opening a second one; ⌘W closes it
  (`manual`).
- The window shows a "Show status bar" checkbox matching the current state; unchecking it hides
  the main window's status bar at once and the View menu then reads "Show Status Bar"; ⌘/ while
  Settings is open flips the checkbox (`manual`).
- The choice survives quitting and relaunching, as today.
- Calls to the settings methods from the main window do nothing; "set" with an unknown key or a
  wrongly typed value changes nothing (tests pin both).
- The API gate allows exactly two more methods than after `project-context-menu` (pinned).
- Light and dark appearances meet WCAG AA; a plain browser shows no Settings and an always-shown
  status bar.
- The gate passes.

## Contract calls
None.

## Open
None.
