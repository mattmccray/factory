# Andon sidebar footer on one line

- Status: ready
- Sources: Matt's screenshot of the footer wrapping as "Connected · andon-service · 3 / projects" (2026-10-28); `apps/andon-ui/src/sidebar.ts` (`footer`), `apps/andon-ui/src/Sidebar.svelte` (`.service`), `apps/andon-ui/src/app.css` (`.service`, `--sbw` 216px), `docs/design/andon-overview/design.md` (Footer), brief `factory/briefs/andon-rename.md`
- Date: 2026-10-28

## Intent
The sidebar's connection footer wraps wherever the browser decides ("Connected · andon-service ·
3" / "projects"), and its dot floats between the two lines. It looks haphazard. The footer
should be one tidy line that never wraps.

## Decisions
1. One line or a deliberate two-line stack? → **One line: `Connected · N projects` (singular
   `1 project`), dropping "andon-service" from the visible text.** Why: there is only ever one
   service, so naming it is noise for the person watching; the screen-reader announcement already
   says "Connected to the Andon service". "Connected · 12 projects" fits the fixed 216px sidebar
   with room to spare.
2. Can it ever wrap again? → **No: the footer text is `nowrap` with an ellipsis as a safety net,
   and the dot stays vertically centered on that one line.** Why: a long count or a larger system
   font must truncate, not break the line.
3. Is the service still named anywhere visible? → **Yes, on hover: the footer's tooltip is the
   same text as its screen-reader announcement (e.g. "Connected to the Andon service").** Why: the
   name stays discoverable without taking footer space; one source of wording for both.
4. The other states? → **Unchanged: `Connecting…` (gray dot) and `Unreachable` (red dot).**

## Scope
- In: `apps/andon-ui`: `footer()`'s live text and its test; the `.service` footer's CSS (one
  line, ellipsis, dot centered) and its tooltip; update the Footer line in
  `docs/design/andon-overview/design.md` to the new wording.
- Out: the sidebar's width, the other footer states, the screen-reader announcements, the Mac
  app (`apps/andon`), the service, and the contract. The historical `andon-rename` brief stays
  as written.

## Acceptance sketch
- Connected with 3 projects, the footer reads `Connected · 3 projects` on one line, with the
  green dot centered beside it; with 1 project, `Connected · 1 project`; with 12, still one line.
- The footer never wraps: text that doesn't fit ends in an ellipsis.
- Hovering the footer shows the announcement text naming the Andon service.
- `Connecting…` and `Unreachable` look and read as before.
- Light and dark both look right.

## Contract calls
None. (The design doc's Footer wording is updated in the same diff; it isn't the contract.)

## Open
None.
