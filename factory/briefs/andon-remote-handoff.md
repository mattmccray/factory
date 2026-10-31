# Hand off to T3 Code on another machine

- Status: ready
- Sources: epic plan `factory/epics/andon-repository-links.md`; the explore request of 2026-10-31 (testing hand-offs to Infra on Moya); brief `andon-machines-mac` (job 081, which deferred this as `andon-remote-handoff`); briefs `t3-handoff` (job 036), `t3-start-work` (job 068), `job-session-link`; `apps/andon/src/handoff.ts`, `startwork.ts`; T3 Code (Beta) desktop app and `t3` v0.1.6, read and tested 2026-10-31
- Date: 2026-10-31

## Intent
From Andon on Rocinante, Matt hands a `/factory …` command (a new exploration, Run next, a
needs-human approve, and so on) for a project on another machine, such as Infra on Moya, to T3
Code on Rocinante. T3 Code then opens a draft in that machine's project, instead of Andon only
copying the command as it does today.

## Facts (2026-10-31)
- Today every hand-off and Start Work for a remote project comes back `copy-only`
  (brief `andon-machines-mac`, decision 2).
- `t3code://new` accepts only `prompt`, `repo`, `pr`, `provider`, and `model`. It has no
  environment or project parameter.
- `repo=<owner>/<name>` matches a project in **any** environment the desktop app is connected
  to, taking the most recently updated match. It matches only projects whose origin is on
  `github.com`, `git.cafe`, or `staging.git.cafe`.
- Tested: `t3code://new?…&repo=smcneese/hero.client` (a local Bitbucket project) showed
  "You don't have smcneese/hero.client", and its Clone button failed. Bitbucket and self-hosted
  origins can't be named by a link.
- Infra on Moya (`6bb1e650df35@moya`, `/home/mattm/projects/infra`) has origin
  `ssh://git@localhost:222/mattm/infra.git`, which is self-hosted. It is the only remote
  project Andon follows today.
- `t3 thread start` talks only to the local T3 server and has no environment flag.
  `t3 environment list` shows no linked environments on Rocinante; the Moya connection lives
  in the desktop app only.
- Andon reads a project's `origin` with a local `git -C <root>`, which can't read a path on
  another machine. Remote drafts would need the hub to report each project's remotes, a change
  to the Andon service API in `docs/contract/v1.md`.
- T3 Code identifies a project by one remote (its `RepositoryIdentityResolver`): `upstream` if
  present, else `origin`, else the alphabetically first remote, ignoring local (`file:` or
  path) remotes. A link's `repo=` matches only that remote. So a repo whose `origin` is
  self-hosted can still be drafted into if a GitHub remote is added as `upstream`.

## Decisions
1. Can a T3 Code link reach Infra today? → **No. This is a T3 Code limitation, confirmed by
   test on 2026-10-31.** Why: links name a project only by a GitHub or GitCafe repository.
2. What do we do about it? → **Both: build the GitHub-origin slice now, and file a feature
   request with T3 Code's developer (a `t3code://new` parameter naming an environment and
   project, and `repo=` matching Bitbucket and self-hosted origins).** Why: many of Matt's
   projects are on GitHub and benefit today; once T3 Code broadens its links, other hosts should
   work with little or no change; meanwhile a project such as Infra can get a private GitHub
   repo as its `upstream` remote (see Facts). The feature request is Matt's to send, outside the job.
3. How does the Mac app learn a project's repository? → **The service reports every remote:
   each `GET /projects` entry gains `repositories: [{ remote, host, owner, name }]`, sorted by
   remote name, parsed by each machine's service from its own project's fetch remotes (https,
   `ssh://`, and `git@host:owner/name` forms; any host, ports kept in `host`; local remotes
   skipped; credentials never included), and passed through unchanged by the hub for peers'
   projects. Empty when there are none or none parse. Each consumer picks the remote it needs:
   drafts pick T3 Code's own primary remote (`upstream`, else `origin`, else the first by name)
   and draft only when its host is on the Mac app's T3 Code allowlist (`github.com` today, one
   list to widen when T3 Code does); the next member's "Open on…" prefers a GitHub remote. The
   Mac app uses this for local and remote projects alike; the local `git remote get-url` call
   goes away.** Why: Matt's repos often have several remotes; a draft must name the remote T3
   Code will match, or it fails as the Bitbucket test did; a raw URL could carry a token across
   the tailnet and every client would re-parse it; the data stays the same when T3 Code
   broadens, only the picking rule changes.
4. "Open on GitHub" in the project menu? → **Not in this brief: it is the next member of epic
   `andon-repository-links`, `andon-open-repository`, after this one.** Why: keeps this diff to
   the contract, service, and hand-off; the menu item has its own questions (each host's web
   URL, self-hosted origins).
5. One repository on several machines? → **A draft opens only when exactly one project in the
   hub's merged `/projects` list has that repository as its T3 Code primary remote (host,
   owner, and name, compared without case). With two or more, the click copies only and the toast names the machines, e.g.
   "factory is on rocinante and studio; copied …". This holds for local projects too.** Why:
   T3 Code picks the most recently updated matching project across every connected machine
   (read from its code, 2026-10-31), so a draft could open in the wrong checkout, where
   `/factory next` or `explore` would run. Known gap: a checkout T3 Code knows but Andon doesn't
   follow can still win; the T3 Code request (decision 2) closes it.
6. Send mode for a remote project? → **It opens a draft instead, by decision 5's and the draft
   path's rules, and the toast says so (e.g. "Opened a draft in T3 Code (sending can't reach
   moya)"); when no draft is possible it copies only, as in draft mode. Local projects in send
   mode are unchanged.** Why: `t3 thread start` reaches only the local T3 server; a draft is the
   safer fallback (Matt still presses send) and beats copy-only.

## Defaults (not questioned; the spec-writer may refine)
- Every hand-off path follows the same rules: the needs-human Approve, Rework…, and Abandon…
  (`handOff`), the five Start Work actions (`startWork`), and the project menu's New
  Exploration… and Run Next, which go through them. Copy mode, and a Mac without `t3`, still
  copy only. Every click still also copies.
- A peer on an older release sends no `repositories`: its projects read as having none
  (copy-only, as today) until it is upgraded.
- The page still sends only ids, the action, and Matt's note or idea; the backend picks the
  repository from its own `/projects` list. The API gate is unchanged (no new method).
- Open in ▸ T3 Code (`t3 app <root>`) stays grayed out for a remote project.

## Scope
- In: `docs/contract/v1.md` (the contract call); `packages/andon-service`: reading the fetch
  remotes and parsing each into `{ remote, host, owner, name }` (a pure, `bun:test`-covered
  parser: https, `ssh://`, scp-like forms, ports, `.git` suffixes, local remotes skipped, no
  credentials ever kept), adding `repositories` to each local project in `GET /projects`, and
  passing peers' values through the hub; `apps/andon`: drafts from T3 Code's primary remote among
  the listed `repositories`, for local and remote projects (the local `git remote get-url` call
  removed), the GitHub-only host allowlist, the one-project-per-repository check, send mode's
  draft fallback for remote projects, the new outcomes; `apps/andon-ui`: their toasts.
- Out: a project menu item that opens the repository (member `andon-open-repository`);
  starting threads on another machine by any other route (SSH, `t3 environment link`, the
  Andon service running `t3`); hosts other than `github.com` in the allowlist; the T3 Code
  feature request itself (Matt sends it); any change to the `factory/v1` job or event schema.

## Acceptance sketch
- `GET /projects` lists `repositories` for each project: `[{ remote: "origin", host:
  "github.com", owner: "mattmccray", name: "factory" }]` for this repo; Bitbucket and
  self-hosted remotes parsed too (e.g. Infra: remote `origin`, host `localhost:222`, owner
  `mattm`, name `infra`); every remote listed, sorted by name; empty with none; an https remote
  carrying a user or token never shows it. Peers' projects carry their own machine's values
  through the hub.
- With a remote project whose T3 Code primary remote (`upstream`, else `origin`, else first)
  is on GitHub and unique across Andon's machines, a new
  exploration, Run next, or a needs-human approve opens a T3 Code draft in that machine's
  project with exactly the command, and copies it (`manual`, e.g. after giving Infra a GitHub
  `upstream`).
- A project with a GitHub remote that isn't its T3 Code primary remote (e.g. `origin`
  self-hosted, `github` on GitHub) does not draft; it copies only, as below.
- A remote project whose primary remote isn't on GitHub copies only, with the "No GitHub remote" toast;
  one whose repository is on two machines copies only, naming both machines.
- In send mode, a remote project opens a draft instead and the toast says so; a local project
  still sends.
- Local projects behave as before, now reading `repositories` from the service.
- The gate passes.

## Contract calls
- "`docs/contract/v1.md`, 'Andon service', `GET /projects`: each entry also carries
  `repositories: [{ remote, host, owner, name }]`, sorted by remote name, parsed from the
  project's fetch remotes by the service on that project's machine (local remotes skipped, no
  credentials), and passed through by the hub for peers' projects (added within v1,
  additively)", approved by Matt on 2026-10-31 (amended the same day from a single `origin`
  `repository`). The job
  updates the contract doc (and its installed copy is promoted later, as usual) to match.

## Open
None.
