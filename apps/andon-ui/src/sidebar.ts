// The frame's pure model (design §3, §4): the sidebar's rows (All Projects and every registered
// project, each with a status dot, a badge, and its factory release: a quiet "update available"
// glyph when it is behind, and a hover line for every state), the connection footer (with the
// machine's release, or a restart note), the toolbar's title and
// subtitle, the status bar's legend and settle text, the shell mode and view read from the page URL,
// the Mac app's pushed events (the status bar, the Merged column, What's New, and the View menu's
// page actions), and the main window's view-state report back to the Mac app.
// Machines (brief andon-machines-ui; design "Machines"): with peers, the projects sit under one
// heading per machine, the hub first, then the peers by name, each heading with its state ("down
// since 14:02", "needs upgrade", "error", a gray "connecting…", or nothing when live); headings
// aren't selectable. The footer counts the machines and names each one in trouble. With no peers,
// nothing names a machine.
// Nothing here touches the DOM; App.svelte and the frame components only lay it out.
import { isRecord } from './job';
import type { Epic, Job, Machine, MachineState } from './job';
import { isReviewFailed } from './lanes';
import { hasPeers, hubName, machineOrder, machineStateText, needsUpgrade, projectLabel, remoteOf } from './machines';
import type { Status } from './live';
import { ALL, needsHuman } from './projects';
import type { Selection } from './projects';
import { RESTART_COMMAND, RESTART_NOTE, releaseLine, restartText, whatsNewTitle } from './release';
import type { ReleaseInfo, ReleaseState } from './release';
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

/** A project row's factory release: its hover line (also announced as the row's description), and the glyph a behind project gets. */
export interface RowRelease {
  state: ReleaseState;
  line: string; // "factory 0.1.0 installed · 0.2.0 available", "… · up to date", …, "factory version unknown"
  glyph: { label: string } | null; // behind only: the "update available" button's hover text and accessible name
}

export interface SidebarRow {
  id: Selection;
  name: string;
  title: string; // the tooltip: the project's root, then its release line when it has one
  state: ProjectState;
  dot: Dot;
  badge: Badge | null;
  selected: boolean;
  release: RowRelease | null; // null: the service sent no release (an older service)
}

/** A machine's heading in the sidebar (only with peers): not selectable, its projects under it. */
export interface MachineHeading {
  name: string;
  state: MachineState | null; // null: a machine a project names that isn't listed (a moment between events)
  status: { text: string; tone: 'red' | 'gray' } | null; // "down since 14:02", "needs upgrade", "error", "connecting…"; null when live
  detail: string | null; // the tooltip and accessible description: its reason, then "factory <release>", when known
  projects: SidebarRow[]; // its projects, by name (the rows keep the bare name)
}

export interface SidebarModel {
  all: { badge: Badge | null; selected: boolean };
  projects: SidebarRow[]; // every project, by name
  machines: MachineHeading[]; // one per machine, the hub first, then the peers by name; [] with no peers
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

/**
 * One project's state, dot, and badge (red needs-human count, else gray active count, else none).
 * `jobs` are every job on its board, its epics' included; each epic waiting on you (`epics`, its
 * board's) is one more needs-human item, so a project whose only trouble is a waiting epic isn't idle.
 */
export function projectStatus(jobs: readonly Job[], epics: readonly Pick<Epic, 'waitingOn'>[] = []): { state: ProjectState; badge: Badge | null } {
  const human = jobs.filter((j) => j.stage === 'needs-human').length + epics.filter((e) => e.waitingOn === 'you').length;
  const active = jobs.filter(isActive);
  const state: ProjectState = human > 0 ? 'needs-human' : active.some(reviewFailed) ? 'review-failed' : active.length > 0 ? 'active' : 'idle';
  const badge = human > 0 ? redBadge(human) : active.length > 0 ? grayBadge(active.length) : null;
  return { state, badge };
}

const byName = (a: { name: string; id: string }, b: { name: string; id: string }): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** A machine heading's tooltip and accessible description: its reason, then its release, when known. */
const machineDetail = (m: Machine): string | null => {
  const parts = [m.reason, m.release === null ? null : `factory ${m.release}`].filter((x): x is string => x !== null && x !== '');
  return parts.length > 0 ? parts.join('\n') : null;
};

/** The machine headings for a sidebar's rows: the hub first, then the peers by name, each with its projects; [] with no peers. */
function machineHeadings(s: UiState, rows: readonly SidebarRow[], now: number): MachineHeading[] {
  if (!hasPeers(s)) return [];
  const hub = hubName(s) ?? '';
  const where = new Map(s.projects.map((p) => [p.id, remoteOf(s, p) ?? hub]));
  const listed = machineOrder(s.machines.list);
  const names = listed.map((m) => m.name);
  const extra = [...new Set(rows.map((r) => where.get(r.id) ?? hub))].filter((n) => !names.includes(n)).sort((a, b) => a.localeCompare(b));
  const heading = (name: string, m: Machine | undefined): MachineHeading => ({
    name,
    state: m?.state ?? null,
    status: m === undefined ? null : machineStateText(m, now),
    detail: m === undefined ? null : machineDetail(m),
    projects: rows.filter((r) => (where.get(r.id) ?? hub) === name),
  });
  return [...listed.map((m) => heading(m.name, m)), ...extra.map((n) => heading(n, undefined))];
}

/**
 * The sidebar: All Projects (badge: the total needs-human count, every machine's), then every project
 * by name; with peers, also grouped under a heading per machine (`now` dates a "down since").
 */
export function sidebarModel(s: UiState, sel: Selection, now: number = Date.now()): SidebarModel {
  const total = needsHuman(s).total;
  const running = s.release.info?.running ?? null;
  const projects = s.projects
    .map((p): SidebarRow => {
      const { state, badge } = projectStatus(s.boards[p.id]?.jobs ?? [], s.boards[p.id]?.epics ?? []);
      const line = releaseLine(p.release, running);
      const release: RowRelease | null = p.release === undefined || line === null ? null : { state: p.release.state, line, glyph: p.release.state === 'behind' ? { label: line } : null };
      const title = release === null ? p.root : `${p.root}\n${release.line}`;
      return { id: p.id, name: p.name, title, state, dot: DOTS[state], badge, selected: sel === p.id, release };
    })
    .sort(byName);
  const known = projects.some((p) => p.selected);
  return { all: { badge: total > 0 ? redBadge(total) : null, selected: sel === ALL || !known }, projects, machines: machineHeadings(s, projects, now) };
}

// ---- the connection footer ----

/**
 * What follows the footer's text while the connection is live: the machine's release (`v0.2.0`, a
 * button that opens the whole What's New sheet), or, when the service's clone has moved to another
 * release than the one it runs, a restart note that copies the restart command.
 */
export type FooterRelease =
  | { kind: 'version'; text: string; title: string } // text "v0.2.0", title "What's new in v0.2.0"
  | { kind: 'restart'; text: string; title: string; command: string }; // title: both releases and the command

export interface Footer {
  text: string; // "Connected · 3 machines · 12 projects"
  dot: 'green' | 'gray' | 'red';
  release: FooterRelease | null; // null: not live, or no release data (an older service)
  trouble?: string; // live with peers: each machine in trouble, "studio down · agentbox needs upgrade"; absent when none
  full?: string; // live with peers: the whole line (`footerLine`), the text's own tooltip, since a narrow sidebar truncates it
}

/** The footer's release part, for release data; null when there is nothing to show. */
export function footerRelease(info: ReleaseInfo | null): FooterRelease | null {
  if (info === null) return null;
  if (info.onDisk !== null && info.onDisk !== info.running) return { kind: 'restart', text: RESTART_NOTE, title: restartText(info.running, info.onDisk), command: RESTART_COMMAND };
  if (info.running === null) return null;
  return { kind: 'version', text: `v${info.running}`, title: whatsNewTitle(info.running) };
}

/** A machine's trouble in the footer: "<name> down", "<name> needs upgrade", or "<name> error"; null otherwise. */
function machineTrouble(m: Machine): string | null {
  if (m.state === 'down') return `${m.name} down`;
  if (m.state === 'error') return `${m.name} ${needsUpgrade(m) ? 'needs upgrade' : 'error'}`;
  return null;
}

/**
 * The footer. Live: "Connected · N projects", or, with peers (`machines` lists more than the hub),
 * "Connected · 3 machines · 12 projects", then (`trouble`) each machine in trouble in sidebar order
 * ("studio down", "agentbox needs upgrade"); the release part follows (`footerLine`). The trouble is
 * its own part so that, in a narrow sidebar, the counts truncate before it does.
 */
export function footer(status: Status, projects: number, release: ReleaseInfo | null = null, machines: readonly Machine[] = []): Footer {
  if (status === 'live') {
    const count = plural(projects, 'project', 'projects');
    if (machines.length <= 1) return { text: `Connected · ${count}`, dot: 'green', release: footerRelease(release) };
    const trouble = machineOrder(machines)
      .map(machineTrouble)
      .filter((t): t is string => t !== null);
    const text = ['Connected', plural(machines.length, 'machine', 'machines'), count].join(' · ');
    const f: Footer = trouble.length === 0 ? { text, dot: 'green', release: footerRelease(release) } : { text, dot: 'green', release: footerRelease(release), trouble: trouble.join(' · ') };
    return { ...f, full: footerLine(f) };
  }
  if (status === 'down') return { text: 'Unreachable', dot: 'red', release: null };
  return { text: 'Connecting…', dot: 'gray', release: null };
}

/** The footer as one line of text: "Connected · 3 projects · v0.2.0", or "Connected · 3 machines · 12 projects · studio down · v0.2.0". */
export const footerLine = (f: Footer): string => [f.text, f.trouble, f.release?.text].filter((x) => x !== undefined).join(' · ');

// ---- the toolbar ----

/** A listed project's label ("<name> · <machine>" for a remote one, else its name), or null for an unlisted id. */
function labelOf(s: UiState, pid: string): string | null {
  const p = s.projects.find((x) => x.id === pid);
  if (p === undefined) return null;
  const remote = remoteOf(s, p);
  return remote === null ? p.name : projectLabel({ name: p.name, remote });
}

/** The toolbar title: "Andon", or the selected project's label. */
export function title(s: UiState, sel: Selection): string {
  return sel === ALL ? 'Andon' : (labelOf(s, sel) ?? 'Andon');
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
  const scope = focused ? (labelOf(s, sel) ?? 'All Projects') : 'All Projects';
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
  { key: 'claimed', label: 'Claimed' },
  { key: 'spec', label: 'Spec' },
  { key: 'build', label: 'Building' },
  { key: 'review', label: 'In review' },
  { key: 'failed', label: 'Review failed' },
  { key: 'approve', label: 'At approver' },
  { key: 'merged', label: 'Merged' },
];

/** The legend's mark entries, after the swatches: the branch-merge icon on a member merged into its epic's branch. */
export const MARK_LEGEND: readonly LegendEntry[] = [{ key: 'in-epic', label: 'In epic' }];

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

/** What the page shows: the board, or (in the Mac app's Settings or About window) the settings or about view. */
export type AppView = 'board' | 'settings' | 'about';

/** `?shell=mac&view=settings` is the settings view and `?shell=mac&view=about` the about view; every
 *  other URL (a plain browser with `view=settings` or `view=about` too) is the board. */
export function appView(search: string): AppView {
  if (shellMode(search) !== 'mac') return 'board';
  const view = new URLSearchParams(search).get('view');
  return view === 'settings' ? 'settings' : view === 'about' ? 'about' : 'board';
}

// ---- the Mac app's pushed events ----
// The Mac app's View menu hides or shows the status bar and the Merged column and pushes each choice
// to the page as an event; its other View items (Needs Me, Show Settled…, Show Backlog…, the sidebar, the
// inspector) push an event asking the page to act. In a browser there are no such events: the
// status bar and the Merged column always show.

/** The event the Mac app pushes with the status bar state: `{ hidden: boolean }`. */
export const STATUS_BAR_EVENT = 'statusbar';
/** The event the Mac app pushes when Help → What's New is chosen: the page opens the whole What's New sheet. Its payload is ignored. */
export const WHATS_NEW_EVENT = 'whatsnew';
/** The event the Mac app pushes with the Merged column state: `{ hidden: boolean }`. */
export const MERGED_EVENT = 'merged';
// The View menu's page actions; their payloads are ignored.
export const NEEDS_ME_EVENT = 'needsme';
export const SETTLED_EVENT = 'settled';
export const BACKLOG_EVENT = 'backlog'; // View → Show Backlog… (067): open the whole Backlog sheet
export const SIDEBAR_EVENT = 'sidebar';
export const INSPECTOR_EVENT = 'inspector';
/** The event the Mac app pushes for File → New Exploration… and a project's right-click New
 *  Exploration… and Run Next: `{ action, project }`, a request the page checks (startwork.ts `startWorkPush`). */
export const START_WORK_EVENT = 'startwork';
/** Every event the page subscribes to: tinyjs.json's api gate names each as `event.<name>`, in this order. */
export const PUSHED_EVENTS: readonly string[] = [STATUS_BAR_EVENT, WHATS_NEW_EVENT, MERGED_EVENT, NEEDS_ME_EVENT, SETTLED_EVENT, BACKLOG_EVENT, SIDEBAR_EVENT, INSPECTOR_EVENT, START_WORK_EVENT];

/** What the page does for a View menu event. */
export type MenuEventAction = 'toggle-needs' | 'open-settled' | 'open-backlog' | 'toggle-sidebar' | 'toggle-inspector';

/** The page's action for a View menu page event; null for any other event. */
export function menuEventAction(event: string): MenuEventAction | null {
  switch (event) {
    case NEEDS_ME_EVENT:
      return 'toggle-needs';
    case SETTLED_EVENT:
      return 'open-settled';
    case BACKLOG_EVENT:
      return 'open-backlog';
    case SIDEBAR_EVENT:
      return 'toggle-sidebar';
    case INSPECTOR_EVENT:
      return 'toggle-inspector';
    default:
      return null;
  }
}

/** The View menu's page events, in menu order: App.svelte subscribes to each and acts by `menuEventAction`. */
export const MENU_EVENTS: readonly string[] = [NEEDS_ME_EVENT, SETTLED_EVENT, BACKLOG_EVENT, SIDEBAR_EVENT, INSPECTOR_EVENT];

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

/** The Merged column event's `hidden`, or null for a malformed payload (which changes nothing). */
export const mergedHidden = (data: unknown): boolean | null => statusBarHidden(data);

// ---- the main window's view state, reported to the Mac app ----
// The View menu's Needs Me, sidebar, and inspector labels follow the page: whenever one of those
// booleans changes, for any reason (a menu item, `n`, closing the inspector, a narrow window hiding
// the sidebar), the main window's page reports all three through the one view-state method, which
// the Mac app answers only for the main window. In a browser, and in the Settings window, nothing is sent.

/** The one Mac app backend method the main window's page calls with its view state. */
export const VIEW_STATE_METHOD = 'setViewState';

/** The main window's view state: Needs Me, the effective sidebar (`sidebarShown`), and the inspector. */
export interface ViewState {
  needsMe: boolean;
  sidebarShown: boolean;
  inspectorOpen: boolean;
}

/** Report one view state; a failed or refused call is ignored. */
export type ViewReporter = (v: ViewState) => void;

/**
 * How the main window's page reports its view state: Tiny's backend call, found by narrowing the
 * page's `window.tiny` (passed in as `unknown`), with the one fixed method name and only the three
 * booleans. A report equal to the last one is not sent again. Null in a browser, or when it isn't there.
 */
export function viewStateCaller(mode: ShellMode, host: unknown): ViewReporter | null {
  if (mode !== 'mac' || !isRecord(host) || !isRecord(host.api)) return null;
  const api = host.api;
  const call = api.call;
  if (typeof call !== 'function') return null;
  let last: ViewState | null = null;
  return (v) => {
    if (last !== null && last.needsMe === v.needsMe && last.sidebarShown === v.sidebarShown && last.inspectorOpen === v.inspectorOpen) return;
    last = { needsMe: v.needsMe, sidebarShown: v.sidebarShown, inspectorOpen: v.inspectorOpen };
    const { needsMe, sidebarShown, inspectorOpen } = last;
    try {
      const r: unknown = Reflect.apply(call, api, [VIEW_STATE_METHOD, { needsMe, sidebarShown, inspectorOpen }]);
      if (r instanceof Promise) r.catch(() => undefined);
    } catch {
      // the Mac app couldn't take it: the labels stay as they were
    }
  };
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
