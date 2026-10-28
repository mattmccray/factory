# Hand needs-human commands to T3 Code

- Status: done
- Job: 036-t3-handoff (merged 97563fc, 2026-10-28)
- Sources: Matt's nitpicks (2026-10-28), item 4 and the follow-up on settings and auto-send; briefs `factory/briefs/andon-settings.md` (runs first), `factory/briefs/project-context-menu.md` (finding `t3`); `docs/design/andon-overview/design.md` §8 ("Andon never runs these"); T3 Code (Beta) desktop app's prompt links (`t3code://new?prompt=…&repo=<owner>/<name>[&provider=…&model=…]`, prompt ≤ 8,000 characters) and `t3 thread start <project> <message>` (sends at once)
- Date: 2026-10-28

## Intent
When a job stops at Andon, the needs-human box already builds the exact `/factory approve`,
`rework`, or `abandon` command, but only copies it. With T3 Code installed, one click should
open T3 Code on that job's project with the command ready in a new thread (or, if Matt chooses
in Settings, sent straight away), so handling an escalation never leaves Andon for a terminal.
It's also the groundwork for starting jobs from Andon later.

## Decisions
1. How does this fit with the rest of Matt's list? → **Brief C2 of four, run in order: A
   `andon-polish`, C1 `andon-settings`, C2 (this one), B the minimized-window icon. It adds a
   T3 Code section to C1's Settings window.** Why: C2 is the part that runs a program, so the
   security reviewer judges it on its own.
2. May Andon hand a command to something that runs it? → **Yes: amend the accepted design's §8
   (decision 5) from "Andon never runs these." to: "Andon never runs these itself. In the Mac
   app, when T3 Code is installed, it can also hand one to T3 Code: as an unsent draft in a new
   thread (the default), or, if chosen in Settings, sent to a new thread right away. Andon still
   writes no job state; the factory CLI does."** Why: pre-fill keeps a person pressing send;
   send-right-away is Matt's explicit choice in Settings, never the default. Andon stays
   read-only toward job state (decision 10).
3. Does a prompt link really pre-fill? → **Yes, tested 2026-10-28 with T3 Code (Beta):
   `open 't3code://new?prompt=…&repo=mattmccray/factory'` opened a new thread in the factory
   project with the text as an unsent draft, asking nothing first.** Why: settles the draft path
   as a fact before building on it.
4. What do the buttons do? → **A T3 Code section in Settings decides what the needs-human box's
   Approve, Rework, and Abandon do: "Open a draft in T3 Code" (the default when the Mac app finds
   `t3`, by the context menu's lookup: `~/.t3/bin/t3`, then `/opt/homebrew/bin/t3`), "Send in
   T3 Code right away", or "Copy only". Every choice also copies the command to the clipboard;
   the toast says what happened ("Opened a draft in T3 Code", "Sent to T3 Code", or "Copied …"
   as today). Without `t3`, and in a plain browser, the buttons copy only, as now; the Settings
   section says T3 Code wasn't found and grays the choices out. The small copy icon beside the
   command always only copies.** Why: no extra buttons in a small box; the clipboard is always a
   fallback; nothing changes where T3 Code isn't available.
5. How does T3 Code find the job's project? → **Draft: the backend reads the project root's
   `origin` remote with git and, when it's a github.com URL (https or ssh), passes
   `repo=<owner>/<name>` in the prompt link; with no GitHub origin the click copies only, and
   the toast says why ("No GitHub remote; copied …"). Never a link without `repo`. Send: the
   backend runs `t3 thread start <root> <command>` with the root it already looks up for the
   context menu; if T3 Code doesn't know the project or isn't running, a notification says
   "Couldn't send to T3 Code: …" and the command is still on the clipboard.** Why: prompt links
   name a project only by GitHub repo, while `t3 thread start` takes a path; a link without
   `repo` would draft into whatever project T3 Code has open, too risky for a merge command.
6. What may the page send? → **Never a command or a prompt. Through one new named backend
   method, answered only for the main window, the page sends a project id, a job id, an action
   (`approve` | `rework` | `abandon`), and for rework and abandon the typed note or reason. The
   backend checks that the project id is in its `/projects` list, the job id has the factory id
   form (three digits, a slug), the action is one of the three, and a note is non-empty for
   rework and abandon and short enough that the command stays within T3 Code's 8,000-character
   prompt limit; then it builds the `/factory …` command itself, quoting the note exactly as the
   Andon UI does today (a test pins that both agree). Anything failing a check does nothing. It
   doesn't check the job's stage: it doesn't follow jobs, and the commands themselves refuse a
   job that isn't in needs-human. A sent thread is titled with the action and job (e.g. "approve
   033-project-context-menu"), runs in the project folder (where `/factory` merges from), and
   uses T3 Code's defaults for the project's provider and model. The checks and the command
   building are a pure, `bun:test`-covered module; the API gate grows by exactly this one method
   on top of C1's two (pinned).** Why: the context menu's rule (the page names things, the
   backend decides); send mode starts an agent that may run with full access, so no
   page-supplied text becomes a prompt beyond the human's own note.

## Scope
- In: `apps/andon`: the hand-off method (decision 6) and its pure module; the `origin` → GitHub
  `owner/name` lookup; opening the prompt link (draft) or running `t3 thread start` (send);
  failure notifications; the T3 Code setting's key added to C1's settings (values: draft, send,
  copy), defaulting to draft; whether `t3` was found, for the Settings page; the API gate widened
  by exactly one method.
- In: `apps/andon-ui`: Settings' T3 Code section (the three choices, grayed out with a "T3 Code
  wasn't found" line when it's missing); the needs-human box's Approve and the Rework… and
  Abandon… sheets' buttons doing the chosen hand-off in the Mac app, always also copying, with
  the toasts of decision 4; a plain browser unchanged (copy only).
- In: `docs/design/andon-overview/design.md` §8 amended as the contract call says, and the code
  comments that say the buttons only copy.
- Out: starting jobs from Andon (a later exploration, which this lays groundwork for); linking a
  job to its T3 thread; choosing a provider, model, or worktree for a sent thread; drafts for
  projects without a GitHub origin; any service or `factory/v1` contract change.

## Acceptance sketch
- In the Mac app with `t3` installed, Settings shows a T3 Code section set to "Open a draft in T3
  Code"; without `t3` it says T3 Code wasn't found and the choices are grayed out (`manual`).
- With "Open a draft": clicking Approve on a needs-human job of a project whose origin is on
  GitHub opens T3 Code on that project with `/factory approve <id>` as an unsent draft in a new
  thread, copies it, and toasts "Opened a draft in T3 Code" (`manual`); Rework… and Abandon…
  do the same with their note or reason.
- For a project with no GitHub origin, the click copies only and the toast says why.
- With "Send in T3 Code right away": the click starts a new T3 thread titled "approve <id>" in
  the project folder with the command sent, and copies it (`manual`); if T3 Code isn't running
  or doesn't know the project, a "Couldn't send to T3 Code: …" notification shows.
- With "Copy only", and in a plain browser, the buttons copy as today.
- The page can't supply a command or prompt: an unknown project, a malformed job id, an unknown
  action, an empty or too-long note, or a call from another window does nothing; the built
  command matches the UI's for the same input (tests pin all of it).
- The API gate allows exactly one more method than after `andon-settings` (pinned).
- Design §8 reads as amended.
- The gate passes.

## Contract calls
- "`docs/design/andon-overview/design.md` §8: 'Andon never runs these.' becomes 'Andon never
  runs these itself. In the Mac app, when T3 Code is installed, it can also hand one to T3 Code:
  as an unsent draft in a new thread (the default), or, if chosen in Settings, sent to a new
  thread right away. Andon still writes no job state; the factory CLI does.'", approved by Matt
  on 2026-10-28. The job updates §8 of the design doc to match, and the code comments that say
  the buttons only copy.

## Open
None.
