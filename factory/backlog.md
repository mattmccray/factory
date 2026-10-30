# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.

- [ ] `bun run release` refuses stale workspace links — before writing anything (and on `--dry-run`), it checks that every `workspace:*` dependency of the root, `packages/*`, and `apps/*` is linked in `node_modules`; when one is missing or points elsewhere it exits 1 with "workspace links are stale: run `bun install`, then retry" and writes nothing (no commit, tag, or `release` branch); it never runs `bun install` itself; `docs/upgrade.md`'s self-upgrade steps gain `bun install` before `bun run release`; tested with a missing link
- [ ] Harden `factory service` unit writes and document its path refusals — `servicehost.ts` writes the unit file through a temp file opened exclusively (`flag: 'wx'`, a fresh unpredictable name) so an existing file or symlink at the temp path is never followed or overwritten, then renames it into place, removing the temp on failure; `docs/contract/v1.md` `### service` lists `install`'s refusals when the `factory` path, `bun` path, or home directory is not absolute or contains a newline or NUL; tests cover a pre-existing symlink at the temp path; no behavior change otherwise
- [ ] Andon's window says when no service is answering — while the Mac app's probe finds no service, the main window shows a minimal self-contained page (inline HTML from the Mac app: no network, no scripts, no Tiny API access; light and dark) reading "No Andon service is answering" with the command `factory service install` (and `factory service start` if it's installed but stopped), instead of a blank window; once the probe finds the service, the window loads the board (`pageUrl`) without a relaunch; the tray notice stays; the pure parts (the page's HTML, when to switch) are `bun:test`-covered; if Tiny can't show inline HTML or change a window's URL, the job escalates rather than adding UI files to `apps/andon`
