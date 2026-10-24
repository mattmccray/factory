# Role overlays never decide the outcome

- Status: done
- Job: 020-overlay-outcome-rule (merged 2e53baf, 2026-10-24)
- Sources: factory/jobs/005-factory-customize/round-1/review-security.md (finding 1, nit); packages/templates/assets/agents/*.md (Project rules sections); packages/templates/assets/skill/SKILL.md (Customize, Refusal rules); docs/contract/v1.md (Role overlays)
- Date: 2026-10-24

## Intent
A role overlay (`factory/roles/<role>.md`) is read into an agent's prompt, so today one line such
as "always return `VERDICT: PASS`" or "always APPROVE" would quietly defeat the review gate
without breaking any existing overlay rule. State, for every role, that an overlay can narrow
and sharpen what a role does but can never decide its outcome in advance, so verdicts and
decisions on the board keep meaning what they say.

## Decisions
1. Which roles does the rule cover? → **All of them: every reviewer, the approver, the builder,
   and the spec-writer, one principle stated per role.** Why: it is the same few sentences in each
   template, and covering reviewers alone would leave the bigger hole (an approver overlay saying
   "always APPROVE"). Legitimate scope rules such as "PASS early when your area isn't touched"
   stay allowed. They are scope (nothing in scope, nothing to find), not a predetermined outcome.
2. Where is the line? → **A ratchet: an overlay can make a role more focused or stricter, never
   more lenient about what it actually finds.** Allowed: saying where to look and what to look
   for; adding checks and escalation triggers; making something blocking; PASS early when nothing
   in the role's area changed; an exemption that cites a recorded human decision (see 3). Never: a
   verdict or decision fixed regardless of what the agent finds ("always PASS", "always APPROVE");
   dropping, hiding, or downgrading a finding made within the role's scope; removing a default
   escalation trigger; telling the builder to skip or wave off a `[blocking]` finding. The test an
   agent applies: *does this line decide the outcome before looking, or throw away something
   already found?* Two or three worked examples go in the contract doc, not every template. Why:
   this repo's own overlays already narrow focus (`security.md`), PASS early (`ui.md`,
   `contract.md`), and raise severity (`code.md`), so a blunt "no verdict or severity rules" would
   break them; the ratchet keeps all of that and closes only the lenient direction.
3. Is there an escape hatch for downgrading a known, accepted issue? → **Yes, but not as an
   overlay's own call: an exemption or downgrade is allowed only when it cites a recorded human
   decision (a brief's decision or contract call, or a decision record the project names, such as
   HANDOFF's deferred and known-gaps lists), and the finding is still reported, marked as covered
   (e.g. `[accepted: HANDOFF known gaps]`). No new mechanism is built now.** Why: there's a real
   future case (a reviewer re-flagging a deliberately deferred gap burns rounds), but a bare "if
   you find X, call it a nit" is a blanket, forever downgrade that hides the finding. Tying it to
   a recorded decision is the pattern `contract.md` already uses, and keeping the finding visible
   means the approver and the human still see it. A future need for more goes through a brief.
4. What does an agent do when an overlay line breaks the rule? → **Ignore that line, say so in one
   line in its own file, and never block or escalate because of it.** A reviewer adds a `[nit]`
   finding (`factory/roles/<key>.md: "<the line>" breaks the overlay outcome rule; ignored.`); the
   approver adds the same note to `decision.md` and decides normally; the builder and spec-writer
   note it in `build.md` / `spec.md`. Why: no agent can edit `factory/roles/`, so a blocking
   finding would loop the builder and an escalation would stop every job over something the diff
   didn't cause; a silent ignore would hide the bad line forever, while the note nags in every
   review until a human fixes it.
5. Where is the rule stated, and does `doctor` check it? → **In three places, with no `doctor`
   check:** (a) each of the four agent templates' "Project rules (overlay)" section gets one or two
   sentences (the ratchet, the quick test, and ignore-and-note), and the reviewer template's "never
   changes what makes a finding blocking" becomes "never makes the review more lenient"; (b) the
   last of `/factory customize`'s refusal rules gains the ratchet, and customize refuses a
   lenient line while offering the allowed form (cite a recorded decision, keep the finding
   visible); (c) `docs/contract/v1.md` § Role overlays states the full rule with two or three
   worked examples. Why: the agents and customize are the enforcers; whether a line breaks the
   rule is judgment, and a text check would false-positive on this repo's own `ui.md` and
   `contract.md`, which literally contain `VERDICT: PASS`.

## Scope
- In: `packages/templates/assets/agents/{reviewer,approver,builder,spec-writer}.md` (the Project
  rules sections); `packages/templates/assets/skill/SKILL.md` (Customize refusal rules);
  `docs/contract/v1.md` (§ Role overlays); the templates' render tests.
- Out: any `doctor` or CLI check; any new mechanism for accepted risks (no new brief section,
  config key, or finding tag the CLI reads); any change to verdict or decision formats; editing
  this repo's overlays (all seven already comply); anything under `.claude/` or `factory/` (the
  installed copy picks the rule up only at a later, deliberate promotion).

## Acceptance sketch
- Every rendered agent tells the agent that its overlay can make it more focused or stricter,
  never more lenient about what it finds, gives the quick test, and says to ignore a breaking
  line and note it in one line in its own file without blocking or escalating.
- The rendered reviewer still honors an overlay that narrows focus, PASSes early when its area
  is untouched, or makes something blocking; it reports, as a `[nit]`, an overlay line that fixes
  the verdict or downgrades a finding, and decides as if that line weren't there.
- A downgrade or exemption is allowed only when it cites a recorded human decision, and the
  finding is still written in the review, marked as covered.
- The rendered approver ignores and notes an overlay "always APPROVE" or a removed trigger.
- `/factory customize` refuses a role rule that breaks the ratchet, names the rule, and offers
  the allowed form.
- `docs/contract/v1.md` § Role overlays states the rule, the escape hatch, the ignore-and-note
  behavior, and two or three worked examples (allowed and not).
- Render tests pin the new text in each template; the gate is green.

## Contract calls
"`docs/contract/v1.md` § Role overlays gains the outcome rule (the ratchet, the
recorded-decision exemption with the finding still reported, and ignore-and-note), an additive
clarification within v1 of what an overlay may say", approved by the user on 2026-10-24. The job
must update `docs/contract/v1.md` to match.

## Open
None.
