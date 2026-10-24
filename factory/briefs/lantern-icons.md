# Lantern icons and badge for the Dock and tray

- Status: done
- Job: 019-lantern-icons-badge (merged e98227f, 2026-10-23)
- Sources: apps/andon-shell/tinyjs.json, apps/andon-shell/src/backend.ts, apps/andon-shell/src/badge.ts, ~/.tinyjs/template/types/tiny.d.ts (`app.presence`, `app.icon`, `app.badge`), HANDOFF.md decision 9; job 016-tray-click-toggle (the tray toggle, split from this)
- Date: 2026-10-23

## Intent
Andon becomes a regular app with a Dock icon as well as the tray icon, and both use a paper
lantern (an andon is a Japanese paper lantern). The icons show the board's state at a glance: an
unlit lantern when nothing is happening, a lit one when jobs are running, and an orange flame
when a job needs a human.

## Decisions
1. Does Andon get a Dock icon? → **Yes, always: a regular app (drop `"activation": "accessory"`),
   keeping the tray icon.** Why: the user wants both; a Dock icon is a second way back to the board.
2. What does the Dock icon show? → **A paper lantern in three states: unlit (idle), lit by a blue
   flame (jobs running), lit by an orange flame (any job needs a human).** Why: the board's state
   at a glance, in the name's own motif.
3. What does the tray icon show? → **A one-color lantern as a template image, in two states: line
   art (outlined) when no jobs are running, solid filled when jobs are running.** The needs-human
   count beside it stays as it is. Why: macOS draws tray icons as single-color templates that
   adapt to light and dark menu bars, so a colored flame doesn't belong there; outline versus
   fill carries the running state instead.
4. Which state wins, and what counts as each? → **Needs a human = any job in `needs-human`;
   running = any job in `claimed`, `spec`, `build`, `review`, or `approve`; idle = neither
   (all merged, or no jobs). Counted across every project Andon follows. In the Dock, the orange
   flame wins over the blue one.** Why: the Dock icon is the "do I need to look?" signal; the
   tray still shows both (filled = running, the count = needs a human).
5. Where do the images come from? → **The human supplies them before the job runs, committed at
   fixed paths under `apps/andon-shell/assets/`: `icon.png` (unlit, 1024², also the bundle icon
   and the idle Dock icon), `dock-running.png` (blue flame, 1024²), `dock-escalated.png` (orange
   flame, 1024²), `tray-idle.png` (outlined, 36², black on transparent), `tray-running.png`
   (filled, 36², black on transparent). The brief stays draft until they exist; the job only
   wires them.** Why: a job can't make good artwork; the tray glyphs need a hand cleanup pass.
   The images are in place (Dock: generated with Codex, 2026-10-23; tray: hand-drawn on a 36 px
   grid, sources in `apps/andon-shell/assets/source/`: `tray-idle.svg`, `tray-running.svg`, and
   `tray-lantern.py`, which regenerates both PNGs).
6. How does Andon launch now that it's a regular app? → **Like a regular app: the window shows at
   launch; closing it hides it (the app keeps running in the Dock and tray); clicking the Dock icon
   brings it back.** Why: the user wants it to act like a regular app; a launch that shows nothing
   feels broken.
7. What do the icons show before the agent answers, or when it fails to start? → **The idle look:
   the unlit Dock lantern and the outlined tray lantern.** The tray tooltip already says what's
   happening. Why: there's no board state to show yet.
8. Does the Dock icon carry a badge? → **Yes: the needs-human count (the tray's number), via
   `app.badge`; cleared (`''`) at zero, before the agent answers, and when it fails to start.**
   Why: the count at a glance in the Dock; folded in here (2026-10-23) instead of its own brief
   because it's one call on the same state in the same adapter, and a separate job would
   conflict with this one at merge.

## Scope
- In: drop `"activation": "accessory"` from `apps/andon-shell/tinyjs.json` (the window shows at
  launch); set the bundle icon to `assets/icon.png`; a runtime-neutral rule (with `bun:test`
  coverage) that maps the shell's board state to `idle` | `running` | `escalated` per decision 4;
  the Tiny adapter switches the Dock icon (`app.icon`, `''` or `icon.png` for idle) and the tray
  icon (`tray-idle.png` / `tray-running.png`, as a template image) only when the state changes,
  and keeps the tray's needs-human count and tooltip as they are; the Dock badge shows the same
  count (decision 8), set only when the count changes.
- Out: bouncing the Dock icon; the
  tray toggle and its fixes (job 016); new artwork (the assets are fixed inputs); any contract
  code in the shell (HANDOFF.md decision 9); any change to the agent or the board UI.

## Acceptance sketch
- Launching Andon shows its window and a lantern in the Dock; closing the window leaves the app
  running, and clicking the Dock icon or the tray brings the window back.
- With no live jobs, the Dock shows the unlit lantern and the tray the outlined lantern.
- When a job is claimed or in progress anywhere, the Dock shows the blue flame and the tray the
  filled lantern; when every job merges, both go back to idle.
- When any job is in `needs-human`, the Dock shows the orange flame even if other jobs are
  running, and the tray shows the filled lantern if any are running (outlined if not), with the
  count beside it as today.
- The Dock badge shows the needs-human count whenever it's above zero and matches the tray's
  number; at zero it's cleared.
- Before the agent answers and after it fails to start, both icons show the idle look and the
  Dock has no badge.
- The tray icon adapts to light and dark menu bars (template image).
- Unit tests pin the state rule for each case above, the badge text for zero and non-zero
  counts, and that the adapter only changes icons and the badge when they change.

## Contract calls
None.

## Open
None.
