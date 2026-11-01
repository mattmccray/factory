// The Mac app's desk widget (092; design A2, docs/design/desk-widget/chosen/desk-widget.html): its
// page is this UI's widget view (`?shell=mac&view=widget`, see sidebar.ts `appView`), fed by the same
// `GET /events?settled=summary` stream and board reads as the board (live.ts, state.ts), on every
// machine. One row per project with live work, labeled with `projectLabel` (a remote one names its
// machine); each job a pill of four segments (spec, build, review, approve): its current segment in
// its stage's color, earlier ones dimmed, later ones empty; a needs-human job's current segment (the
// stage it stopped from) red, the pill glowing red; a job the widget saw live that then merged goes
// green, then leaves. An epic's member jobs sit in one bracket on their project's row. Each pill has
// a tooltip, and a footer reads "<n> needs you" (the tray badge's count) with the live and merged
// counts. Everything here is pure and DOM-free; DeskWidget.svelte renders it and animates it.
// The widget talks to the Mac app through three methods only, each answered only for the widget
// window: `openJob` (a pill's project id and job id), `showAndon` (no params), and `fitWidget` (the
// glass's height, so the window fits it and its place is remembered). Its glass drags the window
// (`win.startDrag`) once the mouse moves past a small slop, so a click stays a click.
import type { BoardJob } from './board';
import { isRecord } from './job';
import type { Job, WorkingStage } from './job';
import { placed, projectLabel } from './machines';
import { ALL, boardJobs, needsHuman } from './projects';
import type { JobRef } from './route';
import type { ShellMode } from './sidebar';
import type { UiState } from './state';

/** The widget page's three Mac app backend methods (tinyjs.json's `api` gate enables each by name). */
export const OPEN_JOB_METHOD = 'openJob';
export const SHOW_ANDON_METHOD = 'showAndon';
export const FIT_WIDGET_METHOD = 'fitWidget';

/** The four segments of a pill, in order. */
export type Segment = 'spec' | 'build' | 'review' | 'approve';
export const SEGMENTS: readonly Segment[] = ['spec', 'build', 'review', 'approve'];

/** A pill's tone: its current segment's stage color, red for needs-human, green for just merged. */
export type PillTone = Segment | 'human' | 'merged';
/** A segment's fill: dimmed (done), the current one in the tone's color, or empty (still ahead). */
export type Fill = 'done' | 'cur' | 'empty';

export interface Pill {
  key: string; // `<pid>/<job id>`, the board's key
  project: string; // the project id
  id: string; // the job id
  tone: PillTone;
  fills: Fill[]; // one per SEGMENTS entry
  tip: string; // two lines: who (project, job id, epic), then where (stage and round, or why it needs you)
}

/** An epic's bracket on its project's row: its member jobs' pills. */
export interface EpicGroup {
  key: string; // `<pid>/<slug>`
  slug: string;
  tip: string;
  pills: Pill[];
}

export type RowItem = { kind: 'pill'; pill: Pill } | { kind: 'epic'; epic: EpicGroup };

export interface WidgetRow {
  key: string; // the project id
  label: string; // `projectLabel`: "<name>", or "<name> · <machine>" for a remote project
  items: RowItem[]; // its pills, then its epics' brackets
}

export interface WidgetFooter {
  needsYou: number; // the tray badge's count: needs-human jobs plus epics waiting on you
  live: number; // the unsettled (live) jobs shown
  merged: number; // the jobs seen merging since the page loaded
}

export interface WidgetView {
  rows: WidgetRow[];
  footer: WidgetFooter;
  empty: boolean; // no live work anywhere: the small, nearly empty glass panel
}

// ---- a job's pill ----

/** The working stages, by the segment each one lights: claimed counts as spec. */
const SEGMENT_OF: Record<WorkingStage, number> = { claimed: 0, spec: 0, build: 1, review: 2, approve: 3 };
const isWorking = (stage: string): stage is WorkingStage => Object.hasOwn(SEGMENT_OF, stage);

/** A job the widget shows live: a working stage, or needs-human. */
export const isLive = (j: Pick<Job, 'stage'>): boolean => isWorking(j.stage) || j.stage === 'needs-human';

/** The working stage a needs-human job stopped from: `stoppedFrom`, else its last working stage on
 *  record (`timing.stages`); null when neither says. */
export function stoppedStage(j: Job): WorkingStage | null {
  if (j.stoppedFrom !== null) return j.stoppedFrom;
  const spans = j.timing?.stages ?? [];
  for (let i = spans.length - 1; i >= 0; i--) {
    const stage = spans[i]?.stage ?? '';
    if (isWorking(stage)) return stage;
  }
  return null;
}

/** A live job's current segment (0–3): its working stage's; for needs-human, the stage it stopped
 *  from (approve when nothing says). */
export function currentSegment(j: Job): number {
  if (isWorking(j.stage)) return SEGMENT_OF[j.stage];
  const from = stoppedStage(j);
  return from === null ? 3 : SEGMENT_OF[from];
}

/** A pill's tone for a job (`merged`: it is the just-merged pill). */
export function pillTone(j: Job, merged: boolean): PillTone {
  if (merged) return 'merged';
  if (j.stage === 'needs-human') return 'human';
  return SEGMENTS[currentSegment(j)] ?? 'spec';
}

/** The four fills: before the current segment dimmed, the current one lit, after it empty; a just-merged pill is all lit (green). */
export function pillFills(j: Job, merged: boolean): Fill[] {
  if (merged) return SEGMENTS.map((): Fill => 'cur');
  const k = currentSegment(j);
  return SEGMENTS.map((_, i): Fill => (i < k ? 'done' : i === k ? 'cur' : 'empty'));
}

/** Why a needs-human job needs you: the first line of its card's note, else what stopped it. */
export function whyText(j: Job): string {
  const line = j.note.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  if (line !== '') return line.length > 120 ? `${line.slice(0, 119)}…` : line;
  if (j.stoppedBy === 'merge-failed') return 'the merge failed';
  if (j.stoppedBy === 'escalated') return 'escalated';
  return 'waiting on you';
}

/** Where a job is, for its tooltip: its stage with its round, or why it needs you. */
export function stageText(j: Job, merged: boolean): string {
  if (merged) return 'just merged';
  switch (j.stage) {
    case 'needs-human':
      return `needs you · ${whyText(j)}`;
    case 'claimed':
      return 'claimed';
    case 'spec':
      return 'spec';
    case 'build':
      return j.round > 0 ? `build · round ${j.round} fixes` : 'build';
    case 'review':
      return `review · round ${j.round}`;
    case 'approve':
      return j.round > 0 ? `approve · round ${j.round}` : 'approve';
    default:
      return j.stage;
  }
}

/** A pill's tooltip: "<project label> · <job id>[ · epic <name>]", then the stage line. */
export function pillTip(b: BoardJob, merged: boolean): string {
  const epic = b.job.epic === null ? '' : ` · epic ${b.epic?.title ?? b.job.epic}`;
  return `${projectLabel(b.project)} · ${b.job.id}${epic}\n${stageText(b.job, merged)}`;
}

export const pillOf = (b: BoardJob, merged = false): Pill => ({
  key: b.key,
  project: b.project.id,
  id: b.job.id,
  tone: pillTone(b.job, merged),
  fills: pillFills(b.job, merged),
  tip: pillTip(b, merged),
});

/** Pill order on a row (the mock-up's): needs you first, then approve, review, build, spec; a just-merged pill keeps approve's place. */
const RANK: Record<PillTone, number> = { human: 0, approve: 1, merged: 1, review: 2, build: 3, spec: 4 };
const byRank = (a: Pill, b: Pill): number => RANK[a.tone] - RANK[b.tone] || a.id.localeCompare(b.id);

// ---- watching merges ----
// A "just merged" pill is a job the widget saw live that then merged: it shows green for
// MERGED_SHOW_MS, then leaves. A job already merged when the page loads never shows. "merged" in the
// footer counts the merges seen since the page loaded.

export const MERGED_SHOW_MS = 2400;

export interface MergeWatch {
  live: ReadonlySet<string>; // the keys of the jobs seen live in the last update
  fading: ReadonlyMap<string, { at: number }>; // just merged: when it was seen merged
  merged: number;
}

export const watchStart = (): MergeWatch => ({ live: new Set(), fading: new Map(), merged: 0 });

/** The watch after an update of the board's jobs at `now`: a job seen live last time and merged now
 *  starts fading (and counts); a fading one leaves once it has shown for MERGED_SHOW_MS. Unchanged
 *  (the same object) when nothing changed. */
export function watchMerges(w: MergeWatch, jobs: readonly BoardJob[], now: number): MergeWatch {
  const fading = new Map<string, { at: number }>();
  for (const [key, f] of w.fading) if (now - f.at < MERGED_SHOW_MS) fading.set(key, f);
  let merged = w.merged;
  for (const b of jobs) {
    if (b.job.stage === 'merged' && w.live.has(b.key) && !fading.has(b.key)) {
      fading.set(b.key, { at: now });
      merged++;
    }
  }
  const live = new Set(jobs.filter((b) => isLive(b.job)).map((b) => b.key));
  const same = merged === w.merged && fading.size === w.fading.size && [...fading.keys()].every((k) => w.fading.has(k)) && live.size === w.live.size && [...live].every((k) => w.live.has(k));
  return same ? w : { live, fading, merged };
}

// ---- the view ----

/** The widget's view of the board: a row per project with live work (or a job fading after its
 *  merge), by label; the footer's counts; empty when no project has any. */
export function widgetView(s: UiState, watch: MergeWatch): WidgetView {
  const jobs = boardJobs(s, ALL);
  const rows: WidgetRow[] = [];
  let live = 0;
  for (const p of placed(s, s.projects)) {
    const mine = jobs.filter((b) => b.project.id === p.id);
    const pills: Array<{ pill: Pill; epic: string | null }> = [];
    for (const b of mine) {
      const fading = watch.fading.has(b.key) && b.job.stage === 'merged';
      if (!fading && !isLive(b.job)) continue;
      if (!fading) live++;
      pills.push({ pill: pillOf(b, fading), epic: b.job.epic });
    }
    if (pills.length === 0) continue;
    const loose = pills.filter((x) => x.epic === null).map((x) => x.pill).sort(byRank);
    const slugs = [...new Set(pills.flatMap((x) => (x.epic === null ? [] : [x.epic])))].sort((a, b) => a.localeCompare(b));
    const label = projectLabel(p.remote === undefined ? { name: p.name } : { name: p.name, remote: p.remote });
    const epics = slugs.map((slug): EpicGroup => {
      const members = pills.filter((x) => x.epic === slug).map((x) => x.pill).sort(byRank);
      const title = mine.find((b) => b.job.epic === slug)?.epic?.title ?? slug;
      return { key: `${p.id}/${slug}`, slug, pills: members, tip: `${label} · epic ${title}\n${members.length} member job${members.length === 1 ? '' : 's'} live` };
    });
    rows.push({ key: p.id, label, items: [...loose.map((pill): RowItem => ({ kind: 'pill', pill })), ...epics.map((epic): RowItem => ({ kind: 'epic', epic }))] });
  }
  rows.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key));
  return { rows, footer: { needsYou: needsHuman(s).total, live, merged: watch.merged }, empty: rows.length === 0 };
}

/** The footer's two sides: "<n> needs you", and "<live> live · <merged> merged". */
export const footerText = (f: WidgetFooter): { needs: string; counts: string } => ({ needs: `${f.needsYou} needs you`, counts: `${f.live} live · ${f.merged} merged` });

/** A pill's accessible name: its tooltip on one line. */
export const pillLabel = (p: Pill): string => p.tip.replace('\n', ', ');

// ---- the glass: a click, or a drag ----

/** How far (in px) the mouse moves, button down, before a press on the glass drags the window. */
export const DRAG_SLOP = 4;

/** A press on the glass (not on a pill): where it started, and whether it became a drag. */
export interface Press {
  x: number;
  y: number;
  dragging: boolean;
}

export const pressStart = (x: number, y: number): Press => ({ x, y, dragging: false });

/** The press after the mouse moved to (x, y): `drag` exactly once, when it first passes the slop. */
export function pressMove(p: Press, x: number, y: number): { press: Press; drag: boolean } {
  if (p.dragging || Math.hypot(x - p.x, y - p.y) < DRAG_SLOP) return { press: p, drag: false };
  return { press: { ...p, dragging: true }, drag: true };
}

/** A press that ends without having dragged is a click on the glass (Andon comes forward). */
export const pressClick = (p: Press): boolean => !p.dragging;

/** The height the window fits to: the glass's, whole points, within the Mac app's bounds. */
export const FIT_MIN = 48;
export const FIT_MAX = 720;
export const fitHeight = (px: number): number => Math.min(FIT_MAX, Math.max(FIT_MIN, Math.ceil(Number.isFinite(px) ? px : FIT_MIN)));

// ---- the tooltip ----
// The window is the glass's size, so a pill's tooltip is drawn inside the glass: centered over the
// pill and kept inside the glass's edges, above it when there is room, else below it.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The tooltip's top-left inside the glass, for a pill at `anchor` (glass coordinates) and a tooltip of `tip`'s size. */
export function tipPlace(anchor: Box, glass: { width: number; height: number }, tip: { width: number; height: number }, gap = 6, edge = 6): { x: number; y: number } {
  const clamp = (v: number, lo: number, hi: number): number => Math.round(Math.max(lo, Math.min(v, Math.max(lo, hi))));
  const x = clamp(anchor.x + anchor.width / 2 - tip.width / 2, edge, glass.width - tip.width - edge);
  const above = anchor.y - gap - tip.height;
  const y = above >= edge ? Math.round(above) : clamp(anchor.y + anchor.height + gap, edge, glass.height - tip.height - edge);
  return { x, y };
}

// ---- the Mac app ----

/** What the widget page asks of the Mac app. Each call's failure is ignored (nothing happens). */
export interface WidgetApi {
  openJob(project: string, job: string): void;
  showAndon(): void;
  fit(height: number): void;
  /** Starts the native window drag (the mouse button is down). */
  drag(): Promise<void>;
}

/**
 * How the widget page talks to the Mac app: Tiny's backend call, only ever with the three fixed
 * method names (a pill's `{ project, job }`, nothing, or `{ height }`), and Tiny's own window drag.
 * Found by narrowing the page's `window.tiny` (passed in as `unknown`). Null in a browser, or when it
 * isn't there.
 */
export function widgetCaller(mode: ShellMode, host: unknown): WidgetApi | null {
  if (mode !== 'mac' || !isRecord(host) || !isRecord(host.api)) return null;
  const api = host.api;
  const call = api.call;
  if (typeof call !== 'function') return null;
  const win = isRecord(host.win) ? host.win : null;
  const startDrag = win?.startDrag;
  const settle = (r: unknown): void => {
    if (r instanceof Promise) r.catch(() => undefined);
  };
  const send = (f: () => unknown): void => {
    try {
      settle(f());
    } catch {
      // the Mac app couldn't take it: nothing happens
    }
  };
  return {
    openJob: (project, job) => send(() => Reflect.apply(call, api, [OPEN_JOB_METHOD, { project, job }])),
    showAndon: () => send(() => Reflect.apply(call, api, [SHOW_ANDON_METHOD, null])),
    fit: (height) => send(() => Reflect.apply(call, api, [FIT_WIDGET_METHOD, { height }])),
    drag: async () => {
      if (win === null || typeof startDrag !== 'function') return;
      try {
        await Reflect.apply(startDrag, win, []);
      } catch {
        // no drag: the widget stays where it is
      }
    },
  };
}

// ---- the main window: a pill's click selects its job ----

/** The open-job event's payload, checked: exactly a listed project's id and a non-empty job id.
 *  Null for anything else (the page does nothing). */
export function openJobPush(data: unknown, listed: readonly { id: string }[]): JobRef | null {
  if (!isRecord(data)) return null;
  const keys = Object.keys(data).sort();
  if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'project') return null;
  const { project, id } = data;
  if (typeof project !== 'string' || typeof id !== 'string' || id === '' || !listed.some((p) => p.id === project)) return null;
  return { project, id };
}

/** The desk widget event's `on`, or null for a malformed payload (which changes nothing). */
export const deskWidgetOn = (data: unknown): boolean | null => (isRecord(data) && typeof data.on === 'boolean' ? data.on : null);
