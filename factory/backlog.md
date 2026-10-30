# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.

- [ ] Andon's boundary test checks only git-tracked files — `apps/andon/src/boundary.test.ts`'s "no .html or .css file and no frontend directory" test lists `apps/andon` with `git ls-files` instead of walking the filesystem, so gitignored local output (such as a built `apps/andon/dist/`) never fails it; a tracked `.html`/`.css` file or a tracked file under `frontend/`, `public/`, `web/`, or `dist/` still fails it; the gate passes with `apps/andon/dist/` present; no other test changes
