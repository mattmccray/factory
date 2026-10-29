# Settled jobs on demand — the Andon service sends settled jobs only when asked

- Status: done
- Job: 049-settled-on-demand (merged a24b88d, 2026-10-29)
- Sources: `/factory explore job-archive` on 2026-10-28 (performance discussion);
  packages/andon-service/src/index.ts (`board`, `emitBoard`, SSE `board` events);
  docs/contract/v1.md ("Dashboard endpoints", "Andon service", "Archived jobs");
  apps/andon-ui/src/board.ts, lanes.ts, find.ts, Lane.svelte, api.ts, live.ts;
  docs/design/andon-overview/design.md (§6 lanes, §7 focus, §9 Settled);
  factory/briefs/job-archive.md (decision 10); `/factory explore settled-on-demand` on 2026-10-29
- Date: 2026-10-28 (interviewed 2026-10-29)

## Intent
Every `board` event the Andon service pushes carries the project's whole job list, settled jobs
included, and that list only grows now that the job archive feeds old jobs back in. This job
lets a reader ask for a narrow board instead: unsettled jobs plus a small settled summary, with
the settled jobs served by a new endpoint on request. Existing readers see no change. The UI
opts in later, in its own job (factory/briefs/settled-on-demand-ui.md).

## Facts (checked 2026-10-28/29)
- A push is per project: a change in one project rebuilds and sends only that project's board,
  debounced to one `board` event per burst (50 ms).
- This repo's board is 48 jobs, about 149 KB per push (2026-10-29), and a running job causes
  roughly 20–30 pushes. All but a handful of those jobs are settled.
- The only reader of the Andon service's endpoints is the Andon UI (`apps/andon-ui/src/api.ts`,
  `live.ts`). The dashboard's `GET /board` (`factory/serve.ts`) is a separate endpoint and is not
  touched.
- "Settled" is time-based for merged jobs (`endedAt` older than `settleAfterHours`): a merged job
  becomes settled with no file change, so no watch fires when it crosses the line.
- Archived-only jobs (pruned locally) are already in `board`, with `endedAt` (checked: 001–022
  all carry it).

## Decisions
1. How readers get the narrow board → **Opt-in, so it stays additive within v1:
   `GET /events?settled=summary` and `GET /projects/<pid>/board?settled=summary` carry only
   unsettled jobs plus a per-project settled summary; without the parameter both behave exactly
   as today (every job). Only the exact value `summary` opts in. Plain and narrow `/events`
   clients can be connected at once, and each gets its own form.** *Confirmed by Matt on
   2026-10-29.* Why: dropping settled jobs from the existing `board` for every reader is a
   non-additive v1 change the approver escalates; the opt-in costs one branch in the service and
   needs no contract amendment.
2. The settled summary → **`settled: { count, lastMergedAt }` per project, nothing else.
   `count` is settled merged jobs plus abandoned jobs (the UI's lane and toolbar count);
   `lastMergedAt` is the newest `endedAt` among settled merged jobs, or `null` (abandoned jobs
   never count as a merge).** A narrow `board` response is `{ jobs, config, settled }` and a
   narrow `board` event `{ project, jobs, config, settled }`. *Confirmed by Matt on 2026-10-29.*
   Why: those are the only two things the board shows about settled jobs (lanes.ts, board.ts),
   and a fixed-size summary keeps the push small however long the history gets.
3. Who decides "settled" → **The service, by the contract's existing rule (`abandoned` at once,
   `merged` when `endedAt` is older than `dashboard.settleAfterHours`) on the system clock when
   it builds a narrow board, plus one timer per project while any narrow `/events` client is
   connected, armed for the moment its next unsettled merged job crosses the line; it fires a
   fresh `board` event and is re-armed after each build (a `settleAfterHours` edit re-arms it
   through the normal `config.json` rebuild).** *Confirmed by Matt on 2026-10-29.* Why: a merged
   job settles with no file change, so without the timer it would stay on the narrow board (and
   out of the count) until an unrelated event; scheduled refetching would be polling, which the
   service contract rules out ("never by polling").
4. The settled endpoint → **`GET /projects/<pid>/settled` returns `{ jobs }`: that project's
   settled jobs only, by the same rule, in the same shape and under the same `job.json` rules as
   `board` (last good snapshot, unknown fields passed through, archived-only jobs included),
   sorted by id. A bad `config.json` is a 500 whose text is `config.json: <reason>`, as for
   `board`. Same guards as every endpoint (Host/Origin 403, `GET` only, `cache-control:
   no-store`); an unknown `<pid>` is a 404. No single-job endpoint.** *Confirmed by Matt on
   2026-10-29.* Why: the UI fetches one project's list when a history view opens; a single-job
   route would add a second contract surface to save a few KB per click.

## Scope
- In: the `?settled=summary` opt-in on `GET /events` and `GET /projects/<pid>/board`; the
  settled summary; the per-project settle timer; `GET /projects/<pid>/settled`; tests in
  `packages/andon-service`; the "Andon service" section of `docs/contract/v1.md`, each addition
  marked *(Added within v1, additively)*.
- Out: any change to the Andon UI (factory/briefs/settled-on-demand-ui.md does that); any change
  to the plain (no-parameter) `board` endpoint or event; the dashboard's `GET /board` in
  `factory/serve.ts`; a single-job endpoint; paging or searching settled jobs; the CLI and the
  job archive.

## Acceptance sketch
- Without the parameter, `GET /projects/<pid>/board` and `board` events are unchanged: every
  existing service test passes untouched.
- `GET /projects/<pid>/board?settled=summary` returns only unsettled jobs (working, needs-human,
  recently merged) plus `settled: { count, lastMergedAt }`, correct for a mix of old merged,
  recent merged, abandoned, and archived-only jobs; with no settled jobs it is
  `{ count: 0, lastMergedAt: null }`.
- A client on `/events?settled=summary` gets narrow `board` events while a plain client
  connected at the same time gets full ones, for the same change.
- A merged job that crosses `settleAfterHours` with no file change produces a narrow `board`
  event shortly after the crossing: the job is gone from `jobs`, `count` went up by one, and
  `lastMergedAt` is its `endedAt`. With no narrow client connected, no timer is armed.
- `GET /projects/<pid>/settled` returns exactly the jobs the narrow board left out, sorted by
  id, archived-only ones included; a bad `config.json` is a 500 `config.json: <reason>`, an
  unknown pid a 404, a non-GET a 405, a bad Host or Origin a 403.
- For this repo, a narrow push is a few unsettled jobs instead of about 149 KB.
- `docs/contract/v1.md` documents the parameter, the summary, the timer, and the endpoint.

## Contract calls
None. Every change is additive within v1 (decision 1); the job documents it in
docs/contract/v1.md "Andon service" in the same diff.

## Open
None.
