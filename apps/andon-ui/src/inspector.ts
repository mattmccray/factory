// The inspector's pure model (design §8, §9): the needs-human commands, the verdict tones, the
// inspector's width, the sidebar's auto-hide rule, the file list (today's groupsOf() and pickFile()
// with a timing row and the current round), and the Settled sheet's rows. Andon never runs a
// command itself: these strings go on the clipboard for the person to run and, in the Mac app, can
// be handed to T3 Code (handoff.ts; the Mac app builds the same string itself, and a test pins that
// they agree). Nothing here touches the DOM; Inspector.svelte, CommandSheet.svelte, and SettledSheet.svelte lay it out.
import type { DocFile } from './api';
import { isEpicTerminal, mergedAt } from './board';
import type { BoardEpic, BoardJob } from './board';
import { TIMING, groupsOf, pickFile } from './docs';
import type { FileGroup } from './docs';
import { epicName } from './job';
import { age, epicStateLabel, helperOf, kindOf, numOf } from './lanes';
import { projectLabel } from './machines';
import type { Kind } from './lanes';
import { fmt, time, when } from './time';

// ---- the commands ----

/** A free-text argument for the skill: trimmed, newlines as spaces, `"` and `\` escaped, in double quotes. */
export function quoteArg(text: string): string {
  const flat = text.trim().replace(/\r\n|\r|\n/g, ' ');
  return `"${flat.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** A command line, and whether it may be copied (the skill requires a note or reason). */
export interface Command {
  text: string;
  copyable: boolean;
}

export const approveCommand = (id: string): string => `/factory approve ${id}`;

export const reworkCommand = (id: string, note: string): Command => ({ text: `/factory rework ${id} ${quoteArg(note)}`, copyable: note.trim() !== '' });

export const abandonCommand = (id: string, reason: string): Command => ({ text: `/factory abandon ${id} ${quoteArg(reason)}`, copyable: reason.trim() !== '' });

/** An epic's resume command: the epic's session (or a new one) continues it. */
export const epicCommand = (slug: string): string => `/factory epic ${slug}`;

export const abandonEpicCommand = (slug: string, reason: string): Command => ({ text: `/factory epic abandon ${slug} ${quoteArg(reason)}`, copyable: reason.trim() !== '' });

/** The sheets that build a command from free text: a job's Rework… and Abandon…, and an epic's Abandon…. */
export type SheetKind = 'rework' | 'abandon' | 'epic-abandon';

/** The HUD toast after a copy. */
export const copiedText = (command: string): string => `Copied ${command}`;

/** How long the toast shows. */
export const TOAST_MS = 1600;

// ---- verdicts ----

export type Tone = 'green' | 'orange' | 'red';

/** A verdict's color: PASS and APPROVE green, CHANGES orange, ESCALATE red. */
export function verdictTone(verdict: string | null): Tone | null {
  switch (verdict) {
    case 'PASS':
    case 'APPROVE':
      return 'green';
    case 'CHANGES':
      return 'orange';
    case 'ESCALATE':
      return 'red';
    default:
      return null;
  }
}

// ---- the inspector's width and the sidebar ----

export const INSPECTOR_MIN = 320;
export const INSPECTOR_MAX = 560;
export const INSPECTOR_DEFAULT = 392;

/** A requested width, whole pixels within 320–560; anything not a number is the default. */
export const clampWidth = (w: number): number => (Number.isFinite(w) ? Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, Math.round(w))) : INSPECTOR_DEFAULT);

/** Below this window width an open inspector hides the sidebar. */
export const AUTO_HIDE_BELOW = 1640;

export const autoHides = (windowWidth: number, inspectorOpen: boolean): boolean => inspectorOpen && windowWidth < AUTO_HIDE_BELOW;

/**
 * The sidebar's state: the user's own choice, and whether the user showed it over the auto-hide
 * rule while the inspector was open (cleared when the inspector closes).
 */
export interface SidebarChoice {
  user: boolean;
  override: boolean;
}

/** Whether the sidebar is on screen. Closing the inspector leaves only the user's choice. */
export const sidebarShown = (c: SidebarChoice, windowWidth: number, inspectorOpen: boolean): boolean =>
  c.user && (c.override || !autoHides(windowWidth, inspectorOpen));

/** The toolbar's sidebar toggle: always flips what is on screen. */
export function toggleSidebar(c: SidebarChoice, windowWidth: number, inspectorOpen: boolean): SidebarChoice {
  if (sidebarShown(c, windowWidth, inspectorOpen)) return { user: false, override: false };
  return { user: true, override: autoHides(windowWidth, inspectorOpen) };
}

// ---- the file list ----

/** The highest "Round N" group's name, or null when there is no round yet. */
export function currentRound(groups: readonly FileGroup[]): string | null {
  let best: { name: string; n: number } | null = null;
  for (const g of groups) {
    const m = /^Round (\d+)$/.exec(g.name);
    const n = m === null ? NaN : Number(m[1]);
    if (!Number.isNaN(n) && (best === null || n > best.n)) best = { name: g.name, n };
  }
  return best?.name ?? null;
}

export interface FileRow {
  path: string; // a doc's path, or TIMING
  label: string;
  verdict: string | null;
  tone: Tone | null;
}

export interface FileModel {
  groups: Array<{ name: string; current: boolean; rows: FileRow[] }>;
  order: string[]; // every row's path, top to bottom, for ↑ and ↓
  selected: string | null;
}

/**
 * The inspector's Files list: groupsOf()'s groups (Job, then each Round N), with a timing row first
 * in Job when the job has timing, the highest round marked current, and pickFile()'s selection.
 * An empty group is left out.
 */
export function fileModel(files: readonly DocFile[], hasTiming: boolean, chosen: string | null): FileModel {
  const raw = groupsOf(files);
  const current = currentRound(raw);
  const groups = raw
    .map((g) => {
      const rows: FileRow[] = g.files.map((f) => ({ ...f, tone: verdictTone(f.verdict) }));
      if (g.name === 'Job' && hasTiming) rows.unshift({ path: TIMING, label: 'timing', verdict: null, tone: null });
      return { name: g.name, current: g.name === current, rows };
    })
    .filter((g) => g.rows.length > 0);
  return { groups, order: groups.flatMap((g) => g.rows.map((r) => r.path)), selected: pickFile(chosen, files, hasTiming) };
}

/** The row `delta` steps from `current`, stopping at either end; from nothing, the first row. */
export function stepFile(order: readonly string[], current: string | null, delta: number): string | null {
  const i = current === null ? -1 : order.indexOf(current);
  if (i < 0) return order[0] ?? null;
  return order[Math.min(order.length - 1, Math.max(0, i + delta))] ?? null;
}

// ---- the job page's header ----

/**
 * A job page's header: the bar's "<project> / <job id>" and the crumbs' project, each naming a remote
 * project's machine ("factory · studio"), so same-named projects on two machines are told apart.
 */
export const jobHeader = (b: Pick<BoardJob, 'project' | 'job'>): { bar: string; project: string } => ({ bar: `${projectLabel(b.project)} / ${b.job.id}`, project: projectLabel(b.project) });

// ---- the Settled sheet ----

export interface SettledRow {
  key: string;
  id: string;
  title: string;
  project: string; // the project's name
  end: number; // the merge or abandon time, ms
  total: string; // claim to end, or "—"
  rounds: string; // "2 rounds", or "—"
  tag: 'Abandoned' | null;
  reason: string | null; // an abandoned job's `note`
}

const rounds = (n: number): string => (n > 0 ? `${n} round${n > 1 ? 's' : ''}` : '—');

/** The Settled sheet's rows, newest end first, optionally one project's only. */
export function settledRows(settled: readonly BoardJob[], project: string | null): SettledRow[] {
  return settled
    .filter((b) => project === null || b.project.id === project)
    .map((b): SettledRow => {
      const j = b.job;
      const abandoned = j.stage === 'abandoned';
      return {
        key: b.key,
        id: j.id,
        title: j.title,
        project: projectLabel(b.project),
        end: mergedAt(j),
        total: j.startedAt !== null && j.endedAt !== null ? fmt(time(j.endedAt) - time(j.startedAt)) : '—',
        rounds: rounds(j.round),
        tag: abandoned ? 'Abandoned' : null,
        reason: abandoned ? j.note : null,
      };
    })
    .sort((x, y) => y.end - x.end);
}

/** "Settled · merged more than 24h ago", with each distinct setting among the jobs shown. */
export function settledTitle(settled: readonly BoardJob[]): string {
  const hours = [...new Set(settled.map((b) => b.settleAfterHours))].sort((a, b) => a - b);
  return `Settled · merged more than ${(hours.length > 0 ? hours : [24]).map((h) => `${h}h`).join(' / ')} ago`;
}

// ---- epics: the epic page, its documents, and settled epics ----

/** A job page's link back to its epic: "Member of epic <name>", or "Generated sync job in epic <name>". Null for a standalone job, or one whose epic isn't known. */
export function epicLinkOf(b: BoardJob): { key: string; text: string; name: string } | null {
  if (b.job.epic === null || b.epic === undefined) return null;
  const helper = helperOf(b.job);
  return { key: `${b.project.id}/${b.job.epic}`, text: helper !== null ? `Generated ${helper} job in epic` : 'Member of epic', name: epicName(b.epic) };
}

/** A job the epic page links to. */
export interface EpicJobLink {
  key: string;
  id: string;
  num: string;
}

export type MemberTone = 'merged' | 'running' | 'needs-human' | 'blocked' | 'queued' | 'abandoned';

export interface EpicMemberRow {
  n: number; // plan order, from 1
  slug: string;
  title: string; // its job's title, else the slug
  after: string; // "after: a, b", or "after: none"
  tone: MemberTone;
  kind: Kind | null; // a running member's job kind, for its color
  text: string; // "merged in epic", "running · Review R1", "needs you", "blocked on 054", "queued", "abandoned"
  job: EpicJobLink | null;
}

export interface EpicGeneratedRow {
  kind: string; // sync or fix
  title: string;
  tone: MemberTone;
  text: string;
  job: EpicJobLink;
}

export interface EpicPage {
  key: string;
  slug: string;
  name: string;
  project: string; // the project's name
  state: string; // the pill's class suffix: running, waiting, landing, landed, abandoned
  stateLabel: string;
  lands: string; // "factory/epic/<slug> → <target>"
  timing: string;
  merged: string; // "3/6 merged"
  progress: Array<{ cls: string; title: string }>; // one segment per member, then per generated job: its state, or `p-<kind>` while running
  members: EpicMemberRow[];
  generated: EpicGeneratedRow[];
  waiting: { note: string; command: string } | null; // waiting on you: the red box
  abandoned: string | null; // an abandoned epic's reason
  planError: string | null;
}

const STAGE_NAMES: Record<string, string> = { claimed: 'Claimed', spec: 'Spec', build: 'Build', review: 'Review', approve: 'Approve' };

const linkOf = (pid: string, id: string): EpicJobLink => ({ key: `${pid}/${id}`, id, num: numOf(id) });

function runningText(stage: string | null, job: BoardJob | undefined, now: number): { text: string; kind: Kind | null } {
  const kind = job === undefined ? null : kindOf(job, now);
  const round = job !== undefined && job.job.round > 0 ? ` R${job.job.round}` : '';
  return { text: `running · ${STAGE_NAMES[stage ?? ''] ?? stage ?? 'claimed'}${round}${kind === 'review-failed' ? ' · changes' : ''}`, kind };
}

/**
 * The epic page (AC6): its state pill, `factory/epic/<slug> → <target>`, timing from `startedAt`
 * and `endedAt`, a progress bar split by member state, the Members in plan order (each with its
 * `after:` edges, state, and job link), a Generated group for its sync and fix jobs, and, when it
 * waits on you, the note and `/factory epic <slug>` to copy. `jobs` are its jobs as the board and the
 * cached settled list hold them.
 */
export function epicPage(b: BoardEpic, jobs: readonly BoardJob[], now: number): EpicPage {
  const e = b.epic;
  const byId = new Map(jobs.map((j) => [j.job.id, j]));
  const terminal = isEpicTerminal(e);
  const members = e.members.map((m, i): EpicMemberRow => {
    const job = m.job === null ? undefined : byId.get(m.job);
    const title = job !== undefined && job.job.title !== job.job.id ? job.job.title : m.slug;
    const row = { n: i + 1, slug: m.slug, title, after: `after: ${m.after.length > 0 ? m.after.join(', ') : 'none'}`, job: m.job === null ? null : linkOf(b.project.id, m.job), kind: null };
    switch (m.state) {
      case 'merged':
        return { ...row, tone: 'merged', text: terminal ? 'merged' : 'merged in epic' };
      case 'needs-human':
        return { ...row, tone: 'needs-human', text: 'needs you' };
      case 'blocked': {
        const first = m.blockedOn[0];
        return { ...row, tone: 'blocked', text: first === undefined ? 'blocked' : `blocked on ${first.job !== null ? numOf(first.job) : first.member}` };
      }
      case 'queued':
        return { ...row, tone: 'queued', text: 'queued' };
      case 'abandoned':
        return { ...row, tone: 'abandoned', text: 'abandoned' };
      default: {
        const r = runningText(m.stage, job, now);
        return { ...row, tone: 'running', text: r.text, kind: r.kind };
      }
    }
  });
  const generated = e.generated.map((g): EpicGeneratedRow => {
    const job = byId.get(g.id);
    const tone: MemberTone = g.stage === 'merged' ? 'merged' : g.stage === 'needs-human' ? 'needs-human' : g.stage === 'abandoned' ? 'abandoned' : 'running';
    const text = tone === 'merged' ? (terminal ? 'merged' : 'merged in epic') : tone === 'needs-human' ? 'needs you' : tone === 'abandoned' ? 'abandoned' : runningText(g.stage, job, now).text;
    return { kind: g.kind, title: job?.job.title ?? g.id, tone, text, job: linkOf(b.project.id, g.id) };
  });
  // a running segment takes its job's kind color (`p-<kind>`); the rest their member state
  const segment = (tone: MemberTone, kind: Kind | null): string => (tone === 'running' ? `p-${kind ?? 'build'}` : tone);
  const progress = [
    ...members.map((m) => ({ cls: segment(m.tone, m.kind), title: `${m.slug}: ${m.text}` })),
    ...generated.map((g) => {
      const job = byId.get(g.job.id);
      return { cls: segment(g.tone, job === undefined ? null : kindOf(job, now)), title: `${g.job.id}: ${g.text}` };
    }),
  ];
  const merged = e.members.filter((m) => m.state === 'merged').length;
  const started = e.startedAt === null ? 0 : time(e.startedAt);
  const ended = e.endedAt === null ? 0 : time(e.endedAt);
  const took = started > 0 ? age((ended > 0 ? ended : now) - started) : null;
  const timing = [
    started > 0 ? `started ${when(started)}` : 'start not recorded',
    took === null ? null : e.state === 'landed' ? `landed after ${took}` : e.state === 'abandoned' ? `abandoned after ${took}` : `${took} running`,
  ]
    .filter((x) => x !== null)
    .join(' · ');
  return {
    key: b.key,
    slug: e.slug,
    name: epicName(e),
    project: projectLabel(b.project),
    state: e.waitingOn === 'you' ? 'waiting' : e.state,
    stateLabel: epicStateLabel(e),
    lands: `${e.branch} → ${e.target}`,
    timing,
    merged: `${merged}/${e.members.length} merged`,
    progress,
    members,
    generated,
    waiting: e.waitingOn === 'you' ? { note: e.note, command: epicCommand(e.slug) } : null,
    abandoned: e.state === 'abandoned' ? e.note : null,
    planError: e.planError,
  };
}

/** A document's row label: the plan is "plan"; a brief is its file name. */
const epicDocLabel = (path: string): string => (path.startsWith('epics/') ? 'plan' : (path.split('/').pop() ?? path));

/** The epic page's documents: the plan, then the member briefs, the chosen one selected (else the plan, else the first). */
export function epicFileModel(files: readonly DocFile[], chosen: string | null): FileModel {
  const row = (f: DocFile): FileRow => ({ path: f.path, label: epicDocLabel(f.path), verdict: null, tone: null });
  const groups = [
    { name: 'Plan', current: false, rows: files.filter((f) => !f.path.startsWith('briefs/')).map(row) },
    { name: 'Member briefs', current: false, rows: files.filter((f) => f.path.startsWith('briefs/')).map(row) },
  ].filter((g) => g.rows.length > 0);
  const order = groups.flatMap((g) => g.rows.map((r) => r.path));
  return { groups, order, selected: chosen !== null && order.includes(chosen) ? chosen : (order[0] ?? null) };
}

export interface SettledEpicRow {
  key: string; // the epic's key: opening the row opens the epic page
  slug: string;
  name: string;
  project: string; // the project's name
  outcome: 'Landed' | 'Abandoned';
  sha: string | null; // the landing's short sha
  members: string; // "4 members"
  end: number;
  reason: string | null; // an abandoned epic's reason
  jobs: SettledRow[]; // its settled jobs, grouped under it
}

export type SettledItem = { kind: 'job'; row: SettledRow } | { kind: 'epic'; row: SettledEpicRow };

/** Whether a settled job belongs to one of these settled epics (same project, its `epic` the slug). */
const inEpics = (b: BoardJob, epics: readonly BoardEpic[]): boolean => b.job.epic !== null && epics.some((e) => e.project.id === b.project.id && e.epic.slug === b.job.epic);

/**
 * The Settled sheet's epic rows (AC7), newest end first, optionally one project's only: each settled
 * epic's name, outcome, landing short sha, and member count, with its settled jobs grouped under it.
 */
export function settledEpicRows(settled: readonly BoardJob[], epics: readonly BoardEpic[], project: string | null): SettledEpicRow[] {
  return epics
    .filter((e) => project === null || e.project.id === project)
    .map((b): SettledEpicRow => {
      const e = b.epic;
      const n = e.members.length;
      return {
        key: b.key,
        slug: e.slug,
        name: epicName(e),
        project: projectLabel(b.project),
        outcome: e.state === 'abandoned' ? 'Abandoned' : 'Landed',
        sha: e.sha,
        members: `${n} member${n === 1 ? '' : 's'}`,
        end: time(e.endedAt ?? e.updated),
        reason: e.state === 'abandoned' ? e.note : null,
        jobs: settledRows(settled.filter((j) => j.project.id === b.project.id && j.job.epic === e.slug), null),
      };
    })
    .sort((x, y) => y.end - x.end || x.key.localeCompare(y.key));
}

/** The Settled sheet's list: each settled epic as one row with its jobs under it, and every other settled job loose. Newest end first. */
export function settledItems(settled: readonly BoardJob[], epics: readonly BoardEpic[], project: string | null): SettledItem[] {
  const items: SettledItem[] = [
    ...settledEpicRows(settled, epics, project).map((row): SettledItem => ({ kind: 'epic', row })),
    ...settledRows(settled.filter((b) => !inEpics(b, epics)), project).map((row): SettledItem => ({ kind: 'job', row })),
  ];
  return items.sort((x, y) => y.row.end - x.row.end || x.row.key.localeCompare(y.row.key));
}
