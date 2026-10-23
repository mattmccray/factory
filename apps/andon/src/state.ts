// UI state: every registered project and its last board, driven by the agent's `GET /events`
// stream (`projects`, `board`, `error`) and one `GET /projects/<pid>/board` per project when the
// project list arrives. Every update returns a new state; nothing here touches the DOM.
import { isRecord, toConfig, toJobs, toProjects } from './job';
import type { BoardConfig, Job, ProjectInfo } from './job';

export interface ProjectBoard {
  jobs: Job[];
  config: BoardConfig;
  error: string | null; // `config.json: <reason>` while the project's config is bad
  loaded: boolean; // a board has arrived at least once
  rev: number; // bumped by every board or error, so a slower fetch can't overwrite a newer event
}

export interface UiState {
  projects: ProjectInfo[];
  boards: Record<string, ProjectBoard>;
}

export const emptyState = (): UiState => ({ projects: [], boards: {} });
const emptyBoard = (): ProjectBoard => ({ jobs: [], config: toConfig(null), error: null, loaded: false, rev: 0 });
const known = (s: UiState, pid: string): boolean => s.projects.some((p) => p.id === pid);
const boardOf = (s: UiState, pid: string): ProjectBoard => s.boards[pid] ?? emptyBoard();

function withBoard(s: UiState, pid: string, next: (b: ProjectBoard) => ProjectBoard): UiState {
  if (!known(s, pid)) return s; // a board for a project that isn't listed is ignored
  return { ...s, boards: { ...s.boards, [pid]: next(boardOf(s, pid)) } };
}

/** Replaces the project list. Boards of listed projects are kept; the rest are dropped. */
export function setProjects(s: UiState, projects: ProjectInfo[]): UiState {
  const boards: Record<string, ProjectBoard> = {};
  for (const p of projects) boards[p.id] = boardOf(s, p.id);
  return { projects, boards };
}

/** A project's new board: its jobs and config change, and any config error clears. */
export const setBoard = (s: UiState, pid: string, data: unknown): UiState =>
  withBoard(s, pid, (b) => ({ jobs: toJobs(isRecord(data) ? data.jobs : null), config: toConfig(isRecord(data) ? data.config : null), error: null, loaded: true, rev: b.rev + 1 }));

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
