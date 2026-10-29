// The settle rule, as the contract states it (docs/contract/v1.md "`config.json`",
// `dashboard.settleAfterHours`) and `packages/cli/src/prune.ts` applies it: an `abandoned` job is
// settled at once; a `merged` job is settled when its `endedAt` parses and lies more than
// `settleAfterHours` before `now`. A merged job with no readable `endedAt`, and every other stage,
// is unsettled. The service carries its own copy (it does not import the CLI). Pure functions over
// board jobs (`job.json` records, read tolerantly), unit-testable with a fixed `now`.

type Job = Record<string, unknown>;

/** A project's settled summary on a narrow board (`?settled=summary`). */
export interface SettledSummary {
  count: number; // settled merged jobs plus abandoned jobs
  lastMergedAt: string | null; // the newest `endedAt` among settled merged jobs; abandoned never counts
}

const HOUR_MS = 3_600_000;

/** The longest delay `setTimeout` accepts (2^31 - 1 ms); a longer one fires at once. */
export const MAX_DELAY_MS = 2_147_483_647;

// A merged job's `endedAt` in ms, or null when it is not merged or has no readable `endedAt`.
function mergedAt(job: Job): number | null {
  if (job.stage !== 'merged' || typeof job.endedAt !== 'string') return null;
  const ended = Date.parse(job.endedAt);
  return Number.isNaN(ended) ? null : ended;
}

/** Whether a board job is settled at `now` (ms since the epoch). */
export function isSettled(job: Job, hours: number, now: number): boolean {
  if (job.stage === 'abandoned') return true;
  const ended = mergedAt(job);
  return ended !== null && now - ended > hours * HOUR_MS;
}

/** Splits board jobs into unsettled and settled, each keeping the input's (id) order. */
export function partition(jobs: readonly Job[], hours: number, now: number): { unsettled: Job[]; settled: Job[] } {
  const unsettled: Job[] = [];
  const settled: Job[] = [];
  for (const job of jobs) (isSettled(job, hours, now) ? settled : unsettled).push(job);
  return { unsettled, settled };
}

/** The summary of a list of settled jobs. */
export function summarize(settled: readonly Job[]): SettledSummary {
  let last: { at: number; text: string } | null = null;
  for (const job of settled) {
    const at = mergedAt(job);
    if (at !== null && typeof job.endedAt === 'string' && (last === null || at > last.at)) last = { at, text: job.endedAt };
  }
  return { count: settled.length, lastMergedAt: last === null ? null : last.text };
}

/**
 * The delay, in ms from `now`, until the next unsettled merged job in `jobs` becomes settled, or
 * null when none will (no merged job with a readable `endedAt` is still unsettled). The delay is
 * not clamped: callers clamp it to MAX_DELAY_MS.
 */
export function nextSettle(jobs: readonly Job[], hours: number, now: number): number | null {
  let next: number | null = null;
  for (const job of jobs) {
    const ended = mergedAt(job);
    if (ended === null || isSettled(job, hours, now)) continue;
    // Settled once `now - ended > hours`: the first whole millisecond past the line.
    const delay = Math.max(0, Math.floor(ended + hours * HOUR_MS - now) + 1);
    if (next === null || delay < next) next = delay;
  }
  return next;
}
