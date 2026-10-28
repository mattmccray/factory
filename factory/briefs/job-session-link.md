# Record a job's orchestrator thread

- Status: done
- Job: 039-job-session-link (merged 051f6a8, 2026-10-28)
- Sources: brief `factory/briefs/t3-handoff.md` (job 036, `t3` lookup, prompt links); brief `factory/briefs/project-context-menu.md` (job 033, the native menu; it ruled out menus on job cells); `docs/contract/v1.md` (`job.claimed`); `docs/decisions.md` decision 9 (harnesses); T3 Code (Beta) desktop app, server 0.1.3: its link router (`packages/shared/src/promptLinks.ts` in the app bundle), `t3 thread list|show --json`, and the T3 Code MCP tools (`t3_environment_read`, `t3_thread_search`), checked 2026-10-28
- Date: 2026-10-28

## Intent
Matt runs `/factory` jobs from T3 Code threads. Each job should record which T3 Code thread is
orchestrating it, so Andon can later offer "Open in T3 Code" on a job and bring that thread
forward in one click (brief `job-context-menu`, which runs after this one). This brief is the
capture half: the contract, the CLI, and the skill.

## Findings (facts, 2026-10-28)
- T3 Code opens a thread from `t3code://threads/<environmentId>/<threadId>` (its link router
  maps it to the thread's route). The environment id comes from `t3_environment_read`.
- A Claude Code session started by T3 Code gets no thread id in its environment; it sees only
  `CLAUDE_CODE_SESSION_ID`, which T3 Code doesn't record on the thread (`t3 thread show --json`).
- A session can find its own thread: `t3_thread_search` for a unique phrase it just wrote
  returns exactly its thread.
- `job.claimed` carries `brief`, `issue`, `maxRound`, and `target` today; a new optional field is
  additive within v1.

## Decisions
1. Where does a job's link to its thread come from? → **Recorded when the job is claimed, as a
   new optional field on `job.claimed`, which the CLI derives into `job.json` for Andon. The
   `/factory` skill fills it: when T3 Code's tools are present, it finds its own thread (a unique
   phrase, then `t3_thread_search`) and passes the link to `claim`. Without T3 Code the field is
   absent and Andon's menu item is grayed out. Matt asks T3 Code's developer for a
   `T3CODE_THREAD_ID`-style variable so the search step can be retired later.** Why: Andon
   searching T3 Code at click time is ambiguous (other threads mention the job id) and the `t3`
   CLI has no search; waiting on T3 Code would park the idea.
2. What is recorded? → **Ids, never a link: an optional `session: { app: "t3code",
   environment: "<environmentId>", thread: "<threadId>" }` on `job.claimed`, passed as
   `claim … session=t3code:<environmentId>/<threadId>`. The CLI accepts only the app `t3code`
   and ids of letters, digits, and `-` (1–64 characters each), and otherwise refuses the claim
   with a one-line reason, as for a bad slug. Andon builds the `t3code://threads/…` link
   itself.** Why: Andon never opens a URL read from job state, so a bad value can't send it
   anywhere else; the `app` key leaves room for other harnesses (decision 9) without another
   contract change.
3. Which thread after `/factory approve` or `rework` from another thread? → **The latest:
   `job.reworked` and `job.human-approved` take the same optional `session`, and `job.json`'s
   `session` is the most recent one recorded. A rework or approve from outside T3 Code keeps the
   earlier link. `job.abandoned` takes none (an abandoned job leaves the board).** Why: the
   thread that runs a rework becomes the job's orchestrator, so the menu should open it; an old
   link still beats none, since that thread holds the job's history.
4. One job or two? → **Two briefs, in order: this one (`job-session-link`: contract, CLI, the
   skill template's discovery step, `docs/contract/v1.md`), then `job-context-menu` (Andon's
   right-click menu on job cells with "Open in T3 Code"). The Andon service passes `job.json`
   through unchanged.** Why: one reviewable diff per job; this one changes the versioned
   contract and the managed skill (the contract reviewer's), the other runs a program from
   Andon (the security reviewer's); and this one is useful alone, since jobs start recording
   their thread at once.
5. What if the skill can't find its thread? → **Best effort, never blocking: it writes a unique
   phrase (`factory session <random>`), searches for it with `t3_thread_search`, and retries
   once after a couple of seconds if nothing comes back. It passes `session` only when exactly
   one thread matches. With no match, several, or no T3 Code tools, it claims (or reworks, or
   approves) without `session` and tells the user in one line ("couldn't find this T3 Code
   thread; the job won't link to it").** Why: the link is a convenience and must never stand
   in the job's way; T3 Code's search isn't exhaustive, may lag a fresh message, and skips
   subagent threads.

## Scope
- In: `packages/contract` (or wherever `job.claimed`, `job.reworked`, and `job.human-approved`
  are validated): an optional `session` field on those three events, checked as decision 2
  says; `job.json`'s `session` derived as the most recent one recorded (absent or `null` when
  none was ever recorded); the checks are pure and `bun:test`-covered.
- In: the CLI: `claim … session=t3code:<environmentId>/<threadId>` and the same `session=`
  argument on `event <id> job.reworked …` and `job.human-approved`, refused with a one-line
  reason and nothing written when malformed; refused on any other event.
- In: the `/factory` skill template (under `packages/templates`): the discovery step of
  decision 5 before `claim`, `job.reworked`, and `job.human-approved`, only when T3 Code's
  tools (`t3_environment_read`, `t3_thread_search`) are present; render tests pin it.
- In: `docs/contract/v1.md`: the new field on the three events and on the `job.json` snapshot,
  and a changelog entry, as an additive change within v1.
- Out: anything in Andon (brief `job-context-menu`); `session` on `job.abandoned` or any other
  event; recording Claude Code's own session id; any harness but T3 Code; reading T3 Code's
  databases; changes under `.claude/` or `factory/` (promotion is the human's `factory
  upgrade` after merge).

## Acceptance sketch
- A job claimed from a T3 Code thread has `session: { app: "t3code", environment, thread }` in
  its `job.json`, matching that thread (`manual` in T3 Code; the CLI side by tests).
- `claim` with a malformed `session=` (another app, an empty or too-long id, a `/` or other
  character outside letters, digits, and `-`) is refused with a one-line reason and claims
  nothing.
- After `job.reworked` or `job.human-approved` with a `session`, `job.json` shows that newer
  one; without one, the earlier link stays.
- `session=` on any other event is refused; logs without any `session` stay valid v1 and derive
  as before.
- The rendered skill has the discovery step, records nothing on no match or several, says so in
  one line, and never stops the job over it.
- `docs/contract/v1.md` documents the field, the checks, latest-wins, and the changelog entry.
- The gate passes.

## Contract calls
- "`factory/v1` gains an optional `session` (`{ app: "t3code", environment, thread }`) on
  `job.claimed`, `job.reworked`, and `job.human-approved`, and on the `job.json` snapshot as
  the most recent one recorded; additive within v1", approved by Matt on 2026-10-28. The job
  updates `docs/contract/v1.md` to match.

## Open
None.
