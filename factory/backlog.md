# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.

- [x] Andon's window says when no service is answering — while the Mac app's probe finds no service, the main window shows a minimal self-contained page (inline HTML from the Mac app: no network, no scripts, no Tiny API access; light and dark) reading "No Andon service is answering" with the command `factory service install` (and `factory service start` if it's installed but stopped), instead of a blank window; once the probe finds the service, the window loads the board (`pageUrl`) without a relaunch; the tray notice stays; the pure parts (the page's HTML, when to switch) are `bun:test`-covered; if Tiny can't show inline HTML or change a window's URL, the job escalates rather than adding UI files to `apps/andon` → 071-andon-no-service-page
