# Andon desk widget

- Status: ready
- Sources: `docs/design/desk-widget/` (the mock-ups; the chosen one is `chosen/desk-widget.html`)
- Date: 2026-11-01

## Intent
A small, live view of the Andon board on the macOS desktop: each job is a little graphic that
shows its state, without names or detail. You can see at a glance what's running, what's in
review, and what needs you, without opening the full Andon window.

## Decisions
1. Real WidgetKit widget, or a desktop-level window from Andon? → **A window from Andon (Tiny
   JS): transparent, frameless, at the `desktop` window level, fed live by the service's
   `/events?settled=summary` stream.** Why: it has to be live to show jobs moving through their
   stages, and WidgetKit's refresh budget makes it stale. It also stays all TypeScript, reuses
   the service and the contract types, and keeps the Mac app thin (decision 10). It isn't in the
   macOS widget gallery and shows only while Andon is running; Matt accepted both.
2. Visual direction? → **Mock-up A2: one row per project, each job a 4-segment progress pill
   (spec · build · review · approve), with the current segment in its stage color (Andon's
   palette), earlier segments dimmed, later ones empty. "Needs you" turns the current segment
   red with a red glow. A just-merged job's pill goes green, then fades out. An epic's member
   jobs sit in a small bracket on their project's row. Each pill has a hover tooltip (project,
   job id, epic, stage and round, or why it needs you). A footer reads "<n> needs you" and the
   live/merged counts. Changes animate (color, enter, exit, reflow).** Why: it's the most
   compact choice that still shows which project a job belongs to and how far along it is.
   Reference mock-up: `docs/design/desk-widget/chosen/desk-widget.html` (and `.png`).
3. Which projects show? → **Only projects with live work (a job or epic member that hasn't
   settled, including one that just merged and is fading out). With no live work at all, the
   widget collapses to a small, nearly empty glass panel.** Why: Matt wants it concise and
   empty when nothing is running.
4. Placement across Spaces? → **The same spot on every Space: the `desktop` window level
   (behind normal windows) with `setAllSpaces(true)`, its position remembered per display. It
   must never show over a fullscreen app; if Tiny JS's all-Spaces behavior can't avoid that,
   the job escalates instead of shipping it.** Why: Matt wants it anchored like a widget as he
   switches workspaces.
5. Interaction? → **Drag the glass to move it. Hover shows the tooltips. Clicking a pill opens
   the main Andon window on that job; clicking elsewhere on the widget brings Andon forward. It
   is not click-through.** Why: it's a quick way into the board, and tooltips need the mouse.
6. Turning it on? → **A "Desk Widget" checkmark toggle in three places, kept in sync: the
   Window menu, the tray menu, and Settings. Off by default and remembered across launches (an
   Andon setting, like `statusBarHidden`). The first time it's turned on, it appears in the
   top-right corner of the main display.** Why: it stays out of the way until wanted, and the
   tray is where Matt reaches for Andon when its window is closed.
7. Which machines? → **Every machine, as the main board shows: the same hub data. A remote
   project's row label and tooltips name its machine (the board's `projectLabel`).** Why: a job
   that needs Matt on another machine is exactly what he wants to see at a glance, and a widget
   that showed less than the board would be a difference to remember.
8. Where the code lives? → **The widget's view is a page of the Andon UI (Svelte, in
   `apps/andon-ui`), served by the service and reading its existing `/events?settled=summary`
   stream. The Mac app (`apps/andon`) only opens and places the window and wires the toggles and
   clicks. No new runtime dependency, and no service or contract change.** Why: decision 10 keeps
   the Mac app thin and keeps contract code out of it; the approver escalates otherwise.

## Scope
- In: the desk widget page in the Andon UI (A2 design, animated); the Mac app's widget window
  (transparent, frameless, `desktop` level, all Spaces, draggable, position remembered per
  display, not in the Window menu's window list or the app switcher); the "Desk Widget" toggle in
  the Window menu, the tray menu, and Settings, backed by one remembered setting (off by
  default); clicking a pill opens the main window on that job, and clicking elsewhere brings
  Andon forward; tests for the page's logic and the Mac app's wiring; a line in decision 10
  naming the desk widget (see Contract calls).
- Out: a native WidgetKit/Swift widget; a widget-gallery entry; resizing, themes, or other
  layouts (A1, C1, C2); any change to the Andon service's API or the `factory/v1` contract;
  actions from the widget (approve, rework, and so on).

## Acceptance sketch
- With the toggle off (the default), there's no widget. Turning it on from any of the three
  places shows it and checks all three; turning it off hides it and unchecks all three. The
  choice survives quitting and relaunching Andon.
- The first time, it appears in the top-right corner of the main display. Dragged elsewhere, it
  comes back there after a relaunch, and it stays at that spot when switching Spaces.
- It sits behind normal windows and never appears over a fullscreen app.
- It shows one row per project with live work, from every machine, and nothing for idle
  projects. With no live work anywhere, it collapses to a small, nearly empty glass panel.
- Each job is a 4-segment pill with its current stage colored, earlier segments dimmed, and
  later ones empty. "Needs you" is red and glowing. A merged job's pill goes green, then fades.
  An epic's members sit in a bracket. Changes animate as stages change live, with no reload.
- Hovering a pill shows its project (and machine when remote), job id, epic, and stage with
  round, or why it needs you. The footer shows the needs-you count and the live/merged counts.
- Clicking a pill brings the main Andon window forward with that job selected. Clicking
  elsewhere on the widget brings Andon forward.
- `bun run test && bun run check` pass.

## Contract calls
"Decision 10 gains a line naming the desk widget as part of the Mac app: an optional,
remembered, desktop-level window showing the board in compact form, its view a page of the
Andon UI.", approved by Matt on 2026-11-01. The job updates `docs/decisions.md` to match.

## Open
None.
