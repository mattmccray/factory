// Which boards notify. A project's first board after the shell starts or reconnects is its
// baseline and notifies nothing. After that, a job notifies when its `stage` moves into
// `needs-human` (from `job.escalated` or `merge.failed`) or into `merged`; a job first seen after
// the baseline notifies only if it arrives already in one of those stages. Runtime-neutral.
import { NEEDS_HUMAN } from './badge';
import type { ShellJob } from './state';

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
export function diffBoard(base: Baselines, pid: string, jobs: ShellJob[]): { base: Baselines; notices: Notice[] } {
  const prev = base[pid];
  const next: Record<string, string> = {};
  const notices: Notice[] = [];
  for (const j of jobs) {
    next[j.id] = j.stage;
    if (prev === undefined) continue; // the baseline board
    const kind = noticeKind(j.stage);
    if (kind !== null && prev[j.id] !== j.stage) notices.push({ kind, project: pid, job: j.id, title: j.title, note: j.note });
  }
  return { base: { ...base, [pid]: next }, notices };
}

/** Keeps the baselines of the listed projects only; a dropped project loses its baseline. */
export function retainProjects(base: Baselines, pids: readonly string[]): Baselines {
  const out: Record<string, Readonly<Record<string, string>>> = {};
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
