// Which boards notify. A project's first board after the Mac app starts or reconnects is its
// baseline and notifies nothing, epics included. After that, a job notifies when its `stage` moves
// into `needs-human` (from `job.escalated` or `merge.failed`) or into `merged`; a job first seen
// after the baseline notifies only if it arrives already in one of those stages. A job in an epic
// merges into the epic's branch, not its target, so its merge never notifies (its escalation does).
// An epic notifies "Epic landed" when its state moves into `landed`, and "Epic waiting on you" when
// its `waitingOn` becomes "you"; an epic first seen after the baseline notifies only if it arrives
// so. Runtime-neutral.
import { NEEDS_HUMAN } from './badge';
import type { AppEpic, AppJob } from './state';

export const MERGED = 'merged';

export interface Notice {
  kind: 'needs-human' | 'merged';
  project: string; // project id
  job: string; // job id
  title: string; // the job's title ('' if it has none yet)
  note: string; // the escalation or merge-failure reason, or "merged <sha>"
}

/** Per project id: each job id's last seen stage. A project with no entry has no baseline. */
export type Baselines = Readonly<Record<string, Readonly<Record<string, string>>>>;

export const noBaselines = (): Baselines => ({});

const noticeKind = (stage: string): Notice['kind'] | null => (stage === NEEDS_HUMAN ? 'needs-human' : stage === MERGED ? 'merged' : null);

/** Diffs a project's new board against its baseline, and returns the new baseline. */
export function diffBoard(base: Baselines, pid: string, jobs: AppJob[]): { base: Baselines; notices: Notice[] } {
  const prev = base[pid];
  const next: Record<string, string> = {};
  const notices: Notice[] = [];
  for (const j of jobs) {
    next[j.id] = j.stage;
    if (prev === undefined) continue; // the baseline board
    const kind = noticeKind(j.stage);
    if (kind === 'merged' && j.epic !== undefined) continue; // merged into its epic's branch: the epic's landing notifies
    if (kind !== null && prev[j.id] !== j.stage) notices.push({ kind, project: pid, job: j.id, title: j.title, note: j.note });
  }
  return { base: { ...base, [pid]: next }, notices };
}

/** Keeps the baselines of the listed projects only; a dropped project loses its baseline. */
export function retainProjects<T>(base: Readonly<Record<string, T>>, pids: readonly string[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const pid of pids) {
    const b = base[pid];
    if (b !== undefined) out[pid] = b;
  }
  return out;
}

export interface NoticeText {
  title: string;
  subtitle: string;
  body: string;
}

/** The words of a native notification: the job's title and its note. */
export function noticeText(n: Notice, projectName: string): NoticeText {
  const name = n.title === '' ? n.job : n.title;
  const what = n.kind === 'needs-human' ? 'needs a human' : 'merged';
  return { title: `${name} ${what}`, subtitle: projectName === '' ? n.job : `${projectName} · ${n.job}`, body: n.note };
}

// ---- epics ----

export interface EpicNotice {
  kind: 'epic-landed' | 'epic-waiting';
  project: string; // project id
  epic: string; // the epic's slug
  name: string; // its title, or its slug
  members: number;
  note: string; // the reason it waits on you
}

/** Per project id: each epic slug's last seen state and waitingOn. A project with no entry has no baseline. */
export type EpicBaselines = Readonly<Record<string, Readonly<Record<string, { state: string; waitingOn: string | null }>>>>;

export const noEpicBaselines = (): EpicBaselines => ({});

/** Diffs a project's new epics against its baseline, and returns the new baseline. */
export function diffEpics(base: EpicBaselines, pid: string, epics: readonly AppEpic[]): { base: EpicBaselines; notices: EpicNotice[] } {
  const prev = base[pid];
  const next: Record<string, { state: string; waitingOn: string | null }> = {};
  const notices: EpicNotice[] = [];
  for (const e of epics) {
    next[e.slug] = { state: e.state, waitingOn: e.waitingOn };
    if (prev === undefined) continue; // the baseline board
    const was = prev[e.slug];
    const n = { project: pid, epic: e.slug, name: e.name, members: e.members, note: e.note };
    if (e.state === 'landed' && was?.state !== 'landed') notices.push({ kind: 'epic-landed', ...n });
    if (e.waitingOn === 'you' && was?.waitingOn !== 'you') notices.push({ kind: 'epic-waiting', ...n });
  }
  return { base: { ...base, [pid]: next }, notices };
}

/** The words of an epic's notification: "Epic landed" with its name and member count, or "Epic waiting on you" with the reason. */
export function epicNoticeText(n: EpicNotice, projectName: string): NoticeText {
  const subtitle = projectName === '' ? n.name : `${projectName} · ${n.name}`;
  if (n.kind === 'epic-landed') return { title: 'Epic landed', subtitle, body: `${n.name}: ${n.members} ${n.members === 1 ? 'member' : 'members'}` };
  return { title: 'Epic waiting on you', subtitle, body: n.note };
}
