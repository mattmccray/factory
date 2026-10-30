// The Assembly Lines model (design §5–§7): one lane per registered project across six station
// columns. It derives each job's kind (the §5 table), the column it sits in, the dashed ghost a
// needs-human job leaves where it stopped, lane tiers and order ("move only on a tier change"),
// the gutter's meta, idle lanes, crowded cells (cap 3 plus "+N more", uncapped when focused), lane
// height in token rows, the tokens and their popover, and a focused project's recent activity.
// Pure: it takes board jobs, each project's settled summary, and `now`; Lines.svelte, Lane.svelte,
// and Token.svelte only lay it out. Settled jobs are never on a lane: a lane counts them (its
// summary plus held jobs that settled on screen) and links to the Settled sheet.
// Epics (docs/design/epics/design.md decision 9): each unsettled epic gets a sub-lane under its
// project's lane, in the same six columns, holding only its jobs; its gutter says how the epic is
// doing and what it waits on. A project's tier counts its epics' jobs and each epic waiting on you.
// The Mac app's "Show Merged column" setting (063) can hide the Merged column: the header, every
// lane, and every sub-lane then have the other five, and a merged job shows only in the Settled
// sheet and a focused project's recent activity.
import type { BacklogCounts } from './backlog';
import { chipRounds, isEpicSettled, isEpicTerminal, isSettled, mergedAt, roundKeys } from './board';
import type { BoardEpic, BoardJob } from './board';
import { epicName } from './job';
import type { Epic, EpicJobKind, Job, WorkingStage } from './job';
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

/** The board's columns: all six, or the five without Merged when it is hidden. */
export const boardColumns = (mergedHidden: boolean): readonly ColumnInfo[] => (mergedHidden ? COLUMNS.filter((c) => c.key !== 'merged') : COLUMNS);

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
  helper: Exclude<EpicJobKind, 'member'> | null; // a generated job's tag: `sync` or `fix`
  inEpic: string | null; // a member merged into its running epic's branch: the mark's tooltip and label
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

/** A generated job's tag (`sync` or `fix`), or null for a plan member or a standalone job. */
export const helperOf = (j: Job): Exclude<EpicJobKind, 'member'> | null => (j.kind === 'sync' || j.kind === 'fix' ? j.kind : null);

/**
 * "Merged into factory/epic/<slug> · lands on <target> with the epic": a job in `merged` whose epic
 * is known and isn't terminal (its merge is on the epic branch only). Null otherwise.
 */
export function inEpicOf(b: BoardJob): string | null {
  const e = b.epic;
  if (b.job.stage !== 'merged' || b.job.epic === null || e === undefined || isEpicTerminal(e)) return null;
  return `Merged into ${b.job.target ?? e.branch} · lands on ${e.target} with the epic`;
}

/** One job's token. A merged or settled token is one line (number, title, time): no tag, chips, round, or note. */
export function tokenOf(b: BoardJob, now: number): TokenModel {
  const j = b.job;
  const kind = kindOf(b, now);
  const merged = kind === 'merged' || kind === 'settled';
  return {
    key: b.key,
    helper: helperOf(j),
    inEpic: inEpicOf(b),
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
  epic?: string; // the job's epic, when it has one: its name, and "· sync job" or "· fix job" for a generated one
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
  const helper = helperOf(j);
  const inEpic = inEpicOf(b);
  return {
    ...(b.epic === undefined ? {} : { epic: `${epicName(b.epic)}${helper !== null ? ` · ${helper} job` : ''}` }),
    title: j.title,
    where: `${b.project.name} · ${j.id}`,
    stage: inEpic !== null ? 'Merged into the epic' : KIND_LABELS[kind],
    timeLabel: merged ? 'Merged' : 'In stage',
    time: sinceText(j, kind, now),
    round: `${j.round > 0 ? j.round : '—'} of ${max}`,
    rounds: chipRounds(j).map((r) => ({ round: r.round, chips: chipsOf(r.reviews, b.reviewers, kind === 'reviewing' && !r.past) })),
    note: inEpic !== null ? [j.note, inEpic].filter((x) => x !== '').join(' · ') : j.note !== '' ? j.note : null,
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
  queued: number; // the "N queued" link beside it (brief andon-backlog-ui): the board's backlog `queued` count; 0 shows none
}

/** An epic's dot: the project dots, plus green while it lands or after it landed. */
export type EpicDot = LaneDot | 'green';

/** The sub-lane gutter's three lines (design decision 9): the name and dot, the progress, and what the epic waits on. */
export interface EpicGutter {
  name: string;
  dot: EpicDot;
  state: string; // the state's label, for the dot's tooltip and screen readers
  progress: string; // "3/6 merged · 2 running · 11h 40m"
  waiting: { tone: 'red' | 'green' | null; text: string } | null; // "1 blocked on 052 · 1 queued", "Landing…", or red "Waiting on you: <note>"
}

/** An epic's sub-lane, directly under its project's lane. */
export interface SubLane {
  key: string; // `<pid>/<slug>`, the epic it opens
  slug: string;
  hot: boolean; // waiting on you: the gutter turns red
  gutter: EpicGutter;
  cells: Cell[]; // one per column, in COLUMNS order: only the epic's jobs
  rows: number;
}

export interface Lane {
  project: { id: string; name: string };
  index: number; // registration order
  idle: boolean; // no job that isn't settled, and no epic on the board
  header: boolean; // Needs Me shows the lane only for its sub-lanes: a collapsed one-line header
  tier: string; // the lane moves only when this changes
  counts: { human: number; failed: number; active: number }; // every job of the project, its epics' included, plus each epic waiting on you
  dot: LaneDot; // the project's worst state, as the sidebar's dot
  state: LaneState;
  meta: GutterMeta;
  cells: Cell[]; // one per column, in COLUMNS order: the project's jobs that are in no shown epic
  rows: number; // the lane's height in token rows; 0 for a collapsed idle lane or header
  subs: SubLane[]; // its epics' sub-lanes, oldest start first
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

/** The cells for a set of jobs: each shown column's tokens (newest first, capped unless focused) and the ghosts of needs-human jobs. */
function cellsOf(live: readonly BoardJob[], k: (b: BoardJob) => Kind, now: number, focused: boolean, columns: readonly ColumnInfo[]): Cell[] {
  const ghosts = live
    .filter((b) => k(b) !== 'merged')
    .map(ghostOf)
    .filter((g): g is Ghost => g !== null);
  return columns.map((c): Cell => {
    const sorted = live.filter((b) => columnOf(k(b)) === c.key).sort(newest);
    const shown = focused ? sorted : sorted.slice(0, CELL_CAP);
    return {
      column: c.key,
      tokens: shown.map((b) => tokenOf(b, now)),
      more: sorted.length - shown.length,
      ghosts: ghosts.filter((g) => g.column === c.key),
    };
  });
}

/** A lane's height in token rows: its fullest cell, plus one for a "+N more". */
function rowsOf(cells: readonly Cell[]): number {
  const fullest = Math.max(0, ...cells.map((c) => c.tokens.length));
  return Math.max(1, fullest + (cells.some((c) => c.more > 0) ? 1 : 0));
}

const EPIC_STATES: Record<string, string> = { running: 'Running', waiting: 'Waiting', landing: 'Landing', landed: 'Landed', abandoned: 'Abandoned' };

/** An epic state's label: "Waiting on you" for an epic-level wait, "Waiting on members" for a derived one. */
export function epicStateLabel(e: Pick<Epic, 'state' | 'waitingOn'>): string {
  if (e.state === 'waiting') return e.waitingOn === 'you' ? 'Waiting on you' : 'Waiting on members';
  return EPIC_STATES[e.state] ?? e.state;
}

/** An epic waiting on Matt for an epic-level reason. */
const hotEpic = (e: Pick<Epic, 'waitingOn'>): boolean => e.waitingOn === 'you';

/**
 * The sub-lane gutter (AC3): the epic's name and dot; "N/M merged · K running · <elapsed since it
 * started>"; and what it waits on: red "Waiting on you: <note>" when `waitingOn` is "you" (the dot
 * turns red too), "Landing…" while it lands, else its blocked members by the job they wait on and
 * its queued count. `jobs` are the epic's jobs on the board, which color the dot as a lane's jobs do.
 */
export function epicGutter(e: Epic, jobs: readonly BoardJob[], now: number): EpicGutter {
  const kinds = jobs.map((b) => kindOf(b, now));
  const merged = e.members.filter((m) => m.state === 'merged').length;
  const running = e.members.filter((m) => m.state === 'running').length;
  const started = e.startedAt === null ? 0 : time(e.startedAt);
  const ended = e.endedAt === null ? now : time(e.endedAt);
  const progress = [`${merged}/${e.members.length} merged`, `${running} running`, ...(started > 0 ? [age(ended - started)] : [])].join(' · ');

  let waiting: EpicGutter['waiting'] = null;
  if (hotEpic(e)) waiting = { tone: 'red', text: e.note !== '' ? `Waiting on you: ${e.note}` : 'Waiting on you' };
  else if (e.state === 'landing') waiting = { tone: 'green', text: 'Landing…' };
  else if (e.state === 'landed') waiting = { tone: 'green', text: e.sha !== null ? `Landed ${e.sha}` : 'Landed' };
  else {
    const on = new Map<string, number>();
    for (const m of e.members) {
      if (m.state !== 'blocked') continue;
      const first = m.blockedOn[0];
      const label = first === undefined ? '' : first.job !== null ? numOf(first.job) : first.member;
      if (label !== '') on.set(label, (on.get(label) ?? 0) + 1);
    }
    const queued = e.members.filter((m) => m.state === 'queued').length;
    const parts = [...[...on].map(([label, n]) => `${n} blocked on ${label}`), ...(queued > 0 ? [`${queued} queued`] : [])];
    if (parts.length > 0) waiting = { tone: null, text: parts.join(' · ') };
  }

  const dot: EpicDot =
    hotEpic(e) || kinds.some(isHuman)
      ? 'red'
      : e.state === 'landing' || e.state === 'landed'
        ? 'green'
        : kinds.includes('review-failed')
          ? 'orange'
          : e.state === 'running' || e.state === 'waiting'
            ? 'blue'
            : 'gray';
  return { name: epicName(e), dot, state: epicStateLabel(e), progress, waiting };
}

/** Oldest start first, then by slug. */
const byStart = (a: BoardEpic, b: BoardEpic): number => time(a.epic.startedAt) - time(b.epic.startedAt) || a.epic.slug.localeCompare(b.epic.slug);

function laneOf(
  project: { id: string; name: string },
  index: number,
  jobs: readonly BoardJob[],
  now: number,
  focused: boolean,
  summary: SettledSummary,
  epics: readonly BoardEpic[],
  needs: boolean,
  mergedHidden: boolean,
  queued: number,
): Lane {
  const columns = boardColumns(mergedHidden);
  const kinds = new Map(jobs.map((b) => [b.key, kindOf(b, now)]));
  const k = (b: BoardJob): Kind => kinds.get(b.key) ?? 'claimed';
  const isLive = (b: BoardJob): boolean => k(b) !== 'settled' && k(b) !== 'abandoned';
  // On the lane: live, and not merged while the Merged column is hidden.
  const onBoard = (b: BoardJob): boolean => isLive(b) && !(mergedHidden && k(b) === 'merged');
  // Its epics on the board and not settled on screen, each with a sub-lane; their jobs leave the project's cells.
  const shownEpics = epics.filter((e) => !isEpicSettled(e.epic, e.settleAfterHours, now)).sort(byStart);
  const slugs = new Set(shownEpics.map((e) => e.epic.slug));
  const inSub = (b: BoardJob): boolean => b.job.epic !== null && slugs.has(b.job.epic);

  // The tier counts every job of the project, its epics' too, and each epic waiting on you.
  const live = jobs.filter(isLive);
  const active = live.filter((b) => k(b) !== 'merged');
  const humanJobs = active.filter((b) => isHuman(k(b))).length;
  const human = humanJobs + shownEpics.filter((e) => hotEpic(e.epic)).length;
  const failed = active.filter((b) => k(b) === 'review-failed').length;
  const idle = !live.some(onBoard) && shownEpics.length === 0;
  const working = active.length - humanJobs;
  const state: LaneState = human > 0 ? 'needs-human' : failed > 0 ? 'review-failed' : working > 0 ? 'active' : 'idle';

  // The gutter and the cells are the project's own jobs: those in no shown epic.
  const ownLive = live.filter((b) => !inSub(b));
  const ownShown = ownLive.filter(onBoard);
  const ownActive = ownLive.filter((b) => k(b) !== 'merged');
  const ownHuman = ownActive.filter((b) => isHuman(k(b))).length;
  const ownFailed = ownActive.filter((b) => k(b) === 'review-failed').length;
  const settled = summary.count + jobs.filter((b) => k(b) === 'settled' || k(b) === 'abandoned').length;
  const claims = ownActive.map((b) => b.job.startedAt).filter((s): s is string => s !== null).map(time);
  const oldest = claims.length > 0 ? Math.min(...claims) : null;
  const meta: GutterMeta = {
    active: `${ownActive.length} active${oldest !== null ? ` · ${age(now - oldest)}` : ''}`,
    trouble: ownHuman > 0 ? { tone: 'red', text: `${ownHuman} at Andon` } : ownFailed > 0 ? { tone: 'orange', text: `${ownFailed} sent back` } : null,
    settled,
    queued,
  };

  const merges = [...jobs.filter((b) => b.job.stage === 'merged').map((b) => mergedAt(b.job)), summary.lastMergedAt === null ? 0 : time(summary.lastMergedAt)].filter((t) => t > 0);
  const lastMergeAt = merges.length > 0 ? Math.max(...merges) : null;

  const cells = cellsOf(ownShown, k, now, focused, columns);
  const subs = shownEpics.map((e): SubLane => {
    const mine = jobs.filter((b) => b.job.epic === e.epic.slug);
    const subCells = cellsOf(mine.filter(onBoard), k, now, focused, columns);
    return { key: e.key, slug: e.epic.slug, hot: hotEpic(e.epic), gutter: epicGutter(e.epic, mine, now), cells: subCells, rows: rowsOf(subCells) };
  });
  const header = needs && ownShown.length === 0 && subs.length > 0;
  const rows = (idle && !focused) || header ? 0 : rowsOf(cells);

  return {
    project,
    index,
    idle,
    header,
    tier: `${idle ? 'idle' : 'live'}|${human}|${failed}`,
    counts: { human, failed, active: active.length },
    dot: LANE_DOTS[state],
    state,
    meta,
    cells,
    rows,
    subs,
    lastMergeAt,
    idleText: lastMergeAt !== null ? `Idle · last merge ${age(now - lastMergeAt)} ago` : 'Idle · no merges yet',
  };
}

/**
 * One lane per project, in registration order (`orderLanes` sorts them). `focused` is a single
 * focused project: its cells, its sub-lanes' too, are uncapped. `summaries` are the projects'
 * settled summaries (a missing one is none); settled jobs never sit in a cell, focused or not.
 * `epics` are the board's epics: each unsettled one gets a sub-lane under its project's lane, oldest
 * start first, holding its jobs (a job whose epic isn't among them stays in the project's cells).
 * `needs` is Needs Me: a lane shown only for its sub-lanes collapses to a one-line header.
 * `mergedHidden` drops the Merged column: every lane's and sub-lane's cells are the other five, and a
 * lane whose only live jobs are merged is idle. `backlogs` are the projects' narrow-board backlog
 * counts (a missing one is none): each lane's gutter meta carries its `queued` count, for the
 * "N queued" link; nothing else on the lane depends on it.
 */
export function buildLanes(
  projects: ReadonlyArray<{ id: string; name: string }>,
  jobs: readonly BoardJob[],
  now: number,
  focused: boolean,
  summaries: Readonly<Record<string, SettledSummary>> = {},
  epics: readonly BoardEpic[] = [],
  needs = false,
  mergedHidden = false,
  backlogs: Readonly<Record<string, BacklogCounts>> = {},
): Lane[] {
  return projects.map((p, i) =>
    laneOf(
      { id: p.id, name: p.name },
      i,
      jobs.filter((b) => b.project.id === p.id),
      now,
      focused,
      summaries[p.id] ?? { count: 0, lastMergedAt: null },
      epics.filter((e) => e.project.id === p.id),
      needs,
      mergedHidden,
      backlogs[p.id]?.queued ?? 0,
    ),
  );
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

/**
 * The sticky header: the gutter's "N active · M idle", and each column's job count and role, sub-lanes
 * included; the Andon count adds each epic waiting on you. Merged's role uses the smallest settleAfterHours shown.
 * `mergedHidden` drops the Merged column, as `buildLanes` does.
 */
export function headerOf(lanes: readonly Lane[], settleHours: readonly number[], mergedHidden = false): Header {
  const idle = lanes.filter((l) => l.idle).length;
  const hours = settleHours.length > 0 ? Math.min(...settleHours) : 24;
  const size = (cells: readonly Cell[], key: Column): number => {
    const cell = cells.find((x) => x.column === key);
    return cell === undefined ? 0 : cell.tokens.length + cell.more;
  };
  return {
    corner: `${lanes.length - idle} active · ${idle} idle`,
    columns: boardColumns(mergedHidden).map((c) => ({
      ...c,
      who: c.key === 'merged' ? (hours === 1 ? 'last hour' : `last ${hours} hours`) : c.who,
      count: lanes.reduce(
        (n, l) => n + size(l.cells, c.key) + l.subs.reduce((m, sub) => m + size(sub.cells, c.key) + (c.key === 'andon' && sub.hot ? 1 : 0), 0),
        0,
      ),
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
