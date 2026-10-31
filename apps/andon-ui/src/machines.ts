// Machines on the board (brief andon-machines-ui; design "Machines"), pure. The hub's own machine is
// the first `GET /machines` entry. A project is remote when its `machine` differs from that name,
// never guessed from its root (brief andon-machines-mac, Defaults). With no machine list, or a list
// of the hub alone (no peers), every project is local and nothing shows any machine.
// A machine's lanes are stale while it is `down`, and through the `connecting` that follows, until
// it is `live` again. A stale machine's as-of time is the `since` of the last `down` entry seen for
// it (state.ts `lastDown`), else (the page opened while it was already connecting) its current
// `since`. Everything timed for a stale machine's jobs is computed at its as-of time, not the clock
// (decision 5: live timers come from the snapshot's timestamps, never a model).
import type { Machine, ProjectInfo } from './job';
import type { UiState } from './state';
import { clockTime, time } from './time';

/** The hub's own machine name: the first listed machine. Null with no list. */
export const hubName = (s: UiState): string | null => s.machines.list[0]?.name ?? null;

/** Whether the service follows peers: it lists more than its own machine. Otherwise nothing shows any machine. */
export const hasPeers = (s: UiState): boolean => s.machines.list.length > 1;

/** The machine a project is remote on, or null for a local project (and for every project while there are no peers). */
export function remoteOf(s: UiState, p: Pick<ProjectInfo, 'machine'>): string | null {
  if (!hasPeers(s) || p.machine === undefined) return null;
  return p.machine === hubName(s) ? null : p.machine;
}

/** The machine a listed project is remote on, by id; null for a local or unlisted project. */
export function remoteOfId(s: UiState, pid: string): string | null {
  const p = s.projects.find((x) => x.id === pid);
  return p === undefined ? null : remoteOf(s, p);
}

/** Whether a machine's lanes are stale: it is `down`, or `connecting` (after a `down`, or when first seen). */
export const isStaleState = (m: Pick<Machine, 'state'>): boolean => m.state === 'down' || m.state === 'connecting';

/** A stale machine's as-of time (ms), or null when it isn't stale (or isn't listed). */
export function machineAsOf(s: UiState, name: string): number | null {
  const m = s.machines.list.find((x) => x.name === name);
  if (m === undefined || !isStaleState(m)) return null;
  const down = Object.hasOwn(s.machines.lastDown, name) ? s.machines.lastDown[name] : undefined; // own keys only
  const t = time(down ?? m.since);
  return t > 0 ? t : null;
}

/** A project's as-of time: its remote machine's, while that machine is stale; null otherwise. */
export function projectAsOf(s: UiState, pid: string): number | null {
  const remote = remoteOfId(s, pid);
  return remote === null ? null : machineAsOf(s, remote);
}

/** The time a project's timers are computed at: its as-of time while its machine is stale, else `now`. */
export const nowFor = (s: UiState, pid: string, now: number): number => projectAsOf(s, pid) ?? now;

/** Where a project is: the machine it is remote on (absent when local), and its as-of time (absent unless stale). */
export interface Placement {
  remote?: string;
  asOf?: number;
}

/** Each project with its placement: `remote` for a remote one, and `asOf` while its machine is stale. */
export function placed<P extends Pick<ProjectInfo, 'id' | 'machine'>>(s: UiState, projects: readonly P[]): Array<P & Placement> {
  return projects.map((p) => {
    const remote = remoteOf(s, p);
    if (remote === null) return p;
    const asOf = machineAsOf(s, remote);
    return asOf === null ? { ...p, remote } : { ...p, remote, asOf };
  });
}

/** A project's label: "<name> · <machine>" for a remote project, "<name>" for a local one. */
export const projectLabel = (p: { name: string; remote?: string }): string => (p.remote === undefined ? p.name : `${p.name} · ${p.remote}`);

/** A stale lane's "as of 14:02" ("as of Oct 29 14:02" when not today). */
export const asOfText = (asOf: number, now: number): string => `as of ${clockTime(asOf, now)}`;

/** Whether an `error` machine's reason names `factory upgrade` (a peer from before the hub). */
export const needsUpgrade = (m: Pick<Machine, 'state' | 'reason'>): boolean => m.state === 'error' && m.reason !== null && m.reason.includes('factory upgrade');

/**
 * A machine's trouble, for its sidebar heading and the footer: "down since 14:02", "needs upgrade",
 * or "error" (red); "connecting…" (gray); null when `live`.
 */
export function machineStateText(m: Machine, now: number): { text: string; tone: 'red' | 'gray' } | null {
  switch (m.state) {
    case 'live':
      return null;
    case 'connecting':
      return { text: 'connecting…', tone: 'gray' };
    case 'down':
      return { text: `down since ${clockTime(time(m.since), now)}`, tone: 'red' };
    case 'error':
      return { text: needsUpgrade(m) ? 'needs upgrade' : 'error', tone: 'red' };
  }
}

/** The machines in sidebar order: the hub first, then the peers by name. */
export function machineOrder(list: readonly Machine[]): Machine[] {
  const [hub, ...peers] = list;
  if (hub === undefined) return [];
  return [hub, ...[...peers].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name))];
}
