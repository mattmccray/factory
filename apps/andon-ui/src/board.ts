// The board model, ported from the vendored dashboard's `render`: the andon (needs-human) row,
// the five station columns, and the Settled list. Pure: `now` drives settling.
import type { Job } from './job';
import { time } from './time';

/** A job on the board, tagged with its project. `key` is unique across projects. */
export interface BoardJob {
  key: string; // `<pid>/<job id>`
  project: { id: string; name: string };
  settleAfterHours: number; // the job's own project's setting
  reviewers: string[]; // the job's own project's reviewers, for chip order
  job: Job;
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
  settled: BoardJob[]; // newest end (merge or abandon) first
  running: number; // jobs on the line, not merged or waiting
  waiting: number; // needs-human jobs
  shown: number; // every job not settled
}

/** A merged or abandoned job's end time: `endedAt`, or `updated` for a legacy job. */
export const mergedAt = (j: Job): number => time(j.endedAt ?? j.updated);

/**
 * A merged job settles once its merge is older than its project's `settleAfterHours`; an abandoned
 * job is always settled (never on the board, the andon row, or the counts).
 */
export const isSettled = (b: BoardJob, now: number): boolean =>
  b.job.stage === 'abandoned' || (b.job.stage === 'merged' && now - mergedAt(b.job) > b.settleAfterHours * 3_600_000);

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
