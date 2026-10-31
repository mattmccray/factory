// The Mac app's view of the service: the registered projects and each one's last board, narrowed from
// the service's JSON (docs/contract/v1.md "Andon service"). A tolerant reader: it keeps only the job
// fields the tray and notifications use and ignores everything else. Every update returns a new
// state. Runtime-neutral, and independent of the contract package and the UI. Epics: each job's
// `epic`, and each board's `epics` (their slug, state, waitingOn, note, member count, and `title` when
// the payload carries one), read here without the contract code. Machines: a project is remote,
// on another machine the local service follows as a peer, exactly when its id is `<pid>@<machine>`
// (docs/contract/v1.md "Andon service", "Peers", *Ids*); a bare id is always local. Remoteness is
// decided here, once, from the id alone: never from `root`, nor from an entry's `machine` field.

export interface AppJob {
  id: string;
  title: string;
  stage: string;
  note: string;
  /** The slug of the epic the job runs in; absent for a standalone job. */
  epic?: string;
}

/** An epic, as the tray and notifications read it. */
export interface AppEpic {
  slug: string;
  name: string; // its `title` when the payload carries a non-empty one, else its slug
  state: string; // running, waiting, landing, landed, abandoned, or a state a later v1 adds
  waitingOn: string | null; // 'you' when it waits on a human for an epic-level reason
  note: string;
  members: number; // how many plan members it has
}

export interface AppProject {
  id: string;
  name: string;
  /** The project's folder, for its right-click menu; null when the feed gives no non-empty string.
   *  A remote project's root is a path on its own machine, never on this Mac. */
  root: string | null;
  /** The machine of a remote project (the part of its id after `@`); null for a local one. */
  machine: string | null;
}

export interface AppBoard {
  jobs: AppJob[];
  /** The board's epics; absent or empty: none. */
  epics?: AppEpic[];
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
    const job: AppJob = { id: j.id, title: str(j.title), stage: j.stage, note: str(j.note) };
    if (typeof j.epic === 'string' && j.epic !== '') job.epic = j.epic;
    out.push(job);
  }
  return out;
}

/** The epics of a board's `epics` array. A missing array is none; an entry without a non-empty string `slug` is skipped. */
export function toEpics(v: unknown): AppEpic[] {
  const out: AppEpic[] = [];
  if (!Array.isArray(v)) return out;
  for (const e of v) {
    if (!isRecord(e) || typeof e.slug !== 'string' || e.slug === '') continue;
    const title = str(e.title).trim();
    out.push({
      slug: e.slug,
      name: title !== '' ? title : e.slug,
      state: str(e.state),
      waitingOn: typeof e.waitingOn === 'string' ? e.waitingOn : null,
      note: str(e.note),
      members: Array.isArray(e.members) ? e.members.length : 0,
    });
  }
  return out;
}

/** The epics on a board (none when it has none). */
export const epicsOf = (b: AppBoard | undefined): AppEpic[] => b?.epics ?? [];

/** An epic waiting on a human for an epic-level reason. */
export const waitsOnYou = (e: AppEpic): boolean => e.waitingOn === 'you';

/** Where a project id says it lives: `{ machine: null }` for a bare id (local), `{ machine }` for
 *  `<pid>@<machine>` (remote; split at the first `@`), or null for an id with an `@` but an empty
 *  pid or machine, which is neither. */
export function machineOf(id: string): { machine: string | null } | null {
  const at = id.indexOf('@');
  if (at < 0) return { machine: null };
  const machine = id.slice(at + 1);
  return at === 0 || machine === '' ? null : { machine };
}

/** A project on another machine: one whose id carried `@<machine>`. */
export const isRemote = (p: { machine: string | null }): boolean => p.machine !== null;

/** The project list of a `projects` payload, or null when it isn't one. A project without a
 *  non-empty string `root` is kept, with `root: null` (it gets no right-click menu). Each project's
 *  machine comes from its id (`machineOf`); an id that is neither bare nor `<pid>@<machine>` is
 *  skipped, as an entry with no string id is. */
export function toProjects(v: unknown): AppProject[] | null {
  if (!isRecord(v) || !Array.isArray(v.projects)) return null;
  const out: AppProject[] = [];
  for (const p of v.projects) {
    if (!isRecord(p) || typeof p.id !== 'string') continue;
    const where = machineOf(p.id);
    if (where === null) continue;
    out.push({ id: p.id, name: str(p.name), root: typeof p.root === 'string' && p.root !== '' ? p.root : null, machine: where.machine });
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

/** A project's new jobs and epics; any config error clears. */
export const setBoard = (s: AppState, pid: string, jobs: AppJob[], epics: AppEpic[] = []): AppState => withBoard(s, pid, (b) => ({ jobs, epics, error: null, rev: b.rev + 1 }));

/** A project's config went bad: it keeps its last jobs and records the reason. */
export const setError = (s: AppState, pid: string, reason: string): AppState => withBoard(s, pid, (b) => ({ ...b, error: reason, rev: b.rev + 1 }));
