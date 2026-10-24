<!-- factory 0.1.0 · managed file, do not edit: it is replaced on upgrade. Project rules go in the overlay: factory/config.json and factory/roles/<role>.md -->
# /factory explore — interview an idea into a brief

The factory's agents can't talk to the user, so the thinking that needs a human happens here,
before the line starts. You and the user reach a shared understanding of one feature. You
record it as a **brief**, and the brief binds the spec-writer and approver later. Spend
questions on decisions, not on facts.

## Start

- **Free text idea** → new brief. Slug: 2–4 kebab words. If the idea points at earlier
  thinking (a backlog line, a design note, a plan doc), read that too. Decisions already made
  there are starting points to *confirm*, not questions to re-ask.
- **An existing brief's slug** → resume it. Re-read it, summarize where it stands in a few
  lines, and pick up at its first open question. If its `Status:` is `done`, don't reopen it,
  since a job already carried it out: name the job that carried it out (its `- Job:` line),
  and offer a new brief that lists the old one under `Sources:`.

Do your homework before the first question. Read the project's instructions (`CLAUDE.md` or
its equivalent) and any decision records or contracts they name as binding, and the project's
role rules under `factory/roles/` (the spec-writer's and approver's rules say what makes a job
escalate). Read the code it would touch. Anything you can look up, look up.

## Interview

Follow the user's `grilling` discipline:
- Ask **one question at a time**, in prose. No multiple-choice menus.
- Give your **recommended answer** with each question, and the reason for it.
- Walk the decision tree in dependency order, settling the choices that decide other choices first.
- **Facts are yours to find; decisions are the user's.** Never ask what the code or docs can answer.

Make one extra pass for the things that make the approver escalate after a whole build, and
raise each one as a question while it's still cheap to settle:
- a public interface, data format, or contract the project treats as fixed or versioned
- a binding decision the project has recorded, and anything it lists as deferred (anti-scope
  for now)
- an escalation trigger in the project's approver rules (`factory/roles/approver.md`, if it exists)

When the idea collides with one of them, put it to the user plainly. The choices are narrowing
the idea, dropping that part, or amending the contract (or a decision). An amendment the user
chooses becomes a **contract call** in the brief.

**Size check.** A brief is **one factory job**: one branch, one reviewable diff. If the idea is
bigger than that, propose splitting it into several briefs, in dependency order. Agree the
split with the user, then interview them one at a time.

## Write the brief as you go

Create `factory/briefs/<slug>.md` after the first answer, and update it after every decision.
That way an interrupted session can resume. While questions remain it says `Status: draft`.
Only the factory's Merge step writes the `- Job:` line, and sets `Status: done`, when the job
that carried the brief out merges. Never write either one here.

```
# <Title>

- Status: draft | ready | done
- Job: <id> (merged <short sha>, <YYYY-MM-DD>)   (written only at merge)
- Sources: <earlier thinking you read, e.g. a plan doc's path> | —
- Date: <YYYY-MM-DD>

## Intent
Two or three sentences in the user's terms: what changes for them, and why it matters.

## Decisions
1. <the question, short> → **<the answer>**. Why: <the user's reason, or the reason they accepted>.

## Scope
- In: …
- Out: … (what you explicitly agreed not to do)

## Acceptance sketch
Observable outcomes, in plain language. The spec-writer turns these into testable criteria.

## Contract calls
None. Otherwise list each one:
"<the contract change or decision amendment>", approved by the user on <date>. The job must
update the doc that records it (the brief names it) to match.

## Open
None. A ready brief has none.
```

## Finish

1. Play the brief back to the user in a few lines and ask whether you've got it right. Don't
   mark it ready until they confirm.
2. Set `Status: ready`. Append a backlog line:
   `- [ ] Title — <one line on what done looks like> — brief: factory/briefs/<slug>.md`
3. Commit the brief and the backlog line together by pathspec:
   `specs(factory): add brief <slug>` (+ the Co-Authored-By trailer).
4. Ask whether to run it now. If yes, continue as `/factory next <the brief's title>`,
   which picks that line even if it isn't first.
