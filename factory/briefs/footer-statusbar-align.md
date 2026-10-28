# Align the sidebar footer with the status bar, and fade the legend

- Status: done
- Job: 042-footer-statusbar-align (merged f8db653, 2026-10-28)
- Sources: `apps/andon-ui/src/app.css` (`.service`, `.statusbar`, `.legend`), `apps/andon-ui/src/StatusBar.svelte`, `apps/andon-ui/src/Sidebar.svelte`, `docs/design/andon-overview/design.md` (§3 status bar 28px, Footer), brief `factory/briefs/sidebar-footer-oneline.md`
- Date: 2026-10-28

## Intent
The sidebar's connection footer (about 35px tall) and the main view's status bar (28px) both
have a top divider, and the two dividers meet at different heights at the sidebar edge. They
should be one continuous line. While there, the status bar's legend should recede until the
person hovers it.

## Decisions
1. Shared height? → **28px for both: the sidebar footer shrinks to the status bar's height, one
   shared value (e.g. a CSS custom property) defines both, and the footer's dot and text stay
   vertically centered on their one line.** Why: 28px is the documented status-bar height; 35px
   would be too big for the legend area. One shared value keeps them from drifting apart.
2. What fades, and what reveals it? → **Only the legend fades, to about 45% opacity. Hovering
   anywhere on the status bar brings it to full opacity with a ~150ms ease (instant under
   `prefers-reduced-motion: reduce`). The settle text and clock are unchanged.** Why: the bar is
   a thin strip, so the whole bar is an easy hover target; the clock and settle text are already
   muted and should stay readable at a glance; 150ms matches the board's search dimming.

## Scope
- In: `apps/andon-ui`: the `.service` footer's height and centering, the `.statusbar` height
  from the same shared value, the legend's resting opacity and hover reveal (with the
  reduced-motion case); the Footer and Status bar lines in
  `docs/design/andon-overview/design.md` to match (footer 28px, aligned with the status bar;
  legend dimmed until hover).
- Out: the footer's text, states, tooltip, and announcements (job 041's work stands); the
  legend's entries, order, and screen-reader label; the settle text and clock; the sidebar
  width; the status bar's hide toggle; the Mac app (`apps/andon`), the service, and the contract.

## Acceptance sketch
- With the status bar shown, the sidebar footer's top divider and the status bar's top divider
  sit at exactly the same height and read as one line across the sidebar edge.
- Both are 28px tall; the footer's dot and `Connected · N projects` text are vertically
  centered. `Connecting…` and `Unreachable` fit the same way.
- With the status bar hidden (the Mac app's toggle), the footer is still 28px and looks right.
- At rest the legend is visibly dimmed (about 45%); the settle text and clock are not.
- Hovering anywhere on the status bar fades the legend to full opacity in about 150ms; leaving
  fades it back. With reduced motion, the change is instant.
- Light and dark both look right.

## Contract calls
None. (The design doc's Footer and Status bar lines are updated in the same diff; it isn't the
contract.)

## Open
None.
