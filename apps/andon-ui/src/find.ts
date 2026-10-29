// Search and Needs Me (design §10), pure. Search matches a job's id, title, and project name,
// case-insensitively; the board dims what doesn't match to 25% (tokens and whole lanes) and hides
// nothing. Needs Me hides every job that doesn't need a human to look at it, and every lane left
// with none.
import { isSettled } from './board';
import type { BoardJob } from './board';
import { isReviewFailed } from './lanes';

/** The query as matched: trimmed and lower-cased. Empty means no search. */
export const normalize = (query: string): string => query.trim().toLowerCase();

/** Whether a job matches a query: its id, title, or project name contains it. An empty query matches everything. */
export function matches(b: BoardJob, query: string): boolean {
  const q = normalize(query);
  if (q === '') return true;
  return [b.job.id, b.job.title, b.project.name].some((s) => s.toLowerCase().includes(q));
}

export interface Find {
  active: boolean; // a non-empty query: something may be dimmed
  keys: ReadonlySet<string>; // the matching jobs' keys
  dimLanes: ReadonlySet<string>; // project ids of lanes with no matching job
}

/**
 * The search over the board: which jobs match, and which lanes are dimmed (exactly those with no
 * matching job on them). A lane's jobs are the ones it shows: never settled or abandoned ones,
 * focused or not. An empty or whitespace query dims nothing.
 */
export function find(projects: ReadonlyArray<{ id: string }>, jobs: readonly BoardJob[], query: string, now: number): Find {
  if (normalize(query) === '') return { active: false, keys: new Set(), dimLanes: new Set() };
  const onLane = (b: BoardJob): boolean => !isSettled(b, now);
  const hits = jobs.filter((b) => onLane(b) && matches(b, query));
  const lit = new Set(hits.map((b) => b.project.id));
  return { active: true, keys: new Set(hits.map((b) => b.key)), dimLanes: new Set(projects.map((p) => p.id).filter((id) => !lit.has(id))) };
}

/**
 * Whether a job needs me: its stage is `needs-human` (Escalated, "Approved · not merged", and
 * merge-failed), or it is review-failed. An approver wait never does, however long it waits, and
 * neither does a merged, settled, or abandoned job.
 */
export const needsMe = (b: BoardJob): boolean => b.job.stage === 'needs-human' || isReviewFailed(b.job);

/** Needs Me over the board: only the jobs that need me, and only the projects with any left. */
export function needsFilter<P extends { id: string }>(projects: readonly P[], jobs: readonly BoardJob[]): { projects: P[]; jobs: BoardJob[] } {
  const kept = jobs.filter(needsMe);
  const ids = new Set(kept.map((b) => b.project.id));
  return { projects: projects.filter((p) => ids.has(p.id)), jobs: kept };
}
