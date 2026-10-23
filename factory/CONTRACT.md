<!-- factory 0.1.0 · managed file, do not edit: it is replaced on upgrade. This is the installed copy of the factory/v1 contract -->
# Factory state contract — `factory/v1`

The fixed interface between a factory run and anything that observes it (the dashboard today,
Andon later). Projects may customize reviewers, rules, models, and gates; they may not change
anything in this contract. The code that implements it is `packages/contract`.

## Principles

1. **The event log is the truth.** Each job has an append-only `events.jsonl`. Everything else
   about a job's state is derived from it.
2. **One writer.** Only the factory CLI writes `events.jsonl` and `job.json`. Orchestrators run
   CLI commands; they never hand-write state.
3. **Clock, not model.** Every timestamp is taken by the CLI from the system clock. A model never
   supplies a time.
4. **Derived files are disposable.** `job.json` can be deleted and rebuilt from the log at any time.
5. **Source and state never share a tree.** `factory/jobs/`, `factory/.lock/`, `factory/.worktrees/`
   are runtime state (gitignored); no job's diff may write there.

## File layout

```
factory/
  CONTRACT.md                 # the installed copy of this contract (docs/contract/v1.md)
  config.json                 # project settings the CLI and dashboard read (tracked)
  managed.json                # managed-file manifest: version + sha256 per file (tracked; optional)
  roles/<role>.md             # overlay: the project's rules for one role (tracked; optional)
  cli.ts                      # the only writer of job state (managed: a self-contained bundle)
  backlog.md  briefs/         # human-facing queue and interview briefs (tracked)
  jobs/<id>/                  # runtime state, one dir per job (gitignored)
    events.jsonl              # append-only event log — the truth
    job.json                  # derived snapshot — what the board reads
    feature.md  rework-<k>.md # inputs written by the orchestrator
    spec.md  build.md  decision.md
    round-<N>/review-<key>.md # one per reviewer key in the round
    round-<N>/<key>/*         # that reviewer's supporting files, e.g. round-<N>/ui/*.png screenshots
  .lock/  .worktrees/<id>/    # runtime (gitignored)
```

Job id: `^\d{3}-[a-z0-9-]+$` (three-digit sequence + 2–4 word kebab slug). The CLI checks it before
building any path under `jobs/`, so a bad id never reads, writes, or creates anything.

## `config.json`

```json
{
  "schema": "factory/v1",
  "reviewers": ["security", "ux", "ui", "code"],
  "maxRound": 2,
  "dashboard": { "settleAfterHours": 24 },
  "gate": ["bun test", "tsc --noEmit"],
  "roles": { "builder": { "runner": "claude", "model": "sonnet" }, "ux": { "runner": "claude" } }
}
```

- `reviewers` — ordered reviewer keys (`^[a-z][a-z0-9-]*$`, at least one, unique, and none may
  equal a fixed role name: `spec-writer`, `builder`, `approver`). Each key `k` writes
  `round-<N>/review-<k>.md`. The order is the chip order on the board.
- `maxRound` — default review budget for a new job.
- `dashboard.settleAfterHours` — a merged job older than this is *settled*: hidden from the
  Merged column and listed in the Settled dialog. Purely a view; no event records it.
- `gate` — optional. The project's gate: an ordered, non-empty array of non-empty shell command
  strings. Agents run them in order from the worktree root, and the gate is green only when
  every command exits 0. There is no default: when `gate` is absent, no gate is configured, and
  agents say so instead of inventing a command. The CLI only validates it; it never runs it.
- `roles` — optional. Says how each role is run: an object mapping a role name to
  `{ "runner": "claude", "model"?: string }`. A role name is a fixed role (`spec-writer`,
  `builder`, `approver`) or a key in `reviewers`; any other name is an error. In an entry,
  `runner` is required, and `"claude"` (Claude Code) is the only accepted runner in v1; later
  v1 releases may accept more runners, additively (see "Runners"). `model` is optional: an opaque
  harness model name, not whitelisted, that must match `^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$` (so it
  can't break YAML frontmatter). Without it, or without an entry, or without `roles` at all, a
  role runs on the default model, `opus`. Unknown keys inside an entry are an error. The model is
  rendered into the role's managed agent file, so changing `roles` changes managed bytes and
  takes effect only after `factory upgrade` (the same as changing `reviewers`); until then the
  installed agents keep their old models, and `doctor` does not report that drift.

Unknown keys are an error, and `factory doctor` enforces the same. Later versions add a
tracker and merge policy — additively.

### Role overlays — `roles/<role>.md`

`factory/roles/<role>.md` is the project's own rules for one role, where `<role>` is
`spec-writer`, `builder`, `approver`, or a reviewer key. Together with `config.json` it is the
**overlay**: written by humans, tracked, and never a managed file. Each file is optional; a
missing one is normal and means the role's managed defaults apply. Each managed role document
tells its agent to read its overlay file at run time, so the overlay is never inlined into a
managed file and editing it never changes a managed file's hash. The overlay adds rules; it
never changes which file an agent writes, its path, or its first line.

## Runners

A **runner** is what fills a role: it takes a spawn card, does the role's work, and leaves the
role's one file on disk. In v1 the only runner is Claude Code (`"claude"`), which runs each role
as the agent `factory-<role>` (`factory-<key>` for a reviewer). This section is the **role I/O
protocol** every runner implements, whatever the harness. A runner that meets it can fill any
role; the orchestrator, the CLI, and the board can't tell runners apart.

**Input: the spawn card.** All context comes from files; the card gives only paths. The
orchestrator passes these fields, dropping the ones that don't apply:

| field | value | given to |
|---|---|---|
| `repo` | the absolute repo root `<R>` | every role |
| `job dir` | `<R>/factory/jobs/<id>` | every role |
| `worktree` | `<R>/factory/.worktrees/<id>` (branch `factory/<id>`, base `main`) | builder, reviewers, approver |
| `round` | the review round `<N>` | reviewers; the builder when resumed after round `<N>` |
| `brief` | `<R>/factory/briefs/<slug>.md` | spec-writer and approver, when the job has one |
| `write` | the one absolute path the role writes | every role |
| `deliver` | the instruction to create the `write` file, not to reply with its contents | every role |

A rework adds the path of `<job dir>/rework-<k>.md` to the builder's (or spec-writer's) card.

**Per role.** Each role also reads its overlay, `factory/roles/<role>.md`, when it exists, and
the project's instructions. "Writes" is the role's one file (the card's `write` path):

| role | reads | writes | first line |
|---|---|---|---|
| `spec-writer` | `feature.md`, any `rework-*.md`, the brief, the code | `<job dir>/spec.md` | `# <title>` (its H1 becomes `job.titled`) |
| `builder` | `spec.md`, any `rework-*.md`, the round's `review-*.md`, its own `build.md`, `config.json` (`gate`) | `<job dir>/build.md`, plus commits on `factory/<id>` in the worktree | `# Build — <id>` |
| reviewer `<key>` | `spec.md`, `build.md`, the diff `main...factory/<id>`, `config.json` (`gate`), its previous `round-<N-1>/review-<key>.md` | `<job dir>/round-<N>/review-<key>.md` (and supporting files under `round-<N>/<key>/`) | `VERDICT: PASS` or `VERDICT: CHANGES` |
| `approver` | `feature.md`, `spec.md`, `build.md`, any `rework-*.md`, the brief, every `round-*/review-*.md`, `config.json`, the diff and log | `<job dir>/decision.md` | `APPROVE` or `ESCALATE` |

The builder is the only role that changes code, and only in the job worktree. Reviewers and the
approver may run commands there (the gate) but never edit or commit.

**Never written by a runner:** `events.jsonl`, `job.json`, or anything else under `jobs/<id>/`
but the role's own file (and a reviewer's supporting files); the overlay (`config.json`,
`roles/**`); managed files (anything listed in `managed.json`); `.lock/`; the main checkout's
code; and `main` (no merge, no push).

**Spans and events stay with the orchestrator.** A runner never runs the CLI's `event` command.
The orchestrator brackets each run in one agent span (`agent.started` before, `agent.finished`
once the run returns and its file exists), with the identity fields in "`events.jsonl`", never
a harness's agent id. The CLI alone reads the verdict from the file's first line. A runner that
returns without its file gets the same nudge, re-spawn, and escalation as any other.

A non-normative design for runners other than Claude Code is in `docs/runners.md`.

## Managed files

`factory/managed.json` lists the files the factory manages (the installed skill, agents, CLI, and
contract) with the hash each had when it was installed, so `factory doctor` can tell an edited or
missing managed file from a pristine one:

```json
{
  "schema": "factory/v1",
  "version": "0.1.0",
  "files": {
    "factory/CONTRACT.md": "<sha256 hex>",
    ".claude/agents/factory-builder.md": "<sha256 hex>"
  }
}
```

- `schema` — `"factory/v1"`. `version` — a non-empty string naming the managed release.
- `files` — maps a repo-relative path to the SHA-256 of the file's bytes, as 64 lowercase hex
  characters. A path uses `/` separators, is never absolute, and never contains a `..` segment.
  A listed file that resolves (through symlinks) outside the repo is a failure; doctor never reads it.
- Unknown keys are an error, as for `config.json`.
- The file is optional. Without it the install is *unstamped*: doctor reports that and skips the
  hash checks without failing. Writing the manifest is the installer's job, not the CLI's.

Each rendered managed document also carries an **in-file version stamp**: one HTML comment line
that names the managed version, says the file is managed and must not be edited, and points to
its overlay path (`factory/roles/<role>.md` for a role document; `factory/config.json and
factory/roles/<role>.md` for the skill and `explore.md`), e.g.
`<!-- factory 0.1.0 · managed file, do not edit: … Project rules go in the overlay: factory/roles/builder.md -->`.
In a file with YAML frontmatter the stamp is the line right after the closing `---`, so the
frontmatter still parses; otherwise it is the first line. The stamp is part of the file's bytes,
so it is covered by the hash. The hash itself lives only in `managed.json`, since a file can't
contain its own hash. The templates are rendered by `packages/templates`, whose version is the
manifest's `version`.

The installed CLI and contract copy carry a stamp too, naming the same managed version:

- `factory/cli.ts` starts with one `//` comment line, e.g.
  `// factory 0.1.0 · managed file, do not edit: it is replaced on upgrade. Project settings go in the overlay: factory/config.json`.
- `factory/CONTRACT.md` starts with one HTML comment line, e.g.
  `<!-- factory 0.1.0 · managed file, do not edit: it is replaced on upgrade. This is the installed copy of the factory/v1 contract -->`,
  followed by this document's text.

As for the rendered documents, each stamp is covered by the file's hash, and the hash lives only
in `managed.json`. `factory init` writes the manifest and `factory upgrade` rewrites it (see "CLI").

## `events.jsonl`

One JSON object per line, UTF-8, `\n`-terminated, appended only. Every event has:

| field | type | |
|---|---|---|
| `ts` | string | ISO-8601 UTC with milliseconds (`new Date().toISOString()`), set by the CLI |
| `type` | string | one of the types below |

Plus the type's own fields:

| type | fields | effect on the job |
|---|---|---|
| `job.claimed` | `schema: "factory/v1"`, `id`, `maxRound`, `brief: string\|null`, `issue: string\|null` | first line of every log; stage `claimed` |
| `job.titled` | `title` | sets the card title (from spec.md's H1) |
| `stage.entered` | `stage` (`spec`\|`build`\|`approve`) | moves the job to that stage |
| `round.started` | `round`, `reviewers: string[]` (filled by the CLI from `config.reviewers` when omitted; the stored event always has it) | stage `review`; previous round (if any) moves to history; every listed reviewer `pending` |
| `agent.started` | `role` (`spec-writer`\|`builder`\|`reviewer`\|`approver`), `key?` (reviewer key), `round?`, `name?` (agent name/id, e.g. `builder-019-…`) | opens a timing span |
| `agent.finished` | same identity fields as its start, `verdict?` | closes the span; a reviewer's `verdict` (`PASS`\|`CHANGES`) sets its chip only when its `round` is the current round and its `key` is one that round listed (any other finish closes its span and changes no chip); the approver's (`APPROVE`\|`ESCALATE`) sets `decision` |
| `job.noted` | `note` | one-line card note |
| `job.escalated` | `reason` | stage `needs-human`; `note = reason`; closes every still-open agent span at this `ts` with `verdict: null` |
| `job.reworked` | `k`, `maxRound` | stage `build`; clears `decision`; `reworks = k`; `note = ""` |
| `job.human-approved` | — | `decision = "APPROVE (human)"` (idempotent: a repeat while `needs-human` is accepted and changes nothing) |
| `merge.failed` | `reason` | stage `needs-human`; `note = reason` |
| `job.merged` | `sha` | stage `merged`; `note = "merged <sha>"`; terminal |

`verdict` is never supplied by the orchestrator: the CLI reads it from the agent's file — the first
non-empty line, trimmed, which must be exactly `VERDICT: PASS` or `VERDICT: CHANGES` for reviews,
`APPROVE` or `ESCALATE` for decision.md — so the board can't disagree with the files.

A builder resumed for a new round (or a rework) gets a fresh `agent.started`/`agent.finished`
pair with the same `name`; spans never overlap for one identity.

### Transitions the CLI enforces

| from | allowed events |
|---|---|
| (no log) | `job.claimed` |
| `claimed` | `stage.entered spec`, `job.escalated` |
| `spec` | `job.titled`, `stage.entered build`, `job.escalated` |
| `build` | `round.started` (round = previous + 1), `job.escalated` |
| `review` | `stage.entered build` (only if round < maxRound and the round is complete), `stage.entered approve` (round complete), `job.escalated` |
| `approve` | `job.escalated`, `job.merged`, `merge.failed` |
| `needs-human` | `job.reworked`, `job.human-approved` → then `job.merged` \| `merge.failed` (a failed merge resets the approval, so `job.human-approved` is needed again before the next `job.merged`) |
| `merged` | nothing (terminal) |

`job.escalated` is allowed from every working stage (`claimed`, `spec`, `build`, `review`, `approve`),
not from `needs-human`. A job whose log has no `job.claimed`, or whose dir holds a `job.json` but no
`events.jsonl` (legacy), rejects every event — including `job.claimed`; only `job.claimed` on a
new id creates the job dir, and a rejected event leaves nothing behind. A merge from `needs-human`
needs a `job.human-approved` logged after any `merge.failed` (and after any `job.escalated`).
`job.human-approved` is idempotent while `needs-human`: logging it again when the job is already
human-approved is accepted (so a retried `approve` never fails on it) and has no further effect.

`job.noted`, `job.titled`, `agent.started`, and `agent.finished` are allowed in any non-terminal
stage. A round is **complete** when every reviewer listed in its `round.started` has an
`agent.finished` with a verdict (WAIT FOR ALL, enforced). An event that breaks these rules is
rejected with a non-zero exit and nothing is written.

## `job.json` — the derived snapshot

Rebuilt by the CLI after every append (written to a temp file, then renamed, so readers never
see a partial file). Field-compatible with the pre-contract `job.json`, plus timing:

```json
{
  "schema": "factory/v1",
  "id": "019-example", "title": "Example", "branch": "factory/019-example",
  "builder": "builder-019-example",
  "stage": "review", "round": 2, "maxRound": 2,
  "reviews": { "security": "CHANGES", "ux": "PASS", "ui": "pending", "code": "PASS" },
  "history": [ { "round": 1, "reviews": { "security": "CHANGES", "ux": "PASS", "ui": "CHANGES", "code": "PASS" } } ],
  "reworks": 0, "decision": null, "note": "", "brief": null, "issue": "M80",
  "startedAt": "2026-10-23T14:02:11.204Z",
  "stageEnteredAt": "2026-10-23T14:31:40.019Z",
  "endedAt": null,
  "updated": "2026-10-23T14:35:02.771Z",
  "timing": {
    "stages": [ { "stage": "spec", "round": 0, "enteredAt": "…", "exitedAt": "…", "ms": 184000 } ],
    "agents": [ { "role": "reviewer", "key": "security", "round": 2, "name": null,
                  "startedAt": "…", "finishedAt": null, "ms": null, "verdict": null } ]
  }
}
```

- `stageEnteredAt` — when the current stage began (drives the card's live timer).
- `endedAt` — the `job.merged` time, else `null`. Settled = `endedAt` older than
  `settleAfterHours`.
- `updated` — the last event's `ts`.
- `timing.stages[].exitedAt`/`ms` are `null` for the open stage; `timing.agents[].finishedAt`/`ms`
  are `null` while the agent runs. Viewers compute live elapsed time from the open timestamps.
- `history[]` entries may carry their own `timing` slice later; v1 keeps history verdict-only.

**Legacy jobs** (no `events.jsonl`, written before this contract) are left untouched. Viewers treat
them as having no timing and use `updated` as the merge time when `stage` is `merged`.

## CLI

```
bun factory/cli.ts event <id> <type> [field=value …]   # validate, append, rebuild job.json
bun factory/cli.ts rebuild <id> | --all                # regenerate job.json from the log
bun factory/cli.ts show <id>                           # human-readable timing summary
bun factory/cli.ts doctor                              # validate config.json, verify managed hashes
bun packages/cli/src/main.ts init [--force]            # (source only) install the managed core
bun packages/cli/src/main.ts upgrade [--force]         # (source only) replace the managed core
```

Alias: `bun run factory:event …` for `event`. Value parsing is fixed, not guessed: `round`, `maxRound`,
and `k` are integers (anything else is an error); `reviewers` is a JSON array; the literal `null`
is `null`; every other value stays a string (so `sha=3e45678` and `title=404` are never coerced). The CLI fills `job.claimed`'s `id`/`schema`
(and `maxRound` when omitted) and `round.started`'s `reviewers` when omitted from `config.json`. Exit 0 and print the new stage on success;
exit non-zero with a one-line reason on rejection.

`doctor` writes nothing. It runs every check and reports every finding, one line per check
(`ok`, `FAIL`, or `note`), rather than stopping at the first:

1. `config.json` is parsed with the same strict rules as above. A missing file, invalid JSON, or
   a rule violation (unknown key, reserved reviewer key, …) is a failure. Unlike the other
   commands, a bad `config.json` is a reported finding, not a rejection before the command runs.
2. If `managed.json` exists, it must be well-formed (see "Managed files"), and each listed file
   must exist with a matching SHA-256. A malformed manifest, a missing file, or a changed file is
   a failure, and each is reported by its path. No manifest is a `note` (unstamped install).

`doctor` exits 0 when nothing failed and 1 otherwise.

The CLI's source is `packages/cli` (entry `src/main.ts`, run from the repo root, which finds the
factory at `<cwd>/factory`). An installed copy that predates `doctor` gains it when the CLI is
promoted.

The installed `factory/cli.ts` is a single self-contained file (the source CLI bundled with its
contract code), so it runs with `bun` alone, with no workspace packages or `node_modules`. It
finds its factory root from its own location (its directory), and keeps the same commands
(`event`, `rebuild`, `show`, `doctor`), value parsing, per-command usage lines, and exit codes as
the source. The top-level usage line (printed for a missing or unknown command) differs: the
installed CLI prints the vendored
`usage: event <id> <type> [k=v …] | rebuild <id>|--all | show <id>`, and the source CLI prints
that line followed by ` | doctor | init [--force] | upgrade [--force]`.
The same source always bundles to the same bytes. It does not offer `init` or `upgrade`: those
run from the factory's source against a project, as `bun <factory repo>/packages/cli/src/main.ts
init` with the project root as the cwd.

### `init` and `upgrade`

The **managed files** are the Claude Code render of the skill and agents
(`.claude/skills/factory/{SKILL,explore}.md`, `.claude/agents/factory-<role>.md` for the fixed
roles and each configured reviewer key), the installed CLI `factory/cli.ts`, and the installed
contract `factory/CONTRACT.md`. Both commands plan every step before writing anything, so a
refusal writes nothing. They write each file to a temp file and rename it into place, and they
write `managed.json` last.

`init [--force]` installs the managed core into the project at the cwd:

- writes every managed file, then `factory/managed.json` listing exactly those files;
- if `factory/config.json` is absent, writes the default
  `{"schema":"factory/v1","reviewers":["code"],"maxRound":2,"dashboard":{"settleAfterHours":24}}`.
  An existing `config.json` is never rewritten, and it must parse with the strict rules above;
- appends any of `factory/jobs/`, `factory/.lock/`, `factory/.worktrees/` missing from the
  project's `.gitignore` (creating it if needed). A line already present, with or without a
  leading `/` or trailing `/`, is not added again.

- as its last step, after `managed.json` is written, registers the project's absolute root
  (symlinks resolved) in the Andon registry (see "Andon registry"). A root already listed is
  not added again. A registration failure (for example, an unwritable `ANDON_HOME` or an
  invalid registry file) does not fail `init`: it still exits 0 and prints one extra line,
  `note: not registered with Andon (<registry path>): <reason>`. A refused `init` registers
  nothing, and `upgrade` never registers.

`init` refuses when `factory/managed.json` exists (use `upgrade`), when a file with different
bytes already sits at a managed path (a file with the same bytes is fine), or when the existing
`config.json` is invalid.

`upgrade [--force]` needs `factory/managed.json` and a valid `config.json`. It re-renders for
the current config, writes the managed files whose bytes changed, deletes the files the old
manifest lists that the new render does not (such as a reviewer removed from `reviewers`), and
rewrites `managed.json`. It refuses when there is no manifest (use `init`), when `managed.json`
is malformed (see "Managed files"), when a file the manifest lists is missing or no longer
matches its hash (a local edit), when a path the new render adds already holds a different,
unmanaged file, or when `config.json` is missing or invalid.

Neither command ever writes or deletes the overlay (`config.json`, `roles/**`) or other state
under `factory/` (`managed.json` aside): `backlog.md`, `briefs/`, `jobs/`, `.lock/`,
`.worktrees/`. Files nobody manages are left alone, and upgrade deletes only paths the old
manifest lists. Every path they write or delete must be a valid manifest path (see "Managed
files") and, after symlinks, still resolve inside the project, the same rule `doctor` uses. A
manifest path that breaks this, or that names (or resolves through a symlink to) the overlay,
runtime state, or `.git/`, is refused.

`--force` overrides only the existing-file and edited-file refusals: `init --force` overwrites
files at managed paths (this is how an unstamped install is adopted), and `upgrade --force`
replaces edited or missing managed files and unmanaged files at new paths. It never overrides an
existing manifest on `init`, a missing manifest on `upgrade`, an invalid config, or a path
refusal. Any other argument is a usage error.

Both exit 0 on success and print one summary line (plus, for `init`, the registration `note:`
line when registering fails); on a refusal or usage error they exit 1 with
a one-line reason that names the offending paths.

Concurrency: a job's log has exactly one writer at a time — the session driving that job (or,
in `needs-human`, whoever runs approve/rework). The CLI enforces it with a per-job lock,
`jobs/<id>/.events.lock` (an `mkdir`; considered stale after 30 s), held across read → check →
append → project → write. Cross-job steps (claim, merge) stay under `factory/.lock` as before.

Log integrity: a log whose last line lacks `\n` (a torn write) is refused for appends as a corrupt
tail; an unparseable line is reported by its line number. Recovery is manual: a human truncates the
partial last line, then runs `bun factory/cli.ts rebuild <id>`; an orchestrator never edits the log.

## Dashboard endpoints

`GET /board` returns `{ jobs, config }` — every `job.json` plus the parsed `config.json`, read per
request. A bad `config.json` is a 500 carrying the reason, as is `GET /jobs/<id>/docs`.

## Andon registry

The machine registry lists the projects Andon watches. It is one file per machine,
`$ANDON_HOME/projects.json`, where `ANDON_HOME` defaults to `~/.andon`:

```json
{ "schema": "factory/v1", "projects": [{ "root": "/absolute/repo/root" }] }
```

`schema` must be `"factory/v1"`, and each `root` must be a normalized absolute path (no
trailing `/`, `.`, or `..` segment), listed at most once.
Unknown keys, at the top level or in a `projects` entry, are rejected with a one-line reason,
and nothing is written. A missing file is an empty registry. A write goes to a temp file beside
it and is renamed into place. Adding a root that is already listed, or removing one that is not,
changes nothing. `factory init` adds to it (see "`init` and `upgrade`"); a human may also edit it
by hand. The parse, add, and remove helpers are `packages/contract` (`registry.ts`).

## Andon agent

The Andon agent is one Bun daemon per machine (`bun run andon`, source
`packages/andon-agent`). It listens on `127.0.0.1` only, on `$ANDON_PORT` (default 8766), and
reads the registry at `$ANDON_HOME/projects.json`. It is a reader: it never writes job state.
A request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>`, or that carries an
`Origin` other than `http://` plus one of those, is a 403 (a guard against DNS rebinding).
Successful API responses are JSON (the UI routes below serve the UI's files); every response
carries `cache-control: no-store`. Every endpoint is `GET` (anything else is a 405):

- `GET /projects` returns `{ projects: [{ id, name, root }] }` in registry order. `id` is the
  first 12 hex characters of the SHA-256 of the absolute `root`, and `name` is the root's
  basename. A project whose `factory/` is missing is still listed.
- `GET /projects/<pid>/board` returns `{ jobs, config }` for that project, with the same shape
  and rules as the dashboard's `GET /board`: a `job.json` that is missing or mid-write keeps the
  job's last good snapshot, unknown `job.json` fields are passed through, and a bad
  `config.json` is a 500 whose text is `config.json: <reason>`.
- `GET /projects/<pid>/jobs/<id>/docs` returns `{ files: [{ path, text }] }`, with the same
  reading order, brief handling, and paths (relative to `factory/`) as the dashboard's
  `GET /jobs/<id>/docs`, except that it reads only regular files: a symlinked brief, file, or
  job directory is skipped. The job id is checked against `^\d{3}-[a-z0-9-]+$` before any path is
  built.
- `GET /` returns the Andon UI's `index.html`, and `GET /<path>` returns that file of the UI
  build (`apps/andon/dist`, built by `bun run andon:build`), read-only. The URL path is decoded,
  and it must resolve to a regular file inside the build directory both before and after
  symlinks are followed: a path that escapes it (by `..`, by an encoded `..` or `/`, or through a
  symlink), a directory, a malformed escape, or a missing file is a 404. With no build present,
  `GET /` is a 404. These routes are matched after the API routes above, so a build file never
  shadows an endpoint. They sit behind the same guards as every endpoint: the `Host`/`Origin`
  403, `GET` only (anything else is a 405), and `cache-control: no-store`. *(Added within v1,
  additively: before, `/` and asset paths were 404s; no other endpoint changed.)* A successful
  UI route response (`GET /`, `GET /<path>`) also carries this `Content-Security-Policy` header,
  exactly: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src
  'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` (one
  line; no `'unsafe-inline'` or `'unsafe-eval'`). Only successful UI route responses carry it:
  API responses, `/events`, and every 403, 405, and 404 are unchanged. *(Added within v1,
  additively: a new response header on the UI routes; no status, body, or other header changed.)*
- An unknown `<pid>`, a malformed job id, or any other path not served by the UI routes is a 404.
- `GET /events` is a `text/event-stream` of these events, each `data` one JSON line:
  - `projects`: `{ projects: [{ id, name, root }] }`, sent once on connect and again whenever
    the registry's list of projects changes.
  - `board`: `{ project: <pid>, jobs, config }`, sent when anything under a registered
    project's `factory/jobs/` or its `factory/config.json` changes. A burst of changes is
    debounced to one `board` event per project (at most about 100 ms of delay).
  - `error`: `{ project: <pid>, reason: "config.json: <reason>" }`, sent instead of `board` when
    that project's `config.json` is bad.

The agent finds changes with `fs.watch`, never by polling: one recursive watch on each project's
`factory/jobs/`, one non-recursive watch on its `factory/` (for `config.json`), and one on the
registry file's directory. It never watches or serves `factory/.worktrees/` or `factory/.lock/`.
An invalid registry edit keeps the current list.

## Versioning

These rules record how the code behaves today; they change no behavior.

- **`schema: "factory/v1"` names the major version.** Within v1, changes are additive only: new
  event types, new optional event fields, new config keys, and new snapshot fields. Within v1,
  nothing is removed or renamed, no field's type or meaning changes, and no allowed transition is
  tightened. Anything else needs `factory/v2`.
- **Same-diff doc updates.** Every contract change updates this doc (`docs/contract/v1.md`) in the
  same diff, and is reviewed by the contract reviewer (`factory-contract`).
- **The writer is strict.** The CLI rejects unknown event fields on input and unknown
  `config.json` keys (and unknown keys inside `roles` entries). Accepting a new `runner` value is
  an additive widening within v1.
- **Readers are tolerant.** Readers of `events.jsonl` and `job.json` (the projection, the
  dashboard, and Andon) ignore fields they don't know. A reader that meets an unknown event `type`
  leaves the snapshot as it was and does not fail (the projection still advances `updated` to that
  event's `ts`, since `updated` is always the last event's `ts`).
- **`config.json` is strict, so upgrade first.** A config that uses a newer v1 key needs a CLI that
  knows that key. Upgrade the managed files before adding the key to the overlay.
