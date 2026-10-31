// Starting work in T3 Code from the Backlog sheet and the brief and plan pages (brief
// t3-start-work). Each action copies its command first, so the clipboard always holds it; then, in
// the Mac app, it asks the Mac app to start the work through the one backend method the main window
// may call (START_WORK_METHOD), naming the project, the action, and the item's slug, a free-text
// line's exact title (a text line has no slug), or the typed idea, and nothing else: never a command
// or a prompt. The Mac app checks the item against the service's live backlog, builds the command
// itself from the service's copy, and drafts, sends, or only copies as its T3 Code setting says; the
// toast is the hand-off's (`handoffToast`). In a browser there is no caller: every action only
// copies. Andon writes no job state and never edits `backlog.md`. This module builds the requests
// and commands (the same strings the Mac app builds: a test pins that), the actions each row,
// project, and page offers, and the caller. Nothing here touches the DOM.
import type { BacklogItem, BacklogList, DocRef } from './backlog';
import { handoffToast, narrowOutcome } from './handoff';
import type { HandoffOutcome, Toast } from './handoff';
import { quoteArg } from './inspector';
import { isRecord } from './job';
import type { ShellMode } from './sidebar';

/** The one Mac app backend method starting work calls (tinyjs.json's `api` gate enables it by name). */
export const START_WORK_METHOD = 'startWork';

/** What the page names to start work: the project and action, and the item's slug, a free-text line's title, or the idea. */
export type StartWorkRequest = { project: string; action: 'next' } | { project: string; action: 'run'; slug: string } | { project: string; action: 'run'; title: string } | { project: string; action: 'epic' | 'explore'; slug: string } | { project: string; action: 'new-exploration'; idea: string };

/** T3 Code's prompt limit: the Mac app refuses a longer command. */
export const MAX_COMMAND = 8000;

/** The five commands, as the Mac app builds them. */
export const runCommand = (title: string): string => `/factory next ${title}`;
export const startEpicCommand = (slug: string): string => `/factory epic ${slug}`;
export const NEXT_COMMAND = '/factory next';
export const exploreCommand = (slug: string): string => `/factory explore ${slug}`;
export const newExplorationCommand = (idea: string): string => `/factory explore ${quoteArg(idea)}`;

/** An action's button label. */
export type StartLabel = 'Run' | 'Start epic' | 'Continue exploring' | 'Run next' | 'New exploration';

/** One action the page offers: its label, the request it names, and the command it copies. */
export interface StartItem {
  label: StartLabel;
  req: StartWorkRequest;
  command: string;
}

/** A queued line's action: Run on a brief or free-text line (named by its slug, or by its exact title), Start epic on an epic line. */
export function queuedStart(project: string, item: BacklogItem): StartItem | null {
  if (item.kind === 'epic') return item.slug === null ? null : { label: 'Start epic', req: { project, action: 'epic', slug: item.slug }, command: startEpicCommand(item.slug) };
  if (item.kind === 'brief') return item.slug === null ? null : { label: 'Run', req: { project, action: 'run', slug: item.slug }, command: runCommand(item.title) };
  return item.title === '' ? null : { label: 'Run', req: { project, action: 'run', title: item.title }, command: runCommand(item.title) };
}

/** An exploration's action: Continue exploring, on a draft brief or plan. */
export function exploringStart(project: string, item: BacklogItem): StartItem | null {
  if (item.kind === 'text' || item.slug === null) return null;
  return { label: 'Continue exploring', req: { project, action: 'explore', slug: item.slug }, command: exploreCommand(item.slug) };
}

/** A project's Run next. */
export const nextStart = (project: string): StartItem => ({ label: 'Run next', req: { project, action: 'next' }, command: NEXT_COMMAND });

/** A project's New exploration, with the typed idea. */
export const newExplorationStart = (project: string, idea: string): StartItem => ({ label: 'New exploration', req: { project, action: 'new-exploration', idea }, command: newExplorationCommand(idea) });

/**
 * A brief's or plan's page action, from its project's backlog: the action its item has in the live
 * list (a queued brief: Run; a queued epic: Start epic; an exploring brief or plan: Continue
 * exploring), or null when the item is in neither group (or the list hasn't arrived).
 */
export function pageStart(ref: DocRef, list: Pick<BacklogList, 'queued' | 'exploring'> | null | undefined): StartItem | null {
  const kind = ref.kind === 'brief' ? 'brief' : 'epic';
  const queued = list?.queued?.find((i) => i.kind === kind && i.slug === ref.slug);
  if (queued !== undefined) return queuedStart(ref.project, queued);
  const exploring = list?.exploring?.find((i) => i.kind === kind && i.slug === ref.slug);
  return exploring === undefined ? null : exploringStart(ref.project, exploring);
}

/** The New exploration sheet's command, and why it can't be copied (a blank idea, an over-long command), or null. */
export interface NewExploration {
  text: string;
  blocked: string | null;
}

export function newExploration(idea: string): NewExploration {
  const text = newExplorationCommand(idea);
  if (idea.trim() === '') return { text, blocked: 'An idea is required.' };
  if (text.length > MAX_COMMAND) return { text, blocked: `The command is over ${MAX_COMMAND.toLocaleString('en-US')} characters.` };
  return { text, blocked: null };
}

/** Ask the Mac app to start work; resolves with what it did, or null. */
export type StartWork = (req: StartWorkRequest) => Promise<HandoffOutcome | null>;

/**
 * How the page starts work: Tiny's backend call, found by narrowing the page's `window.tiny` (passed
 * in as `unknown`), as `handOffCaller` is, and only ever with START_WORK_METHOD and the request.
 * Null in a browser, or when it isn't there.
 */
export function startWorkCaller(mode: ShellMode, host: unknown): StartWork | null {
  if (mode !== 'mac' || !isRecord(host) || !isRecord(host.api)) return null;
  const api = host.api;
  const call = api.call;
  if (typeof call !== 'function') return null;
  return async (req) => {
    try {
      const r: unknown = await Reflect.apply(call, api, [START_WORK_METHOD, req]);
      return narrowOutcome(r);
    } catch {
      return null;
    }
  };
}

/**
 * One action, run: the command copied first (`write`), then, with a caller (the Mac app), the
 * request sent (`start`); the toast is the hand-off's for that outcome. With no caller (a browser),
 * it only copies, and the toast says "Copied …" (or that the copy failed). `machine` is the machine
 * a remote project is on (null: local): its copy-only toast names it ("Copied. Run it on studio").
 */
export async function copyThenStart(write: (command: string) => Promise<boolean>, start: StartWork | null, req: StartWorkRequest, command: string, machine: string | null = null): Promise<Toast> {
  const copied = await write(command);
  const outcome = start === null ? null : await start(req);
  return handoffToast(copied, outcome, command, machine);
}

// ---- the Mac app's startwork event (andon-explore-menus) ----
// File → New Exploration… (⌘N) and a project's right-click New Exploration… and Run Next push
// `startwork` to the page: a request only. The page checks it here, then runs Run next through
// `copyAndStart(nextStart(id))`, or opens the New exploration sheet, for the named project or, from
// the File menu (`project: null`), the one picked here.

/** A checked startwork request. */
export type StartWorkPush = { action: 'next'; project: string } | { action: 'new-exploration'; project: string | null };

/**
 * The startwork payload, checked: exactly `{ action, project }`, where `next` names a listed project
 * and `new-exploration` names a listed project or null. Anything else (a non-object, an unknown
 * action, an extra field, a non-string or empty project, an unlisted one, `next` with null) is null:
 * nothing happens.
 */
export function startWorkPush(data: unknown, listed: readonly { id: string }[]): StartWorkPush | null {
  if (!isRecord(data)) return null;
  const keys = Object.keys(data);
  if (keys.length !== 2 || !keys.includes('action') || !keys.includes('project')) return null;
  const { action, project } = data;
  const known = (id: unknown): id is string => typeof id === 'string' && id !== '' && listed.some((p) => p.id === id);
  if (action === 'next') return known(project) ? { action, project } : null;
  if (action === 'new-exploration') {
    if (project === null) return { action, project: null };
    return known(project) ? { action, project } : null;
  }
  return null;
}

/** A project the New exploration sheet can open for. */
export interface ExploreProject {
  id: string;
  name: string;
}

/** A listed project, as the chooser reads it: a root of '' is no root. */
type Listed = ExploreProject & { root: string | null };

const hasRoot = (p: Listed): boolean => p.root !== null && p.root !== '';
const pick = (p: Listed): ExploreProject => ({ id: p.id, name: p.name });
const byName = (a: ExploreProject, b: ExploreProject): number => a.name.localeCompare(b.name, 'en-US') || a.id.localeCompare(b.id, 'en-US');

/**
 * Where the picker starts: the last-explored project when it is still among `choices`, else the
 * first by name. Null for no choices.
 */
export function pickerStart(choices: readonly ExploreProject[], last: string | null): ExploreProject | null {
  const kept = last === null ? undefined : choices.find((p) => p.id === last);
  return kept ?? [...choices].sort(byName)[0] ?? null;
}

/** What the New exploration sheet opens with: its project, and the picker's choices (null: no picker). */
export interface ExploreOpen {
  project: ExploreProject;
  picker: ExploreProject[] | null;
}

/**
 * The sheet for a startwork `new-exploration`: a named project opens for that one with no picker. With
 * null (the File menu): the selected project (`selection`, a project id, or null under All Projects)
 * when it is listed with a root; else, with exactly one listed project with a root, that one; else,
 * with several, a picker of those (by name) starting on the last-explored one (`pickerStart`). Null
 * when there is nothing to open for.
 */
export function exploreOpen(project: string | null, selection: string | null, listed: readonly Listed[], last: string | null): ExploreOpen | null {
  const rooted = listed.filter(hasRoot);
  if (project !== null) {
    const p = rooted.find((x) => x.id === project);
    return p === undefined ? null : { project: pick(p), picker: null };
  }
  const selected = selection === null ? undefined : rooted.find((x) => x.id === selection);
  if (selected !== undefined) return { project: pick(selected), picker: null };
  const [only] = rooted;
  if (only === undefined) return null;
  if (rooted.length === 1) return { project: pick(only), picker: null };
  const choices = rooted.map(pick).sort(byName);
  const start = pickerStart(choices, last);
  return start === null ? null : { project: start, picker: choices };
}

/** The `localStorage` key of the last-explored project: set whenever a New exploration is started from the sheet. */
export const LAST_EXPLORED_KEY = 'andon.lastExplored';

/** The slice of `Storage` the last-explored key needs. */
export interface ExploreStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The stored last-explored project id, or null (none, empty, or storage blocked). */
export function loadLastExplored(store: ExploreStore | null): string | null {
  try {
    const v = store?.getItem(LAST_EXPLORED_KEY) ?? null;
    return v === null || v === '' ? null : v;
  } catch {
    return null;
  }
}

/** Remember the project a New exploration was started in. */
export function saveLastExplored(store: ExploreStore | null, project: string): void {
  try {
    store?.setItem(LAST_EXPLORED_KEY, project);
  } catch {
    // storage blocked or full: the picker just starts on the first by name
  }
}
