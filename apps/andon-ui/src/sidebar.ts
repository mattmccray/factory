// The frame's pure model (design §3, §4): the sidebar's rows (All Projects and every registered
// project, each with a status dot and a badge), the connection footer, the toolbar's title and
// subtitle, the status bar's legend and settle text, the shell mode read from the page URL, and the
// Mac app's status bar event.
// Nothing here touches the DOM; App.svelte and the frame components only lay it out.
import { isRecord } from './job';
import type { Job } from './job';
import { isReviewFailed } from './lanes';
import type { Status } from './live';
import { ALL, needsHuman } from './projects';
import type { Selection } from './projects';
import type { UiState } from './state';

/** A project's worst state, worst first. */
export type ProjectState = 'needs-human' | 'review-failed' | 'active' | 'idle';
export type Dot = 'red' | 'orange' | 'blue' | 'gray';

export const DOTS: Record<ProjectState, Dot> = { 'needs-human': 'red', 'review-failed': 'orange', active: 'blue', idle: 'gray' };
/** What each dot means, for screen readers and tooltips. */
export const STATE_LABELS: Record<ProjectState, string> = { 'needs-human': 'needs a human', 'review-failed': 'review failed', active: 'working', idle: 'idle' };

export interface Badge {
  tone: 'red' | 'gray';
  count: number;
  label: string; // "2 need a human", "3 active"
}

export interface SidebarRow {
  id: Selection;
  name: string;
  title: string; // the tooltip: the project's root
  state: ProjectState;
  dot: Dot;
  badge: Badge | null;
  selected: boolean;
}

export interface SidebarModel {
  all: { badge: Badge | null; selected: boolean };
  projects: SidebarRow[];
}

/** Stages a job never leaves: it's done, never active (`merged`, and the contract's `abandoned`). */
const TERMINAL = new Set(['merged', 'abandoned']);

/** Active: not settled, not merged (or otherwise terminal), and not waiting on a human. Only a
 *  merged job settles, so excluding the terminal stages excludes every settled job too. */
export const isActive = (j: Job): boolean => !TERMINAL.has(j.stage) && j.stage !== 'needs-human';

/** Review failed: the lanes' §5 kind rule (stage `review`, every verdict in, at least one CHANGES), so the
 *  sidebar's orange dot, the lane tier, and the gutter's "sent back" count always agree. */
export const reviewFailed = (j: Job): boolean => isReviewFailed(j);

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const redBadge = (n: number): Badge => ({ tone: 'red', count: n, label: plural(n, 'needs a human', 'need a human') });
const grayBadge = (n: number): Badge => ({ tone: 'gray', count: n, label: `${n} active` });

/** One project's state, dot, and badge (red needs-human count, else gray active count, else none). */
export function projectStatus(jobs: readonly Job[]): { state: ProjectState; badge: Badge | null } {
  const human = jobs.filter((j) => j.stage === 'needs-human').length;
  const active = jobs.filter(isActive);
  const state: ProjectState = human > 0 ? 'needs-human' : active.some(reviewFailed) ? 'review-failed' : active.length > 0 ? 'active' : 'idle';
  const badge = human > 0 ? redBadge(human) : active.length > 0 ? grayBadge(active.length) : null;
  return { state, badge };
}

const byName = (a: { name: string; id: string }, b: { name: string; id: string }): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** The sidebar: All Projects (badge: the total needs-human count), then every project by name. */
export function sidebarModel(s: UiState, sel: Selection): SidebarModel {
  const total = needsHuman(s).total;
  const projects = s.projects
    .map((p): SidebarRow => {
      const { state, badge } = projectStatus(s.boards[p.id]?.jobs ?? []);
      return { id: p.id, name: p.name, title: p.root, state, dot: DOTS[state], badge, selected: sel === p.id };
    })
    .sort(byName);
  const known = projects.some((p) => p.selected);
  return { all: { badge: total > 0 ? redBadge(total) : null, selected: sel === ALL || !known }, projects };
}

// ---- the connection footer ----

export interface Footer {
  text: string;
  dot: 'green' | 'gray' | 'red';
}

export function footer(status: Status, projects: number): Footer {
  if (status === 'live') return { text: `Connected · andon-service · ${plural(projects, 'project', 'projects')}`, dot: 'green' };
  if (status === 'down') return { text: 'Unreachable', dot: 'red' };
  return { text: 'Connecting…', dot: 'gray' };
}

// ---- the toolbar ----

/** The toolbar title: "Andon", or the selected project's name. */
export function title(s: UiState, sel: Selection): string {
  return sel === ALL ? 'Andon' : (s.projects.find((p) => p.id === sel)?.name ?? 'Andon');
}

export interface Subtitle {
  scope: string; // "All Projects", or the selected project's name
  running: string; // "12 running"
  waiting: string | null; // "3 waiting on you" (shown red), or null at zero
  elsewhere: string | null; // a focused project: "2 waiting elsewhere" (other projects' needs-human jobs, red), or null at zero
}

/**
 * "<scope> — N running, M waiting on you"; running excludes needs-human, and the waiting part is
 * omitted at zero. A focused project adds "K waiting elsewhere" when other projects need a human.
 */
export function subtitle(s: UiState, sel: Selection, running: number, waiting: number): Subtitle {
  const focused = sel !== ALL && s.projects.some((p) => p.id === sel);
  const scope = focused ? (s.projects.find((p) => p.id === sel)?.name ?? 'All Projects') : 'All Projects';
  const human = needsHuman(s);
  const others = focused ? human.total - (human.byProject[sel] ?? 0) : 0;
  return { scope, running: `${running} running`, waiting: waiting > 0 ? `${waiting} waiting on you` : null, elsewhere: others > 0 ? `${others} waiting elsewhere` : null };
}

export const subtitleText = (t: Subtitle): string => [`${t.scope} — ${t.running}`, t.waiting, t.elsewhere].filter((x) => x !== null).join(', ');

// ---- the status bar ----

export interface LegendEntry {
  key: string; // the swatch's class
  label: string;
}

/** The state legend, one swatch per state a card can show (the card's left edge). */
export const LEGEND: readonly LegendEntry[] = [
  { key: 'needs-human', label: 'Needs a human' },
  { key: 'failed', label: 'Review failed' },
  { key: 'review', label: 'In review' },
  { key: 'approve', label: 'At approver' },
  { key: 'build', label: 'Building' },
  { key: 'spec', label: 'Spec' },
  { key: 'claimed', label: 'Claimed' },
  { key: 'merged', label: 'Merged' },
];

/** "Settle after 24h", or each distinct setting in the selection ("Settle after 2h / 24h"). */
export function settleText(hours: readonly number[]): string {
  const distinct = [...new Set(hours)].sort((a, b) => a - b);
  return `Settle after ${(distinct.length > 0 ? distinct : [24]).map((h) => `${h}h`).join(' / ')}`;
}

/** The selection's `settleAfterHours` values, one per project. */
export function settleHours(s: UiState, sel: Selection): number[] {
  return s.projects.filter((p) => sel === ALL || sel === p.id).map((p) => s.boards[p.id]?.config.settleAfterHours ?? 24);
}

// ---- the window: the Mac app or a browser ----

export type ShellMode = 'mac' | 'browser';

/** The traffic lights' reserved width, at the top-left of the sidebar (or the toolbar when the sidebar is hidden). */
export const MAC_INSET = 78;

/** `?shell=mac` (the Mac app loads the page with it) is the Mac app; anything else is a browser. */
export function shellMode(search: string): ShellMode {
  return new URLSearchParams(search).get('shell') === 'mac' ? 'mac' : 'browser';
}

// ---- the Mac app's status bar choice ----
// The Mac app's View menu hides or shows the status bar and pushes the choice to the page as one
// event; the page only listens (it never calls the Mac app). In a browser there is no such event.

/** The event the Mac app pushes with the status bar state: `{ hidden: boolean }`. */
export const STATUS_BAR_EVENT = 'statusbar';

/** Subscribe to one pushed event; returns the unsubscribe. */
export type Subscribe = (event: string, fn: (data: unknown) => void) => () => void;

/** How the page hears the Mac app's pushed events: Tiny's `api.on`, found by narrowing the page's
 *  `window.tiny` (passed in as `unknown`). Null in a browser, or when it isn't there. */
export function pushSubscriber(mode: ShellMode, host: unknown): Subscribe | null {
  if (mode !== 'mac' || !isRecord(host) || !isRecord(host.api)) return null;
  const api = host.api;
  const on = api.on;
  if (typeof on !== 'function') return null;
  return (event, fn) => {
    const off: unknown = Reflect.apply(on, api, [event, fn]);
    return () => {
      if (typeof off === 'function') Reflect.apply(off, undefined, []);
    };
  };
}

/** The status bar event's `hidden`, or null for a malformed payload (which changes nothing). */
export function statusBarHidden(data: unknown): boolean | null {
  return isRecord(data) && typeof data.hidden === 'boolean' ? data.hidden : null;
}

export interface Frame {
  inset: number; // px reserved for the traffic lights at the top-left of the sidebar
  toolbarInset: number; // px reserved at the toolbar's left when the sidebar is hidden
  drag: boolean; // data-tiny-drag on the toolbar and the sidebar's top strip
  transparentSidebar: boolean; // the native vibrancy shows through
}

export function frame(mode: ShellMode, sidebarOpen: boolean): Frame {
  const mac = mode === 'mac';
  return { inset: mac ? MAC_INSET : 0, toolbarInset: mac && !sidebarOpen ? MAC_INSET : 0, drag: mac, transparentSidebar: mac };
}
