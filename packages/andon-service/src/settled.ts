// "Settled", as the service applies it: the contract's epic-aware settle rule (docs/contract/v1.md
// "`config.json`", `dashboard.settleAfterHours`, "The epic-aware settle rule"), imported from
// `@factory/contract` (`isSettled`, `isEpicSettled`), never copied here. An epic settles like a job
// (`landed`: once its `endedAt` is more than `settleAfterHours` old; `abandoned`: at once); a job
// with no `epic` settles as it always has; a job with an `epic` settles with its epic, never on its
// own, and an epic the board doesn't hold counts as unknown (so not terminal); an `abandoned` job
// settles at once, whatever its epic's state. Pure functions over board records
// (`job.json` and `epic.json`, read tolerantly), unit-testable with a fixed `now`.
import { isEpicSettled, isSettled as settleRule } from '@factory/contract';
import type { SettleEpic, SettleJob } from '@factory/contract';

type Rec = Record<string, unknown>;

/** A project's epics by slug (local and archived), as the board holds them. */
export type Epics = ReadonlyMap<string, Rec>;

/** A project's settled summary on a narrow board (`?settled=summary`). */
export interface SettledSummary {
  count: number; // settled merged jobs plus abandoned jobs
  lastMergedAt: string | null; // the newest `endedAt` among settled merged jobs; abandoned never counts
  epics: number; // settled epics
}

const HOUR_MS = 3_600_000;

/** The longest delay `setTimeout` accepts (2^31 - 1 ms); a longer one fires at once. */
export const MAX_DELAY_MS = 2_147_483_647;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const jobFacts = (job: Rec): SettleJob => ({ stage: str(job.stage), endedAt: str(job.endedAt), epic: str(job.epic) });
const epicFacts = (epic: Rec): SettleEpic => ({ state: str(epic.state), endedAt: str(epic.endedAt) });

// A record's `endedAt` in ms, or null when it has no readable one.
function endedAt(rec: Rec): number | null {
  if (typeof rec.endedAt !== 'string') return null;
  const ended = Date.parse(rec.endedAt);
  return Number.isNaN(ended) ? null : ended;
}

// A merged job's `endedAt` in ms, or null when it is not merged or has no readable `endedAt`.
const mergedAt = (job: Rec): number | null => (job.stage === 'merged' ? endedAt(job) : null);

/** Whether a board epic (`epic.json`) is settled at `now` (ms since the epoch). */
export function isEpicSnapshotSettled(epic: Rec, hours: number, now: number): boolean {
  return isEpicSettled(epicFacts(epic), hours, now);
}

/** Whether a board job is settled at `now` (ms since the epoch), its epic looked up in `epics`. */
export function isSettled(job: Rec, epics: Epics, hours: number, now: number): boolean {
  const slug = str(job.epic);
  const epic = slug === null ? undefined : epics.get(slug);
  return settleRule(jobFacts(job), hours, now, epic === undefined ? null : epicFacts(epic));
}

/** Board jobs and epics, each split into unsettled and settled, keeping the input's order. */
export interface Partition {
  unsettled: Rec[];
  settled: Rec[];
  unsettledEpics: Rec[];
  settledEpics: Rec[];
}

/** Splits board jobs (id order) and epics (slug order) into unsettled and settled. */
export function partition(jobs: readonly Rec[], epics: Epics, hours: number, now: number): Partition {
  const out: Partition = { unsettled: [], settled: [], unsettledEpics: [], settledEpics: [] };
  for (const job of jobs) (isSettled(job, epics, hours, now) ? out.settled : out.unsettled).push(job);
  for (const epic of epics.values()) (isEpicSnapshotSettled(epic, hours, now) ? out.settledEpics : out.unsettledEpics).push(epic);
  return out;
}

/** The summary of the settled jobs and epics. */
export function summarize(settled: readonly Rec[], settledEpics: readonly Rec[]): SettledSummary {
  let last: { at: number; text: string } | null = null;
  for (const job of settled) {
    const at = mergedAt(job);
    if (at !== null && typeof job.endedAt === 'string' && (last === null || at > last.at)) last = { at, text: job.endedAt };
  }
  return { count: settled.length, lastMergedAt: last === null ? null : last.text, epics: settledEpics.length };
}

/**
 * The delay, in ms from `now`, until the next crossing of the settle line, or null when none is
 * coming: the earliest among each unsettled merged job with no `epic` and each unsettled `landed`
 * epic (its jobs settle with it), by their readable `endedAt`. A job in an epic arms nothing of
 * its own, and nothing in a non-terminal epic crosses with no file change. The delay is not
 * clamped: callers clamp it to MAX_DELAY_MS.
 */
export function nextSettle(jobs: readonly Rec[], epics: Epics, hours: number, now: number): number | null {
  const ends: number[] = [];
  for (const job of jobs) {
    const ended = mergedAt(job);
    if (ended !== null && str(job.epic) === null && !isSettled(job, epics, hours, now)) ends.push(ended);
  }
  for (const epic of epics.values()) {
    const ended = epic.state === 'landed' ? endedAt(epic) : null;
    if (ended !== null && !isEpicSnapshotSettled(epic, hours, now)) ends.push(ended);
  }
  let next: number | null = null;
  for (const ended of ends) {
    // Settled once `now - ended > hours`: the first whole millisecond past the line.
    const delay = Math.max(0, Math.floor(ended + hours * HOUR_MS - now) + 1);
    if (next === null || delay < next) next = delay;
  }
  return next;
}
