# Repository-aware Andon

- Status: draft
- Sources: the explore request of 2026-10-31 (hand-offs to Infra on Moya, then "Open on GitHub"); brief `andon-machines-mac` (which deferred `andon-remote-handoff`); briefs `t3-handoff`, `t3-start-work`, `project-context-menu`
- Date: 2026-10-31

## Intent
Andon learns each project's git remotes (host, owner, name) from the service, on every machine.
With it, the Mac app hands `/factory …` commands to T3 Code as drafts for projects on other
machines too, wherever T3 Code's links can name them, and a project's menu can open its
repository on GitHub or whichever provider hosts it.

## Members
- `andon-remote-handoff` — the service reports each project's git remotes (`repositories`), and T3 Code drafts work for projects on other machines whose origin a T3 Code link can name
- `andon-open-repository` — a project's menu opens its repository on its provider's website after: `andon-remote-handoff`
