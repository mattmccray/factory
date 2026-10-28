// The Mac app's view of the service: the registered projects and each one's last board, narrowed from
// the service's JSON (docs/contract/v1.md "Andon service"). A tolerant reader: it keeps only the job
// fields the tray and notifications use and ignores everything else. Every update returns a new
// state. Runtime-neutral, and independent of the contract package and the UI.

export interface AppJob {
  id: string;
  title: string;
  stage: string;
  note: string;
}

export interface AppProject {
  id: string;
  name: string;
  /** The project's folder, for its right-click menu; null when the feed gives no non-empty string. */
  root: string | null;
}

export interface AppBoard {
  jobs: AppJob[];
  error: string | null; // `config.json: <reason>` while the project's config is bad
  rev: number; // bumped by every board or error, so a slower fetch can't overwrite a newer event
}

export interface AppState {
  projects: AppProject[];
  boards: Record<string, AppBoard>;
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export const emptyState = (): AppState => ({ projects: [], boards: {} });
const emptyBoard = (): AppBoard => ({ jobs: [], error: null, rev: 0 });

/** The jobs of a board's `jobs` array. An entry without a string `id` and `stage` is skipped. */
export function toJobs(v: unknown): AppJob[] {
  const out: AppJob[] = [];
  if (!Array.isArray(v)) return out;
  for (const j of v) {
    if (!isRecord(j) || typeof j.id !== 'string' || typeof j.stage !== 'string') continue;
    out.push({ id: j.id, title: str(j.title), stage: j.stage, note: str(j.note) });
  }
  return out;
}

/** The project list of a `projects` payload, or null when it isn't one. A project without a
 *  non-empty string `root` is kept, with `root: null` (it gets no right-click menu). */
export function toProjects(v: unknown): AppProject[] | null {
  if (!isRecord(v) || !Array.isArray(v.projects)) return null;
  const out: AppProject[] = [];
  for (const p of v.projects) {
    if (isRecord(p) && typeof p.id === 'string') out.push({ id: p.id, name: str(p.name), root: typeof p.root === 'string' && p.root !== '' ? p.root : null });
  }
  return out;
}

export const isListed = (s: AppState, pid: string): boolean => s.projects.some((p) => p.id === pid);
export const revOf = (s: AppState, pid: string): number => (s.boards[pid] ?? emptyBoard()).rev;

/** Replaces the project list. Boards of listed projects are kept; the rest are dropped. */
export function setProjects(s: AppState, projects: AppProject[]): AppState {
  const boards: Record<string, AppBoard> = {};
  for (const p of projects) boards[p.id] = s.boards[p.id] ?? emptyBoard();
  return { projects, boards };
}

function withBoard(s: AppState, pid: string, next: (b: AppBoard) => AppBoard): AppState {
  if (!isListed(s, pid)) return s; // a board for a project that isn't listed is ignored
  return { ...s, boards: { ...s.boards, [pid]: next(s.boards[pid] ?? emptyBoard()) } };
}

/** A project's new jobs; any config error clears. */
export const setBoard = (s: AppState, pid: string, jobs: AppJob[]): AppState => withBoard(s, pid, (b) => ({ jobs, error: null, rev: b.rev + 1 }));

/** A project's config went bad: it keeps its last jobs and records the reason. */
export const setError = (s: AppState, pid: string, reason: string): AppState => withBoard(s, pid, (b) => ({ ...b, error: reason, rev: b.rev + 1 }));
