// The project switcher: one project's board, or **All projects** merged into one board with
// every card tagged by its project. The selection persists in localStorage.
import { isEpicSettled, settledCount, settledJobs } from './board';
import type { BoardEpic, BoardJob } from './board';
import type { Epic, Job, ProjectInfo } from './job';
import { settledCurrent } from './state';
import { time } from './time';
import type { ProjectBoard, UiState } from './state';

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

/** A project's epics: those on its board, then its cached settled ones that aren't (a board epic wins). */
export function projectEpics(s: UiState, pid: string): Epic[] {
  const held = s.boards[pid]?.epics ?? [];
  const slugs = new Set(held.map((e) => e.slug));
  return [...held, ...(s.settled[pid]?.epics ?? []).filter((e) => !slugs.has(e.slug))];
}

/** A job tagged with its project and that project's settings, and with its epic when the project has it. */
function tagged(s: UiState, p: ProjectInfo, b: ProjectBoard, job: Job): BoardJob {
  const out: BoardJob = {
    key: `${p.id}/${job.id}`,
    project: { id: p.id, name: p.name },
    settleAfterHours: b.config.settleAfterHours,
    reviewers: b.config.reviewers,
    job,
  };
  const epic = job.epic === null ? undefined : projectEpics(s, p.id).find((e) => e.slug === job.epic);
  if (epic !== undefined) out.epic = epic;
  return out;
}

const taggedEpic = (p: ProjectInfo, b: ProjectBoard, epic: Epic): BoardEpic => ({ key: `${p.id}/${epic.slug}`, project: { id: p.id, name: p.name }, settleAfterHours: b.config.settleAfterHours, epic });

/** The jobs on the board for a selection, each tagged with its project and that project's settings. */
export function boardJobs(s: UiState, sel: Selection): BoardJob[] {
  const out: BoardJob[] = [];
  for (const p of s.projects) {
    if (sel !== ALL && sel !== p.id) continue;
    const b = s.boards[p.id];
    if (b === undefined) continue;
    for (const job of b.jobs) out.push(tagged(s, p, b, job));
  }
  return out;
}

/** The epics on the board for a selection (the projects' unsettled epics), each tagged with its project. */
export function boardEpics(s: UiState, sel: Selection): BoardEpic[] {
  const out: BoardEpic[] = [];
  for (const p of s.projects) {
    if (sel !== ALL && sel !== p.id) continue;
    const b = s.boards[p.id];
    if (b === undefined) continue;
    for (const e of b.epics) out.push(taggedEpic(p, b, e));
  }
  return out;
}

/** The selection's cached settled epics (fetched on demand with its settled jobs), tagged as board epics are. */
export function fetchedSettledEpics(s: UiState, sel: Selection): BoardEpic[] {
  const out: BoardEpic[] = [];
  for (const p of s.projects) {
    if (sel !== ALL && sel !== p.id) continue;
    const b = s.boards[p.id];
    if (b === undefined) continue;
    for (const e of s.settled[p.id]?.epics ?? []) out.push(taggedEpic(p, b, e));
  }
  return out;
}

/** The selection's settled epics to list: held epics that settled on screen, and every fetched one that isn't held. Newest end first. */
export function settledEpicsFor(s: UiState, sel: Selection, now: number): BoardEpic[] {
  const held = boardEpics(s, sel);
  const keys = new Set(held.map((e) => e.key));
  const end = (e: BoardEpic): number => time(e.epic.endedAt ?? e.epic.updated);
  return [...held.filter((e) => isEpicSettled(e.epic, e.settleAfterHours, now)), ...fetchedSettledEpics(s, sel).filter((e) => !keys.has(e.key))].sort((a, b) => end(b) - end(a) || a.key.localeCompare(b.key));
}

/** An epic that waits on Matt for an epic-level reason (`waitingOn: "you"`): one more needs-human item. */
export const isHotEpic = (e: Pick<Epic, 'waitingOn'>): boolean => e.waitingOn === 'you';

/** How many of the selection's epics wait on you: the toolbar's "M waiting on you" adds them to its needs-human jobs. */
export const hotEpics = (s: UiState, sel: Selection): number => boardEpics(s, sel).filter((e) => isHotEpic(e.epic)).length;

/** The selection's cached settled jobs (fetched on demand), tagged as board jobs are. */
export function fetchedSettled(s: UiState, sel: Selection): BoardJob[] {
  const out: BoardJob[] = [];
  for (const p of s.projects) {
    if (sel !== ALL && sel !== p.id) continue;
    const b = s.boards[p.id];
    if (b === undefined) continue;
    for (const job of s.settled[p.id]?.jobs ?? []) out.push(tagged(s, p, b, job));
  }
  return out;
}

/**
 * The selection's held jobs plus each cached settled job that isn't held: every job a focused
 * project's Recent activity is built from.
 */
export function withSettled(s: UiState, sel: Selection): BoardJob[] {
  const held = boardJobs(s, sel);
  const keys = new Set(held.map((b) => b.key));
  return [...held, ...fetchedSettled(s, sel).filter((b) => !keys.has(b.key))];
}

/** The selection's settled jobs to list: held jobs that settled on screen, and the cached lists. Newest end first. */
export const settledFor = (s: UiState, sel: Selection, now: number): BoardJob[] => settledJobs(boardJobs(s, sel), fetchedSettled(s, sel), now);

/** Each project's settled count (its summary's count plus held jobs that settled on screen). */
export function settledCounts(s: UiState, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of s.projects) out[p.id] = settledCount(s.boards[p.id]?.settled.count ?? 0, boardJobs(s, p.id), now);
  return out;
}

/** The toolbar's "Settled N": the sum of the selection's projects' settled counts. */
export function settledTotal(s: UiState, sel: Selection, now: number): number {
  const counts = settledCounts(s, now);
  return s.projects.filter((p) => sel === ALL || sel === p.id).reduce((n, p) => n + (counts[p.id] ?? 0), 0);
}

/** The registered projects a Settled sheet lists: one (its filter, when registered), or every project. */
export const sheetProjects = (s: UiState, filter: string | null): string[] => s.projects.map((p) => p.id).filter((id) => filter === null || id === filter);

/** How a view's settled lists stand: still loading a first list, the fetches that failed, and whether every list is current. */
export interface SettledStatus {
  loading: boolean; // some list has never arrived and isn't known to have failed
  failures: Array<{ id: string; name: string; reason: string }>;
  current: boolean; // every list is loaded for its project's current summary
}

export function settledStatus(s: UiState, pids: readonly string[]): SettledStatus {
  const failures: SettledStatus['failures'] = [];
  let loading = false;
  for (const pid of pids) {
    const list = s.settled[pid];
    if (list?.status === 'failed') failures.push({ id: pid, name: s.projects.find((p) => p.id === pid)?.name ?? pid, reason: list.reason ?? 'unreadable' });
    else if (list === undefined || list.jobs === null) loading = true;
  }
  return { loading, failures, current: pids.every((pid) => settledCurrent(s, pid)) };
}

/** A job the inspector names: found on a board or in a cached settled list, still waiting on one, or missing from both. */
export type Lookup = { state: 'found'; item: BoardJob } | { state: 'waiting' } | { state: 'missing' };

/**
 * Finds a job across every board and every cached settled list. It is `missing` only once its
 * project's board has loaded and its settled list is loaded for the board's current summary, and
 * neither has it (or the project isn't registered); until then it is `waiting`.
 */
export function lookupJob(s: UiState, ref: { project: string; id: string }): Lookup {
  const p = s.projects.find((x) => x.id === ref.project);
  const b = s.boards[ref.project];
  if (p === undefined || b === undefined) return s.projects.length > 0 ? { state: 'missing' } : { state: 'waiting' };
  const held = b.jobs.find((j) => j.id === ref.id);
  if (held !== undefined) return { state: 'found', item: tagged(s, p, b, held) };
  const fetched = s.settled[ref.project]?.jobs?.find((j) => j.id === ref.id);
  if (fetched !== undefined) return { state: 'found', item: tagged(s, p, b, fetched) };
  return settledCurrent(s, ref.project) ? { state: 'missing' } : { state: 'waiting' };
}

/** An epic the inspector names, as `lookupJob` finds a job. */
export type EpicLookup = { state: 'found'; item: BoardEpic } | { state: 'waiting' } | { state: 'missing' };

/** Finds an epic on its project's board or in its cached settled list; `missing` and `waiting` as for `lookupJob`. */
export function lookupEpic(s: UiState, ref: { project: string; slug: string }): EpicLookup {
  const p = s.projects.find((x) => x.id === ref.project);
  const b = s.boards[ref.project];
  if (p === undefined || b === undefined) return s.projects.length > 0 ? { state: 'missing' } : { state: 'waiting' };
  const epic = projectEpics(s, ref.project).find((e) => e.slug === ref.slug);
  if (epic !== undefined) return { state: 'found', item: taggedEpic(p, b, epic) };
  return settledCurrent(s, ref.project) ? { state: 'missing' } : { state: 'waiting' };
}

/** Whether an epic is on its project's board (held), so the inspector needs no settled list for it. */
export const isEpicHeld = (s: UiState, ref: { project: string; slug: string }): boolean => s.boards[ref.project]?.epics.some((e) => e.slug === ref.slug) === true;

/** An epic's jobs, on the board or in the cached settled list (a held job wins), each tagged, in id order. */
export function epicJobs(s: UiState, ref: { project: string; slug: string }): BoardJob[] {
  const held = boardJobs(s, ref.project);
  const keys = new Set(held.map((b) => b.key));
  return [...held, ...fetchedSettled(s, ref.project).filter((b) => !keys.has(b.key))].filter((b) => b.job.epic === ref.slug).sort((a, b) => a.job.id.localeCompare(b.job.id));
}

/** Whether a job is on its project's board (held), so the inspector needs no settled list for it. */
export const isHeld = (s: UiState, ref: { project: string; id: string }): boolean => s.boards[ref.project]?.jobs.some((j) => j.id === ref.id) === true;

/** The Review column's reviewers: the selected project's, or every project's (first seen first). */
export function reviewersFor(s: UiState, sel: Selection): string[] {
  const out: string[] = [];
  for (const p of s.projects) {
    if (sel !== ALL && sel !== p.id) continue;
    for (const r of s.boards[p.id]?.config.reviewers ?? []) if (!out.includes(r)) out.push(r);
  }
  return out;
}

/** The switcher's needs-human counts, per project and in total: needs-human jobs, plus each epic waiting on you. */
export function needsHuman(s: UiState): { byProject: Record<string, number>; total: number } {
  const byProject: Record<string, number> = {};
  let total = 0;
  for (const p of s.projects) {
    const n = (s.boards[p.id]?.jobs ?? []).filter((j) => j.stage === 'needs-human').length + (s.boards[p.id]?.epics ?? []).filter(isHotEpic).length;
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

/** The service path of an epic's docs (its plan, then its members' briefs), in that epic's own project. */
export const epicDocsPath = (pid: string, slug: string): string => `/projects/${encodeURIComponent(pid)}/epics/${encodeURIComponent(slug)}/docs`;

/** The service path of a job's docs, in that job's own project. */
export const docsPath = (b: Pick<BoardJob, 'project' | 'job'>): string => `/projects/${encodeURIComponent(b.project.id)}/jobs/${encodeURIComponent(b.job.id)}/docs`;

/** The event stream, opted in to narrow boards: each `board` event carries unsettled jobs and a settled summary. */
export const EVENTS_PATH = '/events?settled=summary';

/** A project's narrow board: its unsettled jobs, its config, and its settled summary. */
export const boardPath = (pid: string): string => `/projects/${encodeURIComponent(pid)}/board?settled=summary`;

/** A project's settled jobs, fetched only when a view needs them. */
export const settledPath = (pid: string): string => `/projects/${encodeURIComponent(pid)}/settled`;
