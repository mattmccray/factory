# Open a project's repository from its menu

- Status: ready
- Sources: epic plan `factory/epics/andon-repository-links.md`; the explore request of 2026-10-31 ("add another right-click option … to open on GitHub or whatever provider"); brief `andon-remote-handoff` (the `repositories` field it adds to `GET /projects`); briefs `project-context-menu` (job 033), `andon-machines-mac` (job 081); `apps/andon/src/projectmenu.ts`
- Date: 2026-10-31

## Intent
Right-clicking a project in Andon offers to open its repository on the provider's website
(GitHub, Bitbucket, and so on), for projects on this Mac and on Matt's other machines alike.

## Facts (2026-10-31)
- The project menu is New Exploration…, Run Next, a separator, Copy Project Path, Reveal in
  Finder, a separator, Open in ▸ VS Code, T3 Code, Ghostty (`projectmenu.ts`). For a remote
  project, Reveal in Finder and Open in are grayed out, because they would act on a path that
  isn't on this Mac.
- After member `andon-remote-handoff`, each `GET /projects` entry carries
  `repositories: [{ remote, host, owner, name }]`, sorted by remote name, with no credentials.
  Opening a web page uses no path, so the item can work for remote projects too.

## Decisions
1. Which hosts, and what label? → **A fixed list of known hosts with a known web URL form:
   `github.com`, `bitbucket.org`, `gitlab.com`, `git.cafe`, each opening
   `https://<host>/<owner>/<name>` in the default browser. The label names the provider ("Open
   on GitHub", "Open on Bitbucket", …). A project with no remote on a known host (e.g. Infra's
   `localhost:222`) shows the item grayed out as "Open Repository". The URL is built only from a
   listed host plus an owner and name that pass a strict character check, never from a peer's
   arbitrary host.** Why: the menu keeps one shape for every project; a self-hosted SSH host has
   no web URL Rocinante can reach; a peer's data can never make Andon open an arbitrary URL.
2. Which remote, when there are several? → **A GitHub remote is preferred; otherwise the first
   remote (by name) on a known host.** Why: Matt's call (2026-10-31), "especially right now".
   Unlike drafts, opening a web page doesn't depend on T3 Code's choice of remote.
3. Where does it sit? → **Its own item right after Reveal in Finder (Copy Project Path, Reveal
   in Finder, Open on …), never inside Open in ▸; one item, with no submenu of providers.** Why:
   all three say where the project lives; Open in ▸ is apps on this Mac acting on the folder and
   is grayed out for remote projects, while this item works for them too.

## Defaults (not questioned; the spec-writer may refine)
- The item works the same for local and remote projects, and no root is ever used.
- As for the menu's other items, a click resolves the project id against the backend's own
  `/projects` list again and rebuilds the URL from its `repositories`; a stale or forged item id
  opens nothing. The URL is always `https://`.
- Several remotes on the preferred host: the first by remote name.
- No new backend method: the page's API gate is unchanged. The app menu and the Andon UI's own
  pages don't get the item.

## Scope
- In: `apps/andon` (`projectmenu.ts` and its backend wiring): the item, the known-host list and
  each host's label and URL form, the remote picking, the strict owner and name check, opening
  the URL, and tests (the menu's order for local and remote projects, the grayed "Open
  Repository", the URL for each host, refusal of an unknown host, a bad owner or name, and a
  stale id).
- Out: hosts beyond the four; self-hosted web URLs; a provider submenu; the app menu; any
  service or contract change (member `andon-remote-handoff` adds the data).

## Acceptance sketch
- Right-clicking this repo's project shows Copy Project Path, Reveal in Finder, "Open on
  GitHub", which opens `https://github.com/mattmccray/factory` (`manual`).
- A Bitbucket project shows "Open on Bitbucket" and opens its `https://bitbucket.org/…` page.
- A project with a self-hosted `origin` and a GitHub remote opens the GitHub page; with only the
  self-hosted remote (Infra today) the item is grayed out as "Open Repository".
- A remote project's item works exactly as a local one's.
- No URL is ever opened for a host outside the list or an owner or name failing the check
  (tests pin it).
- The gate passes.

## Contract calls
None.

## Open
None.
