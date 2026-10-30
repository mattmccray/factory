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
 * it only copies, and the toast says "Copied …" (or that the copy failed).
 */
export async function copyThenStart(write: (command: string) => Promise<boolean>, start: StartWork | null, req: StartWorkRequest, command: string): Promise<Toast> {
  const copied = await write(command);
  const outcome = start === null ? null : await start(req);
  return handoffToast(copied, outcome, command);
}
