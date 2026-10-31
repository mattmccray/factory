# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.

- [x] Andon across machines — every machine's projects on one trouble-first board through the local service as a hub (tailnet via `tailscale serve`, `factory peers`, one hop), with machine status, and the Mac app's badge, notifications, and native actions covering remote projects — epic: factory/epics/andon-multi-machine.md → epic andon-multi-machine
