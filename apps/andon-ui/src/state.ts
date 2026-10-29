// UI state: every registered project and its last board, driven by the service's
// `GET /events?settled=summary` stream (`projects`, `board`, `error`) and one
// `GET /projects/<pid>/board?settled=summary` per project when the project list arrives. A board
// is narrow: its unsettled jobs, its config, and a settled summary. A project's settled jobs are
// fetched only when a view needs them (`GET /projects/<pid>/settled`) and cached per project.
// Every update returns a new state; nothing here touches the DOM.
import { isRecord, toConfig, toJobs, toProjects } from './job';
import type { BoardConfig, Job, ProjectInfo } from './job';

/** A narrow board's settled summary: how many jobs settled, and the newest settled merge's `endedAt`. */
export interface SettledSummary {
  count: number;
  lastMergedAt: string | null;
}

export interface ProjectBoard {
  jobs: Job[];
  config: BoardConfig;
  settled: SettledSummary;
  error: string | null; // `config.json: <reason>` while the project's config is bad
  loaded: boolean; // a board has arrived at least once
  rev: number; // bumped by every board or error, so a slower fetch can't overwrite a newer event
}

/** One project's cached settled list. */
export interface SettledList {
  status: 'loading' | 'loaded' | 'failed';
  jobs: Job[] | null; // the last list that arrived; null until one has
  reason: string | null; // why the last fetch failed
  summary: SettledSummary; // the board's summary when the last fetch was sent
  rev: number; // bumped by every fetch, so only the newest one applies
}

export interface UiState {
  projects: ProjectInfo[];
  boards: Record<string, ProjectBoard>;
  settled: Record<string, SettledList>;
}

export const NO_SETTLED: SettledSummary = { count: 0, lastMergedAt: null };

export const emptyState = (): UiState => ({ projects: [], boards: {}, settled: {} });
const emptyBoard = (): ProjectBoard => ({ jobs: [], config: toConfig(null), settled: NO_SETTLED, error: null, loaded: false, rev: 0 });
const known = (s: UiState, pid: string): boolean => s.projects.some((p) => p.id === pid);
const boardOf = (s: UiState, pid: string): ProjectBoard => s.boards[pid] ?? emptyBoard();

/** A board's `settled` summary; anything but `{ count: <non-negative integer>, lastMergedAt: <string | null> }` (an older service) is none. */
export function toSummary(v: unknown): SettledSummary {
  if (!isRecord(v)) return NO_SETTLED;
  const { count, lastMergedAt } = v;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return NO_SETTLED;
  if (lastMergedAt !== null && typeof lastMergedAt !== 'string') return NO_SETTLED;
  return { count, lastMergedAt };
}

export const sameSummary = (a: SettledSummary, b: SettledSummary): boolean => a.count === b.count && a.lastMergedAt === b.lastMergedAt;

function withBoard(s: UiState, pid: string, next: (b: ProjectBoard) => ProjectBoard): UiState {
  if (!known(s, pid)) return s; // a board for a project that isn't listed is ignored
  return { ...s, boards: { ...s.boards, [pid]: next(boardOf(s, pid)) } };
}

/** Replaces the project list. Boards and settled lists of listed projects are kept; the rest are dropped. */
export function setProjects(s: UiState, projects: ProjectInfo[]): UiState {
  const boards: Record<string, ProjectBoard> = {};
  const settled: Record<string, SettledList> = {};
  for (const p of projects) {
    boards[p.id] = boardOf(s, p.id);
    const list = s.settled[p.id];
    if (list !== undefined) settled[p.id] = list;
  }
  return { projects, boards, settled };
}

/** A project's new board: its jobs, config, and settled summary change, and any config error clears. */
export const setBoard = (s: UiState, pid: string, data: unknown): UiState =>
  withBoard(s, pid, (b) => ({
    jobs: toJobs(isRecord(data) ? data.jobs : null),
    config: toConfig(isRecord(data) ? data.config : null),
    settled: toSummary(isRecord(data) ? data.settled : null),
    error: null,
    loaded: true,
    rev: b.rev + 1,
  }));

/** A project's config went bad: it shows the reason and keeps its last board. */
export const setError = (s: UiState, pid: string, reason: string): UiState => withBoard(s, pid, (b) => ({ ...b, error: reason, loaded: true, rev: b.rev + 1 }));

/** Applies one `GET /events` event. Unknown events and malformed data leave the state as is. */
export function applyEvent(s: UiState, event: string, data: unknown): UiState {
  if (event === 'projects') return isRecord(data) && Array.isArray(data.projects) ? setProjects(s, toProjects(data)) : s;
  if (!isRecord(data) || typeof data.project !== 'string') return s;
  if (event === 'board') return setBoard(s, data.project, data);
  if (event === 'error') return setError(s, data.project, typeof data.reason === 'string' ? data.reason : 'config.json: unreadable');
  return s;
}

/** The `rev` to pass back with a fetched board, read when the request is sent. */
export const revOf = (s: UiState, pid: string): number => boardOf(s, pid).rev;

/** Applies a fetched board (or its error) unless an event for that project arrived since `rev`. */
export function applyFetched(s: UiState, pid: string, rev: number, result: { ok: true; data: unknown } | { ok: false; reason: string }): UiState {
  if (revOf(s, pid) !== rev) return s;
  return result.ok ? setBoard(s, pid, result.data) : setError(s, pid, result.reason);
}

// ---- settled lists ----

/**
 * Whether a project's settled list should be fetched now: its board has loaded, and no fetch was
 * sent for the board's current summary (none yet, or the summary changed since). With `retry`, a
 * list whose last fetch failed is fetched again too (a view that needs it just opened).
 */
export function wantsSettled(s: UiState, pid: string, retry = false): boolean {
  const b = s.boards[pid];
  if (b === undefined || !b.loaded || !known(s, pid)) return false;
  const list = s.settled[pid];
  if (list === undefined) return true;
  if (!sameSummary(list.summary, b.settled)) return true;
  return retry && list.status === 'failed';
}

/** Marks a project's settled list as being fetched for its board's current summary. Returns the new state and the fetch's `rev`. */
export function startSettled(s: UiState, pid: string): { state: UiState; rev: number } {
  const prev = s.settled[pid];
  const rev = (prev?.rev ?? 0) + 1;
  const list: SettledList = { status: 'loading', jobs: prev?.jobs ?? null, reason: null, summary: boardOf(s, pid).settled, rev };
  return { state: { ...s, settled: { ...s.settled, [pid]: list } }, rev };
}

/** Applies a fetched settled list (`{ jobs }`) or its error, unless a newer fetch was sent since `rev` or the project is gone. */
export function applySettled(s: UiState, pid: string, rev: number, result: { ok: true; data: unknown } | { ok: false; reason: string }): UiState {
  const list = s.settled[pid];
  if (list === undefined || list.rev !== rev || !known(s, pid)) return s;
  const next: SettledList = result.ok
    ? { ...list, status: 'loaded', jobs: toJobs(isRecord(result.data) ? result.data.jobs : null), reason: null }
    : { ...list, status: 'failed', reason: result.reason };
  return { ...s, settled: { ...s.settled, [pid]: next } };
}

/** Whether a project's settled list is loaded for its board's current summary: nothing newer can be missing from it. */
export function settledCurrent(s: UiState, pid: string): boolean {
  const b = s.boards[pid];
  const list = s.settled[pid];
  return b !== undefined && b.loaded && list !== undefined && list.status === 'loaded' && sameSummary(list.summary, b.settled);
}
