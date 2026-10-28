# Compact merged tokens

- Status: ready
- Sources: `apps/andon-ui/src/Token.svelte`, `apps/andon-ui/src/lanes.ts` (`tokenOf`, `sinceText`, `age`), `apps/andon-ui/src/app.css` (`.tok`); Matt's screenshot of 037's merged token (2026-10-28)
- Date: 2026-10-28

## Intent
On Andon's board, a merged job's token takes three lines: the number and title, then the check
and sha with `R1/2`, then the time, which wraps because "1h 30m ago" takes almost half the
token's width. Merged tokens should take one line, so the Merged column takes less vertical
space. The hover popover and the drawer already carry everything the token drops.

## Decisions
1. What does a merged token show? → **One line: the number, the title (ellipsized), and the
   time in its largest unit only, with no "ago" (`45m`, `1h`, `2d`).** The sha, the check,
   and `R1/2` leave the token. Why: the green edge and the column already say merged, the
   column header already says "last 24 hours", and the hover shows the sha (its note), the
   time, the round, and every round's verdicts. The number stays because it is how a job is
   found in the CLI and the files.
2. Settled tokens and the focused project view? → **The same form everywhere: every merged
   token, settled ones included, in the overview and in a focused project.** In the focused
   view the title may still wrap to two lines as other tokens' titles do there, but the branch
   line is dropped. Why: the Merge step deletes `factory/<id>`, so a merged job's branch line
   points at nothing, and one shape for "done" keeps the Merged column short in both views.
3. Does the short time apply anywhere else? → **No: merged tokens only.** Working tokens keep
   their time in stage as `1h 30m`, and the gutter keeps "Idle · last merge 3d 12h ago". Why:
   a working token's time is a live timer where the minutes matter, and neither place wraps.

## Scope
- In: the merged token's model and markup in `apps/andon-ui` (`lanes.ts`, `Token.svelte`,
  `app.css`), and its tests.
- Out: the time format on working tokens and in the gutter; the hover popover and the drawer (unchanged; they keep the sha, round, and full time);
  any change to the service, the API, or the `factory/v1` contract.

## Acceptance sketch
- A merged token on the board is one line: number, title, short time. A long title ellipsizes;
  the time never wraps.
- Settled tokens (dimmed, in a focused project's Merged cell) take the same form. In the
  focused view a merged token shows no branch line; its title may wrap to two lines.
- The time shows only its largest unit, with no "ago".
- The hover popover for a merged job still shows the sha, the time, and the round.
- Tokens in other columns are unchanged, including their `1h 30m` time in stage. The gate passes.

## Contract calls
None.

## Open
None.
