# Rename Andon's parts: the service, the UI, and the app

- Status: done
- Job: 029-andon-rename (merged a53cb9c, 2026-10-27)
- Sources: `HANDOFF.md` (Decision 10, "Andon architecture"), `docs/contract/v1.md` ("Andon agent"), `README.md` ("Andon"), `docs/design/andon-overview/design.md`
- Date: 2026-10-27

## Intent
"Agent" means two things in this repo: the factory's subagents (spec-writer, builder,
reviewers, approver) and Andon's Bun daemon. The overlap makes code, docs, and conversation
ambiguous. Andon's three parts get names that don't collide. The daemon is **the Andon
service**, the Svelte board is **the Andon UI**, and the Tiny JS Mac app is just **Andon**. The
folders, package names, and root scripts follow the new names.

## Decisions
1. What is each part called, and where does it live? → **The daemon is the Andon service,
   `packages/andon-service` (`@factory/andon-service`, bin `andon-service`). The Svelte board is
   the Andon UI, `apps/andon-ui` (`@factory/andon-ui`). The Tiny JS Mac app is Andon (in prose
   "the Andon app" or "the Mac app" where it needs telling apart), `apps/andon`
   (`@factory/andon`).** Why: "agent" is overloaded, so the daemon gets a word nobody else uses.
   The Mac app is what people open, so it gets the plain name. The UI was already called "the
   Andon UI" in docs. `apps/andon` holds the UI today, so the UI moves out (`git mv apps/andon
   apps/andon-ui`) before the Mac app moves in (`git mv apps/andon-shell apps/andon`).
2. Not "Andon dashboard" for the Mac app? → **No.** Why: "dashboard" already names the v0
   `factory/dashboard.html` and the `config.json` key `dashboard.settleAfterHours`, and the
   browser board is just as much a dashboard as the Mac app.
3. What do the root scripts become? → **`andon` runs the Mac app (`bun run --cwd apps/andon
   dev`). `andon:build` builds the UI and then the Mac app. `andon:service` runs the daemon
   (`bun packages/andon-service/src/main.ts`). `andon:ui:build` and `andon:ui:dev` build the UI
   and run its Vite dev server. `check` runs svelte-check in `apps/andon-ui`. The old
   `andon:shell` and `andon:shell:build` go away, with no aliases.** Why: the plain name is
   the thing you open. The daemon is named for what it is. A clean break is easier to read
   than aliases, and every place that uses the scripts is in this repo.
4. Is "agent" renamed everywhere? → **No, only where it means the Andon daemon.** Every
   identifier, comment, log line, UI string, test name, and doc sentence meaning the Andon
   daemon says "service": for example `agentCommand`/`ensureAgent`/`probeAgent`/`startAgent`/
   `agentUrl` → `serviceCommand`/`ensureService`/`probeService`/`startService`/`serviceUrl`;
   the startup log `Andon service: <url> (registry …)`; the sidebar footer `Connected ·
   andon-service · N projects`; "The Andon service isn't answering" / "Connecting to the Andon
   service…". Anything meaning the factory's subagents keeps "agent": `AgentSpan`,
   `timing.agents`, the `agent.started`/`agent.finished` events, `agents` rows. Why: the point
   is to take the overlap away, not to move it somewhere else.
5. Is "shell" renamed? → **The component is no longer "the shell" in any name, comment, log, or
   doc: it's the Andon app or the Mac app. The log prefix `andon-shell:` becomes `andon:`. The
   `?shell=mac` query parameter and the UI's `shellMode` stay.** Why: `?shell=mac` describes the
   window the UI runs in (native frame or browser), not a component name. Renaming it means
   churn in `tinyjs.json` and the tests for no gain.
6. What doesn't change? → **The port (`ANDON_PORT`, default 8766), the registry
   (`ANDON_HOME`, default `~/.andon`, `projects.json`), every endpoint and payload, the build-time
   defines (`ANDON_REPO__`, `ANDON_BUN__`), the Tiny app id `dev.factory.andon` and its name and
   title, and the UI's behavior apart from the strings in decision 4.** Why: this is a rename.
   Nothing on disk or on the wire moves.
7. Where does the skill send people? → **The managed skill template's dashboard pointer names
   the service: "Andon, one service per machine. Run `bun run andon:service` in the factory
   clone (not in this project), then open http://127.0.0.1:8766/". It may add that `bun run
   andon` opens the Mac app.** Why: the browser path works on every machine. The Mac app needs
   Tiny JS installed.
8. Which docs change, and which stay as history? → **Change `docs/contract/v1.md`, `README.md`,
   `docs/design/andon-overview/{README.md,design.md}`, the chosen design
   (`docs/design/andon-overview/chosen/`, so its footer matches the UI), the templates' default
   overlays (`packages/templates/overlays/factory/roles/*.md`), and `.gitignore`. Leave
   `factory/briefs/*`, `factory/backlog.md`'s ticked lines, `docs/design/andon-overview/round-2.md`,
   and `docs/design/andon-overview/mockups/` as they are.** Why: briefs, ticked lines, and
   rejected mockups record what happened then. The rest describe the repo as it is.
9. Who updates `HANDOFF.md` and the installed copy? → **The human, after merge, outside the
   job.** Why: jobs never change `.claude/` or `factory/`, and `HANDOFF.md`'s binding decisions
   aren't a job's to edit.

## Scope
- In: the two `git mv`s and the third (`packages/andon-agent` → `packages/andon-service`);
  the three `package.json` names and the bin; `bun.lock` (regenerated by `bun install`); root
  `package.json` scripts; `.gitignore` build-output paths (`apps/andon-ui/dist/`,
  `apps/andon/{build,.build,dist}/`); every path that names the old folders (the service's UI
  dir `apps/andon-ui/dist`, the Mac app's autostart command
  `packages/andon-service/src/main.ts`, its asset path `apps/andon/assets/`, `build.ts`, the
  tests that pin them); the renames in decisions 4 and 5; the Mac app's boundary test,
  reworked so it still forbids imports from `@factory/*`, `apps/andon-ui`, and
  `andon-service`, and pins the package name `@factory/andon`, without flagging the Mac app's
  own folder; the service's source test, which pins the contract heading; the skill template's
  pointer and its render test (AC1 now looks for `` `bun run andon:service` ``); the docs in
  decision 8; tests.
- Out: `HANDOFF.md`; the installed copy (`.claude/`, `factory/`, including `factory/roles/` and
  `factory/CONTRACT.md`), which the human updates after merge; the history in decision 8; any
  change to ports, env vars, the registry, endpoints, payloads, or the Tiny app id; renaming
  `?shell=mac` or `shellMode`; any behavior change.

## Acceptance sketch
- `packages/andon-service`, `apps/andon-ui`, and `apps/andon` exist, with the package names in
  decision 1. `packages/andon-agent` and `apps/andon-shell` are gone, and `git log --follow`
  traces each file to its old path.
- `bun run andon:service` starts the daemon on 127.0.0.1:8766 and logs `Andon service: …`. It
  serves the UI built by `bun run andon:ui:build` from `apps/andon-ui/dist`. `bun run andon:build`
  builds the UI and the Mac app, and `bun run andon` runs the Mac app, which starts the service
  from `packages/andon-service/src/main.ts` when none is running.
- Outside the history files in decision 8, the installed copy, and `HANDOFF.md`, `git grep -iE
  'andon[- ]agent|andon[- ]shell|andon:shell'` finds nothing, and no identifier, string, or comment
  uses "agent" for the Andon daemon.
- The UI's footer reads `Connected · andon-service · N projects`, and its not-answering and
  connecting messages name the Andon service and `bun run andon:service`.
- `docs/contract/v1.md`'s section is "## Andon service", and it names `bun run andon:service`,
  `packages/andon-service`, and `apps/andon-ui/dist`, with nothing else in the section changed.
- The rendered skill points to `bun run andon:service` in the factory clone, at
  http://127.0.0.1:8766/.
- `bun run test && bun run check` pass.

## Contract calls
- "`docs/contract/v1.md`'s section 'Andon agent' is renamed 'Andon service'. Its text and the
  `config.json` `name` note call the daemon the Andon service, and it names `bun run
  andon:service`, `packages/andon-service`, and `apps/andon-ui/dist`. This is wording only: no
  port, env var, registry, endpoint, payload, or header changes." Approved by the user on
  2026-10-27. The job must update `docs/contract/v1.md` to match.

## Open
None.
