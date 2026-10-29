// The Assembly Lines model (design §5–§7): one lane per registered project across six station
// columns. It derives each job's kind (the §5 table), the column it sits in, the dashed ghost a
// needs-human job leaves where it stopped, lane tiers and order ("move only on a tier change"),
// the gutter's meta, idle lanes, crowded cells (cap 3 plus "+N more", uncapped when focused), lane
// height in token rows, the tokens and their popover, and a focused project's recent activity.
// Pure: it takes board jobs, each project's settled summary, and `now`; Lines.svelte, Lane.svelte,
// and Token.svelte only lay it out. Settled jobs are never on a lane: a lane counts them (its
// summary plus held jobs that settled on screen) and links to the Settled sheet.
import { chipRounds, isSettled, mergedAt, roundKeys } from './board';
import type { BoardJob } from './board';
import type { Job, WorkingStage } from './job';
import type { SettledSummary } from './state';
import { chipLabel, time } from './time';

// ---- kinds ----

export type Kind = 'needs-human' | 'merge-failed' | 'review-failed' | 'reviewing' | 'approve' | 'build' | 'spec' | 'claimed' | 'merged' | 'settled' | 'abandoned';

/** The kinds that wait on a human (the Andon column, red). */
export const isHuman = (k: Kind): boolean => k === 'needs-human' || k === 'merge-failed';

/** §5 review-failed: stage `review`, every current-round verdict is in (none pending), and at least one is CHANGES. */
export function isReviewFailed(j: Job): boolean {
  if (j.stage !== 'review') return false;
  const verdicts = Object.values(j.reviews);
  return verdicts.length > 0 && !verdicts.includes('pending') && verdicts.includes('CHANGES');
}

/**
 * Whether a needs-human job stopped on a failed merge: `stoppedBy`, or, for a snapshot written
 * before it (null), a `decision` of `APPROVE`, which can only mean the approver approved and the
 * merge failed.
 */
const mergeFailed = (j: Job): boolean => (j.stoppedBy !== null ? j.stoppedBy === 'merge-failed' : j.decision === 'APPROVE');

/** A job's kind at `now` (design §5). Merged settles after its own project's `settleAfterHours`. */
export function kindOf(b: BoardJob, now: number): Kind {
  const j = b.job;
  switch (j.stage) {
    case 'needs-human':
      return mergeFailed(j) ? 'merge-failed' : 'needs-human';
    case 'review':
      return isReviewFailed(j) ? 'review-failed' : 'reviewing';
    case 'approve':
    case 'build':
    case 'spec':
    case 'claimed':
      return j.stage;
    case 'merged':
      return isSettled(b, now) ? 'settled' : 'merged';
    case 'abandoned':
      return 'abandoned';
    default:
      return 'claimed'; // a stage a later v1 adds: shown at the start of the line
  }
}

/** The short sha of a merged job: its `note` without the `merged ` prefix the contract writes. */
export const shaOf = (j: Job): string => (j.note.startsWith('merged ') ? j.note.slice('merged '.length).trim() : '');

/** A token's line-2 tag (design §6), or null for the kinds that show none (a merged token is one line: no tag). */
export function tagOf(j: Job, kind: Kind): string | null {
  switch (kind) {
    case 'needs-human':
      return j.stoppedBy === null && j.decision === 'APPROVE (human)' ? 'Approved · not merged' : 'Escalated';
    case 'merge-failed':
      return 'Merge failed';
    case 'review-failed':
      return 'Changes';
    case 'build':
      return j.round > 0 ? `Rework → R${j.round + 1}` : 'Building';
    case 'spec':
      return 'Drafting spec';
    case 'claimed':
      return 'Claimed';
    case 'abandoned':
      return 'Abandoned';
    default:
      return null; // reviewing, approve, merged, settled
  }
}

/** What each kind is called, in the popover and for screen readers. */
export const KIND_LABELS: Record<Kind, string> = {
  'needs-human': 'Needs a human',
  'merge-failed': 'Merge failed',
  'review-failed': 'Review failed',
  reviewing: 'In review',
  approve: 'At approver',
  build: 'Building',
  spec: 'Writing spec',
  claimed: 'Claimed',
  merged: 'Merged',
  settled: 'Settled',
  abandoned: 'Abandoned',
};

/**
 * Each kind's non-color mark (design §6, "never by color alone"): its icon or edge treatment.
 * Token.svelte draws it; no two kinds share one.
 */
export type Shape = 'flag' | 'merge-hatch' | 'changes' | 'pending' | 'seal' | 'progress' | 'hatch' | 'dashed' | 'check' | 'faded' | 'none';
const SHAPES: Record<Kind, Shape> = {
  'needs-human': 'flag',
  'merge-failed': 'merge-hatch',
  'review-failed': 'changes',
  reviewing: 'pending',
  approve: 'seal',
  build: 'progress',
  spec: 'hatch',
  claimed: 'dashed',
  merged: 'check',
  settled: 'faded',
  abandoned: 'none',
};

// ---- columns ----

export type Column = 'andon' | 'spec' | 'build' | 'review' | 'approve' | 'merged';

export interface ColumnInfo {
  key: Column;
  name: string;
  who: string; // the role under the name
}

export const COLUMNS: readonly ColumnInfo[] = [
  { key: 'andon', name: 'Andon', who: 'needs a human' },
  { key: 'spec', name: 'Spec', who: 'spec-writer' },
  { key: 'build', name: 'Build', who: 'builder' },
  { key: 'review', name: 'Review', who: 'reviewers' },
  { key: 'approve', name: 'Approve', who: 'approver' },
  { key: 'merged', name: 'Merged', who: 'last 24 hours' },
];

/** The column a kind sits in; settled and abandoned jobs are never on the board. */
export function columnOf(kind: Kind): Column | null {
  switch (kind) {
    case 'needs-human':
    case 'merge-failed':
      return 'andon';
    case 'claimed':
    case 'spec':
      return 'spec';
    case 'reviewing':
    case 'review-failed':
      return 'review';
    case 'build':
    case 'approve':
      return kind;
    case 'merged':
      return 'merged';
    default:
      return null;
  }
}

const WORKING: readonly WorkingStage[] = ['claimed', 'spec', 'build', 'review', 'approve'];
const stageColumn = (stage: WorkingStage): Column => (stage === 'claimed' ? 'spec' : stage);

/** The working stage a needs-human job stopped from: `stoppedFrom`, else the last working stage in `timing.stages` before needs-human. */
function stoppedAt(j: Job): WorkingStage | null {
  if (j.stoppedFrom !== null) return j.stoppedFrom;
  const stages = j.timing?.stages ?? [];
  let i = stages.length - 1;
  while (i >= 0 && stages[i]?.stage !== 'needs-human') i--;
  for (i--; i >= 0; i--) {
    const s = WORKING.find((w) => w === stages[i]?.stage);
    if (s !== undefined) return s;
  }
  return null;
}

/** The job number: the id's leading digits ("040"), or the whole id when it has none. */
export const numOf = (id: string): string => /^\d+/.exec(id)?.[0] ?? id;

export interface Ghost {
  key: string; // the job it opens
  column: Column;
  num: string;
  text: string; // "stopped here → Andon" or "merge broke here → Andon"
  label: string; // "<num> <text>"
}

/** The dashed ghost a needs-human job leaves where it stopped, or null (not needs-human, or nowhere to put it). */
export function ghostOf(b: BoardJob): Ghost | null {
  if (b.job.stage !== 'needs-human') return null;
  const from = stoppedAt(b.job);
  if (from === null) return null;
  const num = numOf(b.job.id);
  const text = mergeFailed(b.job) ? 'merge broke here → Andon' : 'stopped here → Andon';
  return { key: b.key, column: stageColumn(from), num, text, label: `${num} ${text}` };
}

// ---- tokens ----

/** A compact age: 42s, 12m, 11h 40m, 3d 12h. */
export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  if (s < 60) return `${s}s`;
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

/** The largest unit of `age` only, floored: 42s, 45m, 1h (for 1h 59m), 2d (for 2d 23h). A merged token's time. */
export function shortAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  if (s < 60) return `${s}s`;
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

export interface Chip {
  key: string; // the reviewer key
  label: string; // two letters
  verdict: string; // PASS, CHANGES, pending, or a value a later v1 adds
  pulse: boolean; // pending while the job is in review
}

function chipsOf(reviews: Record<string, string>, reviewers: readonly string[], live: boolean): Chip[] {
  return roundKeys(reviews, reviewers).map((key) => {
    const verdict = reviews[key] ?? 'pending';
    return { key, label: chipLabel(key), verdict, pulse: live && verdict === 'pending' };
  });
}

export interface TokenModel {
  key: string;
  kind: Kind;
  shape: Shape;
  label: string; // the kind's name, for screen readers
  num: string;
  title: string;
  tag: string | null;
  chips: Chip[]; // the current round's verdicts, in project reviewer order
  round: string | null; // "R1/2"; null for a merged or settled job (one line)
  time: string | null; // time in stage, or the largest-unit time since the merge ("1h") for a merged or settled job; null for a legacy job
  note: string | null; // line 3: needs-human and merge-failed only
  branch: string;
}

/** Kinds whose line 2 shows the current round's chips (the others are full with their tag, note, or sha). */
const CHIPPED = new Set<Kind>(['reviewing', 'review-failed', 'approve', 'build']);

/** The line-1 title: the job's title, or (until the spec names it) its id without the number. */
const titleOf = (j: Job): string => (j.title === j.id ? j.id.replace(/^\d+-/, '') : j.title);

/** The popover's time: time in stage, or the full "<age> ago" since the merge. */
const sinceText = (j: Job, kind: Kind, now: number): string | null => {
  if (kind === 'merged' || kind === 'settled') {
    const t = mergedAt(j);
    return t > 0 ? `${age(now - t)} ago` : null;
  }
  return j.stageEnteredAt === null ? null : age(now - time(j.stageEnteredAt));
};

/** The token's time: time in stage, or for a merged or settled job the largest unit since the merge ("1h", no "ago"). */
const tokenTime = (j: Job, kind: Kind, now: number): string | null => {
  if (kind !== 'merged' && kind !== 'settled') return sinceText(j, kind, now);
  const t = mergedAt(j);
  return t > 0 ? shortAge(now - t) : null;
};

/** One job's token. A merged or settled token is one line (number, title, time): no tag, chips, round, or note. */
export function tokenOf(b: BoardJob, now: number): TokenModel {
  const j = b.job;
  const kind = kindOf(b, now);
  const merged = kind === 'merged' || kind === 'settled';
  return {
    key: b.key,
    kind,
    shape: SHAPES[kind],
    label: KIND_LABELS[kind],
    num: numOf(j.id),
    title: titleOf(j),
    tag: tagOf(j, kind),
    chips: CHIPPED.has(kind) && j.round > 0 ? chipsOf(j.reviews, b.reviewers, kind === 'reviewing') : [],
    round: !merged && j.round > 0 ? `R${j.round}/${j.maxRound ?? 2}` : null,
    time: tokenTime(j, kind, now),
    note: isHuman(kind) && j.note !== '' ? j.note : null,
    branch: j.branch || `factory/${j.id}`,
  };
}

export interface Popover {
  title: string;
  where: string; // "<project> · <id>"
  stage: string;
  timeLabel: 'In stage' | 'Merged';
  time: string | null;
  round: string; // "2 of 2", or "— of 2" before the first review
  rounds: Array<{ round: number; chips: Chip[] }>;
  note: string | null;
}

/** The hover popover (design §6): title, project · id, stage, time in stage, round, each round's verdicts, and the note. */
export function popoverOf(b: BoardJob, now: number): Popover {
  const j = b.job;
  const kind = kindOf(b, now);
  const merged = kind === 'merged' || kind === 'settled';
  const max = j.maxRound ?? 2;
  return {
    title: j.title,
    where: `${b.project.name} · ${j.id}`,
    stage: KIND_LABELS[kind],
    timeLabel: merged ? 'Merged' : 'In stage',
    time: sinceText(j, kind, now),
    round: `${j.round > 0 ? j.round : '—'} of ${max}`,
    rounds: chipRounds(j).map((r) => ({ round: r.round, chips: chipsOf(r.reviews, b.reviewers, kind === 'reviewing' && !r.past) })),
    note: j.note !== '' ? j.note : null,
  };
}

// ---- lanes ----

export type LaneState = 'needs-human' | 'review-failed' | 'active' | 'idle';
export type LaneDot = 'red' | 'orange' | 'blue' | 'gray';
const LANE_DOTS: Record<LaneState, LaneDot> = { 'needs-human': 'red', 'review-failed': 'orange', active: 'blue', idle: 'gray' };

export interface Cell {
  column: Column;
  tokens: TokenModel[]; // newest first
  more: number; // jobs past the cap ("+N more"); 0 when focused
  ghosts: Ghost[];
}

export interface GutterMeta {
  active: string; // "2 active · 11h 40m" (the oldest claim among active jobs)
  trouble: { tone: 'red' | 'orange'; text: string } | null; // "1 at Andon", else "1 sent back"
  settled: number; // the "N settled" link: the summary's count plus held jobs that settled on screen
}

export interface Lane {
  project: { id: string; name: string };
  index: number; // registration order
  idle: boolean; // no job that isn't settled
  tier: string; // the lane moves only when this changes
  counts: { human: number; failed: number; active: number };
  dot: LaneDot; // the project's worst state, as the sidebar's dot
  state: LaneState;
  meta: GutterMeta;
  cells: Cell[]; // one per column, in COLUMNS order
  rows: number; // the lane's height in token rows; 0 for a collapsed idle lane
  lastMergeAt: number | null; // the later of the summary's lastMergedAt and any merge held on the board
  idleText: string; // "Idle · last merge 3d 12h ago"
}

/** Tokens a cell shows in All Projects before "+N more". */
export const CELL_CAP = 3;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Newest first: by when the job entered its stage (a merged job: its merge), then by key. */
const newest = (a: BoardJob, b: BoardJob): number => {
  const t = (x: BoardJob): number => (x.job.stage === 'merged' ? mergedAt(x.job) : time(x.job.stageEnteredAt ?? x.job.updated));
  return t(b) - t(a) || a.key.localeCompare(b.key);
};

function laneOf(project: { id: string; name: string }, index: number, jobs: readonly BoardJob[], now: number, focused: boolean, summary: SettledSummary): Lane {
  const kinds = new Map(jobs.map((b) => [b.key, kindOf(b, now)]));
  const k = (b: BoardJob): Kind => kinds.get(b.key) ?? 'claimed';
  const live = jobs.filter((b) => k(b) !== 'settled' && k(b) !== 'abandoned');
  const active = live.filter((b) => k(b) !== 'merged');
  const human = active.filter((b) => isHuman(k(b))).length;
  const failed = active.filter((b) => k(b) === 'review-failed').length;
  const settled = summary.count + jobs.filter((b) => k(b) === 'settled' || k(b) === 'abandoned').length;
  const idle = live.length === 0;
  const working = active.length - human;
  const state: LaneState = human > 0 ? 'needs-human' : failed > 0 ? 'review-failed' : working > 0 ? 'active' : 'idle';

  const claims = active.map((b) => b.job.startedAt).filter((s): s is string => s !== null).map(time);
  const oldest = claims.length > 0 ? Math.min(...claims) : null;
  const meta: GutterMeta = {
    active: `${active.length} active${oldest !== null ? ` · ${age(now - oldest)}` : ''}`,
    trouble: human > 0 ? { tone: 'red', text: `${human} at Andon` } : failed > 0 ? { tone: 'orange', text: `${failed} sent back` } : null,
    settled,
  };

  const merges = [...jobs.filter((b) => b.job.stage === 'merged').map((b) => mergedAt(b.job)), summary.lastMergedAt === null ? 0 : time(summary.lastMergedAt)].filter((t) => t > 0);
  const lastMergeAt = merges.length > 0 ? Math.max(...merges) : null;

  const ghosts = active.map(ghostOf).filter((g): g is Ghost => g !== null);
  const cells = COLUMNS.map((c): Cell => {
    const sorted = live.filter((b) => columnOf(k(b)) === c.key).sort(newest);
    const shown = focused ? sorted : sorted.slice(0, CELL_CAP);
    return {
      column: c.key,
      tokens: shown.map((b) => tokenOf(b, now)),
      more: sorted.length - shown.length,
      ghosts: ghosts.filter((g) => g.column === c.key),
    };
  });
  const fullest = Math.max(0, ...cells.map((c) => c.tokens.length));
  const overflow = cells.some((c) => c.more > 0);
  const rows = idle && !focused ? 0 : Math.max(1, fullest + (overflow ? 1 : 0));

  return {
    project,
    index,
    idle,
    tier: `${idle ? 'idle' : 'live'}|${human}|${failed}`,
    counts: { human, failed, active: active.length },
    dot: LANE_DOTS[state],
    state,
    meta,
    cells,
    rows,
    lastMergeAt,
    idleText: lastMergeAt !== null ? `Idle · last merge ${age(now - lastMergeAt)} ago` : 'Idle · no merges yet',
  };
}

/**
 * One lane per project, in registration order (`orderLanes` sorts them). `focused` is a single
 * focused project: its cells are uncapped. `summaries` are the projects' settled summaries (a
 * missing one is none); settled jobs never sit in a cell, focused or not.
 */
export function buildLanes(
  projects: ReadonlyArray<{ id: string; name: string }>,
  jobs: readonly BoardJob[],
  now: number,
  focused: boolean,
  summaries: Readonly<Record<string, SettledSummary>> = {},
): Lane[] {
  return projects.map((p, i) => laneOf({ id: p.id, name: p.name }, i, jobs.filter((b) => b.project.id === p.id), now, focused, summaries[p.id] ?? { count: 0, lastMergedAt: null }));
}

/** §5 lane order: non-idle first, then more needs-human, more review-failed, more active, then registration order. */
export function compareLanes(a: Lane, b: Lane): number {
  return Number(a.idle) - Number(b.idle) || b.counts.human - a.counts.human || b.counts.failed - a.counts.failed || b.counts.active - a.counts.active || a.index - b.index;
}

/** The order last shown: each lane's id and the tier it had then. */
export interface LaneOrder {
  ids: string[];
  tiers: Record<string, string>;
}

/**
 * Orders lanes. With no previous order (on load), it is the §5 sort. Afterward a lane keeps its
 * place unless its tier changed (or it is new): those lanes are taken out and each is put back
 * before the first lane it sorts ahead of. A job finishing a stage never reshuffles lanes.
 */
export function orderLanes(lanes: readonly Lane[], prev: LaneOrder | null): { lanes: Lane[]; order: LaneOrder } {
  let out: Lane[];
  if (prev === null) out = [...lanes].sort(compareLanes);
  else {
    const byId = new Map(lanes.map((l) => [l.project.id, l]));
    out = prev.ids.map((id) => byId.get(id)).filter((l): l is Lane => l !== undefined && prev.tiers[l.project.id] === l.tier);
    const kept = new Set(out.map((l) => l.project.id));
    const movers = lanes.filter((l) => !kept.has(l.project.id)).sort(compareLanes);
    for (const m of movers) {
      const i = out.findIndex((l) => compareLanes(m, l) < 0);
      if (i < 0) out.push(m);
      else out.splice(i, 0, m);
    }
  }
  return { lanes: out, order: { ids: out.map((l) => l.project.id), tiers: Object.fromEntries(out.map((l) => [l.project.id, l.tier])) } };
}

export interface Header {
  corner: string; // "10 active · 2 idle"
  columns: Array<ColumnInfo & { count: number }>;
}

/** The sticky header: the gutter's "N active · M idle", and each column's job count and role. Merged's role uses the smallest settleAfterHours shown. */
export function headerOf(lanes: readonly Lane[], settleHours: readonly number[]): Header {
  const idle = lanes.filter((l) => l.idle).length;
  const hours = settleHours.length > 0 ? Math.min(...settleHours) : 24;
  return {
    corner: `${lanes.length - idle} active · ${idle} idle`,
    columns: COLUMNS.map((c, i) => ({
      ...c,
      who: c.key === 'merged' ? (hours === 1 ? 'last hour' : `last ${hours} hours`) : c.who,
      count: lanes.reduce((n, l) => {
        const cell = l.cells[i];
        return n + (cell === undefined ? 0 : cell.tokens.length + cell.more);
      }, 0),
    })),
  };
}

// ---- recent activity (a focused project) ----

export interface ActivityItem {
  at: number;
  num: string;
  text: string; // "entered review", "R2 ui: PASS", "merged 3c9e01a"
  key: string; // the job it opens
  tone: 'red' | 'orange' | null; // a needs-human entry, or a CHANGES verdict
}

export const ACTIVITY_LIMIT = 14;

/**
 * A project's recent activity, derived from the snapshots of its unsettled and settled jobs
 * together (a focused project's held jobs plus its fetched settled list): stage entries from `timing.stages`,
 * reviewer verdicts from `timing.agents`, and each merge (`endedAt` and the sha from `note`).
 * A job with no `timing` (legacy) adds only its merge. Newest first, the last `limit` items.
 */
export function activity(jobs: readonly BoardJob[], limit: number = ACTIVITY_LIMIT): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const b of jobs) {
    const j = b.job;
    const num = numOf(j.id);
    for (const s of j.timing?.stages ?? []) {
      if (s.stage === 'merged') continue; // the merge is its own item
      out.push({ at: time(s.enteredAt), num, text: `entered ${s.stage}`, key: b.key, tone: s.stage === 'needs-human' ? 'red' : null });
    }
    for (const a of j.timing?.agents ?? []) {
      if (a.role !== 'reviewer' || a.finishedAt === null || a.verdict === null) continue;
      out.push({ at: time(a.finishedAt), num, text: `R${a.round ?? j.round} ${a.key ?? 'reviewer'}: ${a.verdict}`, key: b.key, tone: a.verdict === 'CHANGES' ? 'orange' : null });
    }
    if (j.stage === 'merged' && mergedAt(j) > 0) {
      const sha = shaOf(j);
      out.push({ at: mergedAt(j), num, text: sha !== '' ? `merged ${sha}` : 'merged', key: b.key, tone: null });
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}
