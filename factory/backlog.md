# Factory backlog

`/factory next` runs the first unchecked item and ticks it off (`- [x] … → <job-id>`);
`/factory next <words>` (a few words from the line) runs that one instead.
One feature per line — what "done" looks like, not the history. Add lines with:

- `/factory queue <text>` — clear work, distilled into one line
- `/factory explore <idea>` — an interview first; the line points at the brief it writes

Lines are in dependency order. Fuzzy ones should go through `/factory explore` first.
- [x] Repository-aware Andon — the service reports each project's git remotes; T3 Code drafts work for GitHub projects on any machine; the project menu opens a project's repository on its provider — epic: factory/epics/andon-repository-links.md → epic andon-repository-links
- [ ] Escalate a spec's open questions at the spec step — a spec with an unapproved open question sends the job to Needs Human before the build, Andon tags it "Question" with an "asked here" ghost and Rework as the primary action, and rework returns it to Spec — brief: factory/briefs/spec-question-escalation.md
