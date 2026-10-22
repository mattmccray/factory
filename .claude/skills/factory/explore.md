# /factory explore — interview an idea into a brief

The factory's agents can't talk to the user, so the thinking that needs a human happens here,
before the line starts. You and the user reach a shared understanding of one feature. You
record it as a **brief**, and the brief binds the spec-writer and approver later. Spend
questions on decisions, not on facts.

## Start

- **Free text idea** → new brief. Slug: 2–4 kebab words.
- **`M##`** → read `bun run issues show <id>`. If its notes point at earlier thinking (a
  wayfinder ticket, a plan doc, a prototype), read that too. Decisions already made there are
  starting points to *confirm*, not questions to re-ask. Slug: `m##-<words>`.
- **An existing brief's slug** → resume it. Re-read it, summarize where it stands in a few
  lines, and pick up at its first open question.

Do your homework before the first question. Read `CLAUDE.md`, the relevant `docs/prd/*.md`, and
`DESIGN.md` + `docs/design/*.md` if the idea has a UI. Read the code it would touch. Anything you
can look up, look up.

## Interview

Follow the user's `grilling` discipline:
- Ask **one question at a time**, in prose. No multiple-choice menus.
- Give your **recommended answer** with each question, and the reason for it.
- Walk the decision tree in dependency order, settling the choices that decide other choices first.
- **Facts are yours to find; decisions are the user's.** Never ask what the code or docs can answer.

Minerva needs one extra pass, because these issues make the approver escalate after a whole
build. Raise each one as a question while it's still cheap to settle:
- PRD invariants (no save, unified documents, measures-as-numbers, media pool, local-first sync)
- the anti-scope list, the domain language, EXPORT_FORMAT, and the Dexie schema/migrations

When the idea collides with one of them, put it to the user plainly. The choices are narrowing
the idea, dropping that part, or amending the PRD (or EXPORT_FORMAT, or the schema). An
amendment the user chooses becomes a **PRD call** in the brief.

**Size check.** A brief is **one factory job**: one branch, one reviewable diff. If the idea is
bigger than that, propose splitting it into several briefs, in dependency order. Agree the
split with the user, then interview them one at a time.

## Write the brief as you go

Create `factory/briefs/<slug>.md` after the first answer, and update it after every decision.
That way an interrupted session can resume. While questions remain it says `Status: draft`.

```
# <Title>

- Status: draft | ready
- Issue: M## | —
- Sources: <earlier thinking you read, e.g. plans/wayfinder/…/3-….md> | —
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

## PRD calls
None. Otherwise list each one:
"<the deviation or schema/format change>", approved by the user on <date>. The job must update
`docs/prd/<doc>.md` §N (or EXPORT_FORMAT) to match.

## Open
None. A ready brief has none.
```

## Finish

1. Play the brief back to the user in a few lines and ask whether you've got it right. Don't
   mark it ready until they confirm.
2. Set `Status: ready`. Append a backlog line:
   `- [ ] <M##: >Title — <one line on what done looks like> — brief: factory/briefs/<slug>.md`
   Keep the `M##:` prefix when the brief came from an issue, so the merge closes that issue.
3. Commit the brief and the backlog line together by pathspec:
   `specs(factory): add brief <slug>` (+ the Co-Authored-By trailer).
4. Ask whether to run it now. If yes, continue as `/factory next <M## or the brief's title>`,
   which picks that line even if it isn't first.
