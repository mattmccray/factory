# Backlog in Andon, and starting work from it

- Status: done
- Landed: 691eaf5 (2026-10-30)
- Sources: the explore request of 2026-10-29 (pre-1.0 notes: "Surface backlog/epics in Andon (read-only is fine at first)", "Deeper T3 Code integration … Start a backlog job, Start an epic, Start an exploration")
- Date: 2026-10-30

## Intent
Andon shows each project's queued backlog and its explorations in progress, read-only, and then
lets Matt start that work in T3 Code from where he sees it. Together because starting work needs
something to click, and the set is "what's next, and go".

## Members
- `andon-backlog-service` — the service reads the backlog, briefs, and plans: board counts, the backlog list, brief and plan text, and a `backlog` event
- `andon-backlog-ui` — the Backlog sheet, brief and plan pages in the inspector, deep links, search, and View → Show Backlog… after: `andon-backlog-service`
- `t3-start-work` — start a backlog job, an epic, or an exploration in T3 Code from Andon after: `andon-backlog-ui`
