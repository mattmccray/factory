# App icons in the project menu's Open in submenu

- Status: draft
- Sources: brief `factory/briefs/project-context-menu.md` (job 033, the menu this extends); `apps/andon/src/projectmenu.ts`; `apps/andon/types/tiny.d.ts` (`TinyMenuItem`, `thumbnail`); tinyjs.app/docs/menus and /changelog (checked through 0.67.1, 2026-10-28)
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
   they said they'd look into it, with no shape or release promised.

## Scope
- In (provisionally): `apps/andon/src/projectmenu.ts` gives each Open in item an icon in whatever
  form Tiny ships; `backend.ts` supplies anything the form needs; tests pin it.
- In (provisionally): raising `minTinyjsVersion` in `apps/andon/tinyjs.json` to the Tiny release
  that adds menu-item icons (the human updates Tiny outside the job, as for brief `tinyjs-065`).
- Out: icons on Copy Project Path or Reveal in Finder; a fake HTML menu; reaching around Tiny to
  AppKit; any change to the service, the API gate, or the `factory/v1` contract.

## Acceptance sketch
- In the Mac app, Open in ▸ shows VS Code's, T3 Code's, and Ghostty's own icons beside their names.
- A missing app keeps its grayed-out item (dimmed or no icon), and the menu still opens.
- An icon that can't load leaves the item without an icon; the action still works.
- Nothing else in the menu, the API gate, or a plain browser changes. The gate passes.

## Contract calls
None.

## Open
1. **Blocked on Tiny JS.** Waiting on a release where a menu item can carry an icon. What Andon
   asked for (2026-10-28): an `icon` field on `TinyMenuItem`, working in `menu.setContext` and
   inside submenus, drawn at menu size, dimmed when disabled, and silently absent when it can't
   load; ideally a `file:<path>` form (the Finder icon of a path or `.app`) or an
   `app:<bundle id>` form, plus `sf:<symbol>` and png paths to match the tray. Re-open this brief
   when Tiny's changelog shows it.
2. Once the shape is known: where each icon comes from. Recommended: the native form if Tiny
   ships `file:`/`app:` (VS Code, Ghostty, and T3 Code's `.app`); otherwise `thumbnail()` pngs
   fetched when the menu is built, alongside the installed-app check.
3. Once the shape is known: a missing app's item. Recommended: grayed out with its icon dimmed
   when the icon is still findable, no icon otherwise.
