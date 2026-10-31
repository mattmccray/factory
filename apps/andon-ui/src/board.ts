// The board model, ported from the vendored dashboard's `render`: the andon (needs-human) row,
// the five station columns, and the held jobs that have settled. Pure: `now` drives settling.
// A narrow board holds only unsettled jobs; the rest of a project's settled jobs are its summary's
// count and, once a view fetched them, its cached settled list (`settledCount`, `settledJobs`).
import type { Epic, Job } from './job';
import { time } from './time';

/** A board item's project: its id and name, and the machine it is remote on (absent for a local project; machines.ts). */
export interface BoardProject {
  id: string;
  name: string;
  remote?: string;
}

/** A job on the board, tagged with its project. `key` is unique across projects. */
export interface BoardJob {
  key: string; // `<pid>/<job id>`
  project: BoardProject;
  settleAfterHours: number; // the job's own project's setting
  reviewers: string[]; // the job's own project's reviewers, for chip order
  job: Job;
  epic?: Epic; // the epic the job's `epic` names, when its project has it (on the board or settled); absent: standalone, or unknown
}

/** An epic on the board or in a settled list, tagged with its project. `key` is unique across projects. */
export interface BoardEpic {
  key: string; // `<pid>/<slug>`
  project: BoardProject;
  settleAfterHours: number; // its project's setting
  epic: Epic;
}

/** The epic states an epic never leaves. */
export const isEpicTerminal = (e: Pick<Epic, 'state'>): boolean => e.state === 'landed' || e.state === 'abandoned';

/**
 * The epic-aware settle rule for an epic (docs/contract/v1.md "Epics in the service"): `abandoned`
 * at once, `landed` once its `endedAt` is more than `hours` old; never otherwise.
 */
export function isEpicSettled(e: Pick<Epic, 'state' | 'endedAt'>, hours: number, now: number): boolean {
  if (e.state === 'abandoned') return true;
  if (e.state !== 'landed' || e.endedAt === null) return false;
  const ended = Date.parse(e.endedAt);
  return !Number.isNaN(ended) && now - ended > hours * 3_600_000;
}

export interface Station {
  key: string;
  name: string;
  who: string;
}

export const STATIONS: readonly Station[] = [
  { key: 'spec', name: 'Spec', who: 'spec-writer · opus' },
  { key: 'build', name: 'Build', who: 'builder · opus' },
  { key: 'review', name: 'Review', who: 'reviewers' },
  { key: 'approve', name: 'Approve', who: 'approver · opus' },
  { key: 'merged', name: 'Merged', who: 'main' },
];

export interface Column extends Station {
  jobs: BoardJob[];
}

export interface BoardModel {
  andon: BoardJob[];
  columns: Column[];
  settled: BoardJob[]; // held jobs that settled on screen, newest end (merge or abandon) first
  running: number; // jobs on the line, not merged or waiting
  waiting: number; // needs-human jobs
  shown: number; // every job not settled
}

/** A merged or abandoned job's end time: `endedAt`, or `updated` for a legacy job. */
export const mergedAt = (j: Job): number => time(j.endedAt ?? j.updated);

/**
 * A merged job settles once its merge is older than its project's `settleAfterHours`; an abandoned
 * job is always settled (never on the board, the andon row, or the counts). A merged job in an epic
 * never settles while its epic isn't `landed` or `abandoned` (an unknown epic counts as not
 * terminal); once it is, it settles when its epic does.
 */
export function isSettled(b: BoardJob, now: number): boolean {
  if (b.job.stage === 'abandoned') return true;
  if (b.job.stage !== 'merged') return false;
  if (b.job.epic === null) return now - mergedAt(b.job) > b.settleAfterHours * 3_600_000;
  return b.epic !== undefined && isEpicTerminal(b.epic) && isEpicSettled(b.epic, b.settleAfterHours, now);
}

const stationOf = (stage: string): string => (stage === 'claimed' ? 'spec' : stage);

/** Splits jobs into the andon row, the station columns, and the Settled list at `now`. */
export function buildBoard(jobs: readonly BoardJob[], now: number, reviewers: readonly string[] = []): BoardModel {
  const settled = jobs.filter((b) => isSettled(b, now)).sort((a, b) => mergedAt(b.job) - mergedAt(a.job));
  const live = jobs.filter((b) => !isSettled(b, now)).sort((a, b) => time(b.job.updated) - time(a.job.updated));
  const andon = live.filter((b) => b.job.stage === 'needs-human');
  const columns = STATIONS.map((st) => ({
    ...st,
    who: st.key === 'review' ? reviewers.join(' · ') || st.who : st.who,
    jobs: live.filter((b) => stationOf(b.job.stage) === st.key),
  }));
  return {
    andon,
    columns,
    settled,
    running: live.filter((b) => b.job.stage !== 'merged' && b.job.stage !== 'needs-human').length,
    waiting: andon.length,
    shown: live.length,
  };
}

/**
 * A project's settled count: its summary's `count`, plus the held jobs the UI already sees as
 * settled. The service never counts a job it still sends on the board, so a held job is never
 * counted twice; it joins the count the moment it crosses, before the service's next push.
 */
export const settledCount = (summaryCount: number, held: readonly BoardJob[], now: number): number => summaryCount + held.filter((b) => isSettled(b, now)).length;

/**
 * The settled jobs to list, newest end first: the held jobs the UI sees as settled, and every
 * fetched settled job that isn't held. A job both held and fetched (a list fetched just before the
 * push that drops it) is listed once, from the board, which is never older; one held and not yet
 * settled stays on the board only.
 */
export function settledJobs(held: readonly BoardJob[], fetched: readonly BoardJob[], now: number): BoardJob[] {
  const heldKeys = new Set(held.map((b) => b.key));
  return [...held.filter((b) => isSettled(b, now)), ...fetched.filter((b) => !heldKeys.has(b.key))].sort((a, b) => mergedAt(b.job) - mergedAt(a.job) || a.key.localeCompare(b.key));
}

/** A round's chips: its own reviewers, in config order, unknown keys last. */
export function roundKeys(reviews: Record<string, string>, reviewers: readonly string[]): string[] {
  const rank = (k: string): number => {
    const i = reviewers.indexOf(k);
    return i < 0 ? reviewers.length : i;
  };
  return Object.keys(reviews).sort((a, b) => rank(a) - rank(b));
}

export interface ChipRound {
  round: number;
  reviews: Record<string, string>;
  past: boolean;
}

/** A card's rows of chips: every past round, then the current one. */
export function chipRounds(j: Job): ChipRound[] {
  const rows = j.history.map((h) => ({ ...h, past: true }));
  if (j.round > 0) rows.push({ round: j.round, reviews: j.reviews, past: false });
  return rows;
}

/** Which keys are new to the board and which changed stage, given the stages last seen. */
export function movement(prev: ReadonlyMap<string, string>, jobs: readonly BoardJob[]): { fresh: Set<string>; moved: Set<string>; stages: Map<string, string> } {
  const fresh = new Set<string>();
  const moved = new Set<string>();
  const stages = new Map<string, string>();
  for (const b of jobs) {
    const before = prev.get(b.key);
    if (before === undefined) fresh.add(b.key);
    else if (before !== b.job.stage) moved.add(b.key);
    stages.set(b.key, b.job.stage);
  }
  return { fresh, moved, stages };
}
