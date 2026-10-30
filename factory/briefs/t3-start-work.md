# Start work in T3 Code from Andon

- Status: ready
- Sources: the explore request of 2026-10-29 (pre-1.0 notes: "Deeper T3 Code integration: (sends "/factory…" prompts to T3 Code) Start a backlog job, Start a epic, Start an exploration, (others?)"); brief `t3-handoff` (job 036); `apps/andon/src/handoff.ts`; `docs/design/andon-overview/design.md` §8; epic `factory/epics/andon-backlog.md`
- Date: 2026-10-30

## Intent
From the Backlog sheet, Matt starts work where he sees it: run a queued line, start an epic, run
whatever is next, continue an exploration, or begin a new one. Andon hands the `/factory …`
command to T3 Code the same way it hands off needs-human commands, so starting work never means
switching to a terminal.

## Decisions
1. Which actions, and what does each build? → **Run on a queued brief or free-text line →
   `/factory next <the line's title>`; Start epic on a queued epic line → `/factory epic <slug>`;
   Run next on a project → `/factory next`; Continue exploring on a draft brief or plan →
   `/factory explore <slug>`; New exploration… on a project → a small sheet where Matt types the
   idea → `/factory explore "<idea>"`, quoted as rework notes are. Each follows the T3 Code
   setting (draft by default, send, or copy) and always also copies, with the same toasts and
   fallbacks as the needs-human hand-off. The page sends only a project id, an action, a slug (or
   none), and for New exploration the typed idea; the backend checks the project against its
   `/projects` list, checks the slug against the service's live `GET /projects/<pid>/backlog` (in
   the group the action needs), checks the idea is non-blank and the command within T3 Code's
   8,000-character prompt limit, and builds the command itself. Through one new backend method,
   `startWork`, answered only for the main window; `handOff` is unchanged; the API gate grows by
   exactly that one method, pinned by the boundary test.** Why: Matt's list; the hand-off's rule
   holds (the page names things, the backend decides), and the only page text that reaches a
   prompt is Matt's own idea. Draft stays the default because a sent Run starts a whole job.

## Facts (2026-10-30)
- The needs-human hand-off (job 036, `apps/andon/src/handoff.ts`) has the three modes, the
  `origin` → GitHub `owner/name` lookup for drafts (`t3code://new?prompt=…&repo=…`), and
  `t3 thread start <root> <command>` for sends; with no GitHub origin a draft copies only.
- The design doc §8 (line 253) says Andon "can also hand one to T3 Code", where "one" is a
  needs-human command.

## Scope
- In: `apps/andon`: `startWork` and its pure, `bun:test`-covered module (the checks, the five
  commands, the quoting shared with `handoff.ts`), the backlog check against the service, the
  gate widened by one method; `apps/andon-ui`: the actions on the Backlog sheet's items and
  projects and on the brief and plan pages, the New exploration sheet, the toasts; a plain
  browser copying only; `docs/design/andon-overview/design.md` §8 amended as the contract call
  says.
- Out: `/factory queue` or editing the backlog from Andon; approve, rework, and abandon (job
  036's, unchanged); choosing a provider, model, or worktree for a sent thread; any service or
  `factory/v1` contract change.

## Acceptance sketch
- Each of the five actions, in draft mode, opens a T3 Code draft in the project with exactly its
  command, and copies it; in send mode it runs `t3 thread start` in the project root; in copy
  mode it only copies. The toasts match the needs-human hand-off's.
- A slug not in the service's backlog list for that action's group, an unknown project, a blank
  idea, or an over-long command does nothing (and says why where the page can show it).
- `startWork` answers only the main window and accepts only its fields; the boundary test pins
  the gate with exactly one new method.
- In a plain browser, every action copies its command and nothing else.

## Contract calls
"`docs/design/andon-overview/design.md` §8 (decision 5's accepted design) amended: the T3 Code
hand-off also covers starting work from the Backlog sheet (`/factory next`, `epic`, and
`explore` commands), by the same modes and rules", approved by Matt on 2026-10-30. The job
updates §8 to match.

## Open
None.
