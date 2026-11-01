# Andon desk widget

A small, live view of the Andon board that sits on the macOS desktop: one row per project with
live work, each job a little graphic of its state. The decisions behind it are in the brief,
`factory/briefs/andon-desk-widget.md` (explored with Matt on 2026-11-01).

## Layout

- `mockups/`: every concept we tried, kept for the record. Each is a self-contained HTML file;
  open it in a browser.
  - `round-1.html` (and `round-1.png`): four static directions on a simulated desktop. A, project
    rows; B, a dot field; C, mini lanes; D, a ring. Matt shortlisted A and C.
  - `round-2.html`: four animated iterations of A and C on a simulated board, with controls to
    pause, speed up, drain the board (the empty state), and add work. A1, chips that change
    color in place; **A2, a 4-step progress pill per job (chosen)**; C1, mini lanes with a "You"
    lane; C2, stage tracks with project initials.
- `chosen/`: the chosen design, A2, on its own. `desk-widget.html` is animated, and
  `desk-widget.png` is a still reference.

## The chosen design (A2)

- One row per project with live work, on every machine (a remote project's label names its
  machine). Idle projects don't show, and with no live work anywhere the widget collapses to a
  small, nearly empty glass panel.
- Each job is a pill of four segments: spec, build, review, approve. The current segment has its
  stage color (Andon's palette: spec teal, build indigo, review purple, approve blue), earlier
  segments are dimmed, and later ones are empty. "Needs you" turns the current segment red and
  the pill glows red. A just-merged job's pill goes green, then fades out.
- An epic's member jobs sit together in a small bracket on their project's row.
- Hovering a pill shows a tooltip: project (and machine), job id, epic, and stage with round, or
  why it needs you. A footer gives the needs-you count and the live and merged counts.
- Changes animate: segment colors, pills entering and leaving, and rows reflowing.

The mock-ups simulate the board with made-up projects and jobs; the real widget reads the Andon
service's live stream.
