// The project switcher: one project's board, or **All projects** merged into one board with
// every card tagged by its project. The selection persists in localStorage.
import type { BoardJob } from './board';
import type { UiState } from './state';

export const ALL = 'all';
/** `ALL`, or a project id. */
export type Selection = string;
export const SELECTION_KEY = 'andon.project';

/** The slice of `Storage` the switcher needs, so it can be faked in tests. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadSelection(store: KeyValueStore | null): Selection {
  try {
    return store?.getItem(SELECTION_KEY) || ALL;
  } catch {
    return ALL; // storage blocked
  }
}

export function saveSelection(store: KeyValueStore | null, sel: Selection): void {
  try {
    store?.setItem(SELECTION_KEY, sel);
  } catch {
    // storage blocked or full: the selection just won't persist
  }
}

/** The selection to show: a stored project that is no longer registered falls back to All projects. */
export const resolveSelection = (s: UiState, sel: Selection): Selection => (s.projects.some((p) => p.id === sel) ? sel : ALL);

/** The jobs on the board for a selection, each tagged with its project and that project's settings. */
export function boardJobs(s: UiState, sel: Selection): BoardJob[] {
  const out: BoardJob[] = [];
  for (const p of s.projects) {
    if (sel !== ALL && sel !== p.id) continue;
    const b = s.boards[p.id];
    if (b === undefined) continue;
    for (const job of b.jobs) {
      out.push({ key: `${p.id}/${job.id}`, project: { id: p.id, name: p.name }, settleAfterHours: b.config.settleAfterHours, reviewers: b.config.reviewers, job });
    }
  }
  return out;
}

/** The Review column's reviewers: the selected project's, or every project's (first seen first). */
export function reviewersFor(s: UiState, sel: Selection): string[] {
  const out: string[] = [];
  for (const p of s.projects) {
    if (sel !== ALL && sel !== p.id) continue;
    for (const r of s.boards[p.id]?.config.reviewers ?? []) if (!out.includes(r)) out.push(r);
  }
  return out;
}

/** The switcher's needs-human counts, per project and in total. */
export function needsHuman(s: UiState): { byProject: Record<string, number>; total: number } {
  const byProject: Record<string, number> = {};
  let total = 0;
  for (const p of s.projects) {
    const n = (s.boards[p.id]?.jobs ?? []).filter((j) => j.stage === 'needs-human').length;
    byProject[p.id] = n;
    total += n;
  }
  return { byProject, total };
}

/** Projects in the selection whose config is bad: `{ name, reason }`, each keeping its last board. */
export function projectErrors(s: UiState, sel: Selection): Array<{ id: string; name: string; reason: string }> {
  const out: Array<{ id: string; name: string; reason: string }> = [];
  for (const p of s.projects) {
    const reason = s.boards[p.id]?.error ?? null;
    if ((sel === ALL || sel === p.id) && reason !== null) out.push({ id: p.id, name: p.name, reason });
  }
  return out;
}

/** The agent path of a job's docs, in that job's own project. */
export const docsPath = (b: Pick<BoardJob, 'project' | 'job'>): string => `/projects/${encodeURIComponent(b.project.id)}/jobs/${encodeURIComponent(b.job.id)}/docs`;

export const boardPath = (pid: string): string => `/projects/${encodeURIComponent(pid)}/board`;
