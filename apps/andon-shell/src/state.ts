// The shell's view of the agent: the registered projects and each one's last board, narrowed from
// the agent's JSON (docs/contract/v1.md "Andon agent"). A tolerant reader: it keeps only the job
// fields the tray and notifications use and ignores everything else. Every update returns a new
// state. Runtime-neutral, and independent of the contract package and the UI.

export interface ShellJob {
  id: string;
  title: string;
  stage: string;
  note: string;
}

export interface ShellProject {
  id: string;
  name: string;
}

export interface ShellBoard {
  jobs: ShellJob[];
  error: string | null; // `config.json: <reason>` while the project's config is bad
  rev: number; // bumped by every board or error, so a slower fetch can't overwrite a newer event
}

export interface ShellState {
  projects: ShellProject[];
  boards: Record<string, ShellBoard>;
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export const emptyState = (): ShellState => ({ projects: [], boards: {} });
const emptyBoard = (): ShellBoard => ({ jobs: [], error: null, rev: 0 });

/** The jobs of a board's `jobs` array. An entry without a string `id` and `stage` is skipped. */
export function toJobs(v: unknown): ShellJob[] {
  const out: ShellJob[] = [];
  if (!Array.isArray(v)) return out;
  for (const j of v) {
    if (!isRecord(j) || typeof j.id !== 'string' || typeof j.stage !== 'string') continue;
    out.push({ id: j.id, title: str(j.title), stage: j.stage, note: str(j.note) });
  }
  return out;
}

/** The project list of a `projects` payload, or null when it isn't one. */
export function toProjects(v: unknown): ShellProject[] | null {
  if (!isRecord(v) || !Array.isArray(v.projects)) return null;
  const out: ShellProject[] = [];
  for (const p of v.projects) if (isRecord(p) && typeof p.id === 'string') out.push({ id: p.id, name: str(p.name) });
  return out;
}

export const isListed = (s: ShellState, pid: string): boolean => s.projects.some((p) => p.id === pid);
export const revOf = (s: ShellState, pid: string): number => (s.boards[pid] ?? emptyBoard()).rev;

/** Replaces the project list. Boards of listed projects are kept; the rest are dropped. */
export function setProjects(s: ShellState, projects: ShellProject[]): ShellState {
  const boards: Record<string, ShellBoard> = {};
  for (const p of projects) boards[p.id] = s.boards[p.id] ?? emptyBoard();
  return { projects, boards };
}

function withBoard(s: ShellState, pid: string, next: (b: ShellBoard) => ShellBoard): ShellState {
  if (!isListed(s, pid)) return s; // a board for a project that isn't listed is ignored
  return { ...s, boards: { ...s.boards, [pid]: next(s.boards[pid] ?? emptyBoard()) } };
}

/** A project's new jobs; any config error clears. */
export const setBoard = (s: ShellState, pid: string, jobs: ShellJob[]): ShellState => withBoard(s, pid, (b) => ({ jobs, error: null, rev: b.rev + 1 }));

/** A project's config went bad: it keeps its last jobs and records the reason. */
export const setError = (s: ShellState, pid: string, reason: string): ShellState => withBoard(s, pid, (b) => ({ ...b, error: reason, rev: b.rev + 1 }));
