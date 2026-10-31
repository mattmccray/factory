// UI state: every registered project and its last board, driven by the service's
// `GET /events?settled=summary` stream (`projects`, `board`, `error`) and one
// `GET /projects/<pid>/board?settled=summary` per project when the project list arrives. A board
// is narrow: its unsettled jobs, its config, and a settled summary. A project's settled jobs are
// fetched only when a view needs them (`GET /projects/<pid>/settled`) and cached per project.
// Epics ride along: a board's `epics` are its unsettled epics, and `/settled` returns `{ jobs, epics }`.
// The service's release (`{ running, onDisk, changelog }`) arrives as the `release` event and from one
// `GET /release` per `projects` event; an older service sends neither, and the slot stays empty.
// The backlog (brief andon-backlog-ui) rides the same way: a narrow board's `backlog` counts, and
// each project's `GET /projects/<pid>/backlog` lists, fetched only while a view needs them and
// cached per project with a rev guard, so a slower, older response never overwrites a newer one.
// Machines (brief andon-machines-ui) ride the same way: the `machines` event and one `GET /machines`
// per `projects` event, with a rev guard; a service from before the hub sends neither (a 404), and
// the list stays empty, so every project is local. The slot also remembers, per machine, the `since`
// of the last `down` entry seen, which a stale machine's lanes are frozen at (machines.ts).
// Every update returns a new state; nothing here touches the DOM.
import { NO_BACKLOG, toBacklog, toBacklogCounts } from './backlog';
import type { BacklogCounts, BacklogList } from './backlog';
import { isRecord, toConfig, toEpics, toJobs, toMachines, toProjects } from './job';
import type { BoardConfig, Epic, Job, Machine, ProjectInfo } from './job';
import { toReleaseInfo } from './release';
import type { ReleaseInfo } from './release';

/**
 * A narrow board's settled summary: how many jobs settled, the newest settled merge's `endedAt`,
 * and how many epics settled. `epics` is absent when the service sent none (one from before
 * epics): it reads as 0.
 */
export interface SettledSummary {
  count: number;
  lastMergedAt: string | null;
  epics?: number;
}

export interface ProjectBoard {
  jobs: Job[];
  epics: Epic[]; // its epics on the board (unsettled); [] when the board has none
  config: BoardConfig;
  settled: SettledSummary;
  backlog: BacklogCounts; // its narrow board's backlog counts; none ({ queued: 0, exploring: 0 }) when absent or malformed
  error: string | null; // `config.json: <reason>` while the project's config is bad
  loaded: boolean; // a board has arrived at least once
  rev: number; // bumped by every board or error, so a slower fetch can't overwrite a newer event
}

/** One project's cached settled list. */
export interface SettledList {
  status: 'loading' | 'loaded' | 'failed';
  jobs: Job[] | null; // the last list that arrived; null until one has
  epics: Epic[] | null; // the settled epics that came with it; null until a list has arrived
  reason: string | null; // why the last fetch failed
  summary: SettledSummary; // the board's summary when the last fetch was sent
  rev: number; // bumped by every fetch, so only the newest one applies
}

/** The service's release: null until one arrives (or while the service sends none); `rev` as a board's. */
export interface ReleaseSlot {
  info: ReleaseInfo | null;
  rev: number; // bumped by every `release` event, so a slower `GET /release` can't overwrite a newer event
}

/**
 * The machines the service follows (`GET /machines`): empty until a list arrives (and for a service
 * from before the hub); `rev` as the release's. `lastDown` is, per machine name, the `since` of the
 * last `down` entry seen for it, kept until it is `live` again (the as-of time of its stale lanes).
 */
export interface MachinesSlot {
  list: Machine[];
  rev: number; // bumped by every `machines` event, so a slower `GET /machines` can't overwrite a newer event
  lastDown: Record<string, string>;
}

export interface UiState {
  projects: ProjectInfo[];
  boards: Record<string, ProjectBoard>;
  settled: Record<string, SettledList>;
  backlogs: Record<string, BacklogList>; // each project's cached backlog lists, fetched on demand
  release: ReleaseSlot;
  machines: MachinesSlot;
}

export const NO_SETTLED: SettledSummary = { count: 0, lastMergedAt: null };

export const emptyState = (): UiState => ({ projects: [], boards: {}, settled: {}, backlogs: {}, release: { info: null, rev: 0 }, machines: { list: [], rev: 0, lastDown: {} } });
const emptyBoard = (): ProjectBoard => ({ jobs: [], epics: [], config: toConfig(null), settled: NO_SETTLED, backlog: NO_BACKLOG, error: null, loaded: false, rev: 0 });
const known = (s: UiState, pid: string): boolean => s.projects.some((p) => p.id === pid);
const boardOf = (s: UiState, pid: string): ProjectBoard => s.boards[pid] ?? emptyBoard();

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/**
 * A board's `settled` summary; anything but `{ count: <non-negative integer>, lastMergedAt: <string | null> }`
 * (an older service) is none. Its `epics` is kept when it is a non-negative integer, and left out otherwise.
 */
export function toSummary(v: unknown): SettledSummary {
  if (!isRecord(v)) return NO_SETTLED;
  const { count, lastMergedAt, epics } = v;
  if (!isCount(count)) return NO_SETTLED;
  if (lastMergedAt !== null && typeof lastMergedAt !== 'string') return NO_SETTLED;
  return isCount(epics) ? { count, lastMergedAt, epics } : { count, lastMergedAt };
}

/** A summary's settled epics: its `epics`, or 0 when it has none. */
export const settledEpicCount = (s: SettledSummary): number => s.epics ?? 0;

export const sameSummary = (a: SettledSummary, b: SettledSummary): boolean => a.count === b.count && a.lastMergedAt === b.lastMergedAt && settledEpicCount(a) === settledEpicCount(b);

function withBoard(s: UiState, pid: string, next: (b: ProjectBoard) => ProjectBoard): UiState {
  if (!known(s, pid)) return s; // a board for a project that isn't listed is ignored
  return { ...s, boards: { ...s.boards, [pid]: next(boardOf(s, pid)) } };
}

/** Replaces the project list. Boards, settled lists, and backlogs of listed projects are kept; the rest are dropped. */
export function setProjects(s: UiState, projects: ProjectInfo[]): UiState {
  const boards: Record<string, ProjectBoard> = {};
  const settled: Record<string, SettledList> = {};
  const backlogs: Record<string, BacklogList> = {};
  for (const p of projects) {
    boards[p.id] = boardOf(s, p.id);
    const list = s.settled[p.id];
    if (list !== undefined) settled[p.id] = list;
    const backlog = s.backlogs[p.id];
    if (backlog !== undefined) backlogs[p.id] = backlog;
  }
  return { ...s, projects, boards, settled, backlogs };
}

/** A project's new board: its jobs, epics, config, and settled summary change, and any config error clears. */
export const setBoard = (s: UiState, pid: string, data: unknown): UiState =>
  withBoard(s, pid, (b) => ({
    jobs: toJobs(isRecord(data) ? data.jobs : null),
    epics: toEpics(isRecord(data) ? data.epics : null),
    config: toConfig(isRecord(data) ? data.config : null),
    settled: toSummary(isRecord(data) ? data.settled : null),
    backlog: toBacklogCounts(isRecord(data) ? data.backlog : null),
    error: null,
    loaded: true,
    rev: b.rev + 1,
  }));

/** A project's config went bad: it shows the reason and keeps its last board. */
export const setError = (s: UiState, pid: string, reason: string): UiState => withBoard(s, pid, (b) => ({ ...b, error: reason, loaded: true, rev: b.rev + 1 }));

/**
 * A new machine list, at `rev`: each `down` entry records its `since` as the machine's last-seen
 * down time, a `live` one clears it, and any other state keeps it; a machine no longer listed is forgotten.
 */
function setMachines(s: UiState, list: Machine[], rev: number): UiState {
  const lastDown: Record<string, string> = {};
  for (const m of list) {
    const seen = m.state === 'down' ? m.since : m.state === 'live' ? undefined : s.machines.lastDown[m.name];
    if (seen !== undefined) lastDown[m.name] = seen;
  }
  return { ...s, machines: { list, rev, lastDown } };
}

/** Applies one `GET /events` event. Unknown events and malformed data leave the state as is. */
export function applyEvent(s: UiState, event: string, data: unknown): UiState {
  if (event === 'projects') return isRecord(data) && Array.isArray(data.projects) ? setProjects(s, toProjects(data)) : s;
  if (event === 'machines') {
    const list = toMachines(data);
    return list === null ? s : setMachines(s, list, s.machines.rev + 1);
  }
  if (event === 'release') {
    const info = toReleaseInfo(data);
    return info === null ? s : { ...s, release: { info, rev: s.release.rev + 1 } };
  }
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

/** The release `rev` to pass back with a fetched `GET /release`, read when the request is sent. */
export const releaseRev = (s: UiState): number => s.release.rev;

/**
 * Applies a fetched `GET /release` unless a `release` event arrived since `rev`. A failed fetch (a
 * 404 from an older service, any other non-2xx) or a malformed body is no release data.
 */
export function applyFetchedRelease(s: UiState, rev: number, result: { ok: true; data: unknown } | { ok: false; reason: string }): UiState {
  if (s.release.rev !== rev) return s;
  const info = result.ok ? toReleaseInfo(result.data) : null;
  if (info === null && s.release.info === null) return s;
  return { ...s, release: { info, rev } };
}

/** The machines `rev` to pass back with a fetched `GET /machines`, read when the request is sent. */
export const machinesRev = (s: UiState): number => s.machines.rev;

/**
 * Applies a fetched `GET /machines` unless a `machines` event arrived since `rev`. A failed fetch (a
 * 404 from a service from before the hub, any other non-2xx) or a malformed body changes nothing.
 */
export function applyFetchedMachines(s: UiState, rev: number, result: { ok: true; data: unknown } | { ok: false; reason: string }): UiState {
  if (s.machines.rev !== rev || !result.ok) return s;
  const list = toMachines(result.data);
  return list === null ? s : setMachines(s, list, rev);
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
  const list: SettledList = { status: 'loading', jobs: prev?.jobs ?? null, epics: prev?.epics ?? null, reason: null, summary: boardOf(s, pid).settled, rev };
  return { state: { ...s, settled: { ...s.settled, [pid]: list } }, rev };
}

/** Applies a fetched settled list (`{ jobs, epics }`; a missing `epics` is `[]`) or its error, unless a newer fetch was sent since `rev` or the project is gone. */
export function applySettled(s: UiState, pid: string, rev: number, result: { ok: true; data: unknown } | { ok: false; reason: string }): UiState {
  const list = s.settled[pid];
  if (list === undefined || list.rev !== rev || !known(s, pid)) return s;
  const next: SettledList = result.ok
    ? { ...list, status: 'loaded', jobs: toJobs(isRecord(result.data) ? result.data.jobs : null), epics: toEpics(isRecord(result.data) ? result.data.epics : null), reason: null }
    : { ...list, status: 'failed', reason: result.reason };
  return { ...s, settled: { ...s.settled, [pid]: next } };
}

/** Whether a project's settled list is loaded for its board's current summary: nothing newer can be missing from it. */
export function settledCurrent(s: UiState, pid: string): boolean {
  const b = s.boards[pid];
  const list = s.settled[pid];
  return b !== undefined && b.loaded && list !== undefined && list.status === 'loaded' && sameSummary(list.summary, b.settled);
}

// ---- backlogs ----

/** Marks a project's backlog as being (re)fetched; the last list stays shown meanwhile. Returns the new state and the fetch's `rev`. */
export function startBacklog(s: UiState, pid: string): { state: UiState; rev: number } {
  const prev = s.backlogs[pid];
  const rev = (prev?.rev ?? 0) + 1;
  if (!known(s, pid)) return { state: s, rev };
  const list: BacklogList = { status: 'loading', queued: prev?.queued ?? null, exploring: prev?.exploring ?? null, reason: null, rev };
  return { state: { ...s, backlogs: { ...s.backlogs, [pid]: list } }, rev };
}

/** Applies a fetched backlog (`{ queued, exploring }`) or its error, replacing the list, unless a newer fetch was sent since `rev` or the project is gone. */
export function applyBacklog(s: UiState, pid: string, rev: number, result: { ok: true; data: unknown } | { ok: false; reason: string }): UiState {
  const list = s.backlogs[pid];
  if (list === undefined || list.rev !== rev || !known(s, pid)) return s;
  const next: BacklogList = result.ok ? { ...list, status: 'loaded', ...toBacklog(result.data), reason: null } : { ...list, status: 'failed', reason: result.reason };
  return { ...s, backlogs: { ...s.backlogs, [pid]: next } };
}
