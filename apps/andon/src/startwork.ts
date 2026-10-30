// Starting work in T3 Code from Andon (brief t3-start-work), runtime-neutral. The Backlog sheet and
// the brief and plan pages name a project, an action, and (as the action needs) a backlog item's
// slug, a free-text line's exact title, or the typed idea, through the one start method
// (START_WORK_METHOD), and nothing else: never a command or a prompt. Everything else lives here:
// the request's shape, the project from the backend's own `/projects` list, the named item checked
// against the service's live `GET /projects/<pid>/backlog` in the group its action needs, the
// `/factory next|epic|explore …` command (built from the service's copy of the item, exactly as the
// Andon UI's startwork.ts builds it), and the sent thread's title. The modes, the draft link, the
// `origin` read, the outcomes, and the failure text are the hand-off's (handoff.ts); backend.ts
// fetches the backlog, reads `origin`, opens the link or runs the argv (with no shell), and
// notifies. Andon still writes no job state and never edits `backlog.md`: the factory CLI and skill
// do, when the person (or a sent thread) runs the command.
// The slug rule is reimplemented here, on purpose: contract code must not run in the Mac app
// (boundary.test.ts), and a test pins the commands to the UI's.
import { MAX_COMMAND, quoteArg } from './handoff';
import { menuProject } from './projectmenu';
import type { MenuProject } from './projectmenu';
import { isRecord } from './state';

/** The one start method the main window's page calls (tinyjs.json's `api` gate names it). */
export const START_WORK_METHOD = 'startWork';

/** The five actions: Run (a queued brief or free-text line), Start epic (a queued epic line), Run
 *  next (a project), Continue exploring (a draft brief or plan), and New exploration (a project). */
export type StartAction = 'run' | 'epic' | 'next' | 'explore' | 'new-exploration';
const ACTIONS: readonly StartAction[] = ['run', 'epic', 'next', 'explore', 'new-exploration'];
const isAction = (v: unknown): v is StartAction => ACTIONS.some((a) => a === v);

/** The slug rule (`packages/contract`'s, reimplemented: see the header). */
export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The service's backlog path for a project (`GET /projects/<pid>/backlog`). */
export const backlogPath = (pid: string): string => `/projects/${encodeURIComponent(pid)}/backlog`;

/** A backlog item as far as starting work needs it: its kind, slug, and title, as the service sent them. */
export interface LiveItem {
  kind: 'brief' | 'epic' | 'text';
  slug: string | null;
  title: string;
}

/** The service's live backlog: its `queued` and `exploring` groups. */
export interface LiveBacklog {
  queued: LiveItem[];
  exploring: LiveItem[];
}

function liveItem(v: unknown): LiveItem | null {
  if (!isRecord(v) || typeof v.title !== 'string') return null;
  const { kind, slug } = v;
  if (kind !== 'brief' && kind !== 'epic' && kind !== 'text') return null;
  if (slug !== null && typeof slug !== 'string') return null;
  return { kind, slug, title: v.title };
}

function liveItems(v: unknown): LiveItem[] | null {
  if (!Array.isArray(v)) return null;
  return v.map(liveItem).filter((x): x is LiveItem => x !== null);
}

/** A `GET /projects/<pid>/backlog` body: `{ queued, exploring }`, two arrays (a malformed item is
 *  skipped). Null for anything else, which counts as a failed fetch. */
export function liveBacklog(data: unknown): LiveBacklog | null {
  if (!isRecord(data)) return null;
  const queued = liveItems(data.queued);
  const exploring = liveItems(data.exploring);
  return queued === null || exploring === null ? null : { queued, exploring };
}

/** The request's shape, checked, before the backlog is read: the listed project, the action, and
 *  what names its item (a slug, a free-text line's title, or the idea). */
export type StartShape =
  | { project: MenuProject & { root: string }; action: 'next' }
  | { project: MenuProject & { root: string }; action: 'run'; slug: string }
  | { project: MenuProject & { root: string }; action: 'run'; title: string }
  | { project: MenuProject & { root: string }; action: 'epic' | 'explore'; slug: string }
  | { project: MenuProject & { root: string }; action: 'new-exploration'; idea: string };

const sameKeys = (params: Record<string, unknown>, want: readonly string[]): boolean => {
  const keys = Object.keys(params).sort();
  const sorted = [...want].sort();
  return keys.length === sorted.length && keys.every((k, i) => k === sorted[i]);
};

/**
 * The page's request, checked without the backlog: a plain object with exactly the fields its action
 * needs, all strings (`{ project, action: 'next' }`; `{ project, action: 'run', slug }` or
 * `{ project, action: 'run', title }`; `{ project, action: 'epic' | 'explore', slug }`;
 * `{ project, action: 'new-exploration', idea }`), a project in the backend's `/projects` list with
 * an absolute root, a slug of the slug rule, a non-empty title, and a non-blank idea. Null for
 * anything else.
 */
export function startShape(params: unknown, projects: readonly MenuProject[]): StartShape | null {
  if (!isRecord(params)) return null;
  const { project: pid, action } = params;
  if (typeof pid !== 'string' || !isAction(action)) return null;
  const p = menuProject(projects, pid);
  if (p === null || !p.root.startsWith('/')) return null;
  const project = p;
  switch (action) {
    case 'next':
      return sameKeys(params, ['project', 'action']) ? { project, action } : null;
    case 'new-exploration': {
      const { idea } = params;
      if (!sameKeys(params, ['project', 'action', 'idea']) || typeof idea !== 'string' || idea.trim() === '') return null;
      return { project, action, idea };
    }
    case 'run': {
      const { slug, title } = params;
      if (sameKeys(params, ['project', 'action', 'title'])) return typeof title === 'string' && title !== '' ? { project, action, title } : null;
      if (!sameKeys(params, ['project', 'action', 'slug']) || typeof slug !== 'string' || !SLUG.test(slug)) return null;
      return { project, action, slug };
    }
    case 'epic':
    case 'explore': {
      const { slug } = params;
      if (!sameKeys(params, ['project', 'action', 'slug']) || typeof slug !== 'string' || !SLUG.test(slug)) return null;
      return { project, action, slug };
    }
  }
}

/** Whether the action names a backlog item (and so needs the live backlog): Run, Start epic, Continue exploring. */
export const needsBacklog = (s: StartShape): boolean => s.action === 'run' || s.action === 'epic' || s.action === 'explore';

/** The five commands. Run takes the service's title; New exploration quotes the idea as `handoff.ts` does. */
export const runCommand = (title: string): string => `/factory next ${title}`;
export const startEpicCommand = (slug: string): string => `/factory epic ${slug}`;
export const NEXT_COMMAND = '/factory next';
export const exploreCommand = (slug: string): string => `/factory explore ${slug}`;
export const newExplorationCommand = (idea: string): string => `/factory explore ${quoteArg(idea)}`;

/** A checked start: the listed project (with its absolute root), the action, the command the backend
 *  built, and the sent thread's title. */
export interface StartWork {
  project: MenuProject & { root: string };
  action: StartAction;
  command: string;
  title: string;
}

/** The named item, found in the group and kind its action needs, from the service's copy. */
function namedItem(s: StartShape, b: LiveBacklog): LiveItem | null {
  switch (s.action) {
    case 'run':
      if ('title' in s) return b.queued.find((i) => i.kind === 'text' && i.title === s.title) ?? null;
      return b.queued.find((i) => i.kind === 'brief' && i.slug === s.slug) ?? null;
    case 'epic':
      return b.queued.find((i) => i.kind === 'epic' && i.slug === s.slug) ?? null;
    case 'explore':
      return b.exploring.find((i) => (i.kind === 'brief' || i.kind === 'epic') && i.slug === s.slug) ?? null;
    default:
      return null;
  }
}

/** The command and the thread title for a checked shape, from the live backlog; null when the item
 *  isn't in its action's group (with its kind), a Run line's title is blank, or the backlog is needed and absent. */
function built(s: StartShape, b: LiveBacklog | null): { command: string; title: string } | null {
  switch (s.action) {
    case 'next':
      return { command: NEXT_COMMAND, title: 'next' };
    case 'new-exploration':
      return { command: newExplorationCommand(s.idea), title: 'explore' };
    default: {
      if (b === null) return null;
      const item = namedItem(s, b);
      if (item === null) return null;
      if (s.action === 'run') {
        if (item.title.trim() === '') return null;
        return { command: runCommand(item.title), title: `next ${item.slug ?? item.title}` };
      }
      if (s.action === 'epic') return { command: startEpicCommand(s.slug), title: `epic ${s.slug}` };
      return { command: exploreCommand(s.slug), title: `explore ${s.slug}` };
    }
  }
}

/** A checked shape and the live backlog (a `GET …/backlog` body; null when not fetched) → the start,
 *  or null: the item isn't where its action needs it, or the command is over MAX_COMMAND. */
export function startWorkFrom(s: StartShape, backlog: unknown): StartWork | null {
  const b = backlog === null ? null : liveBacklog(backlog);
  const r = built(s, b);
  if (r === null || r.command.length > MAX_COMMAND) return null;
  return { project: s.project, action: s.action, command: r.command, title: r.title };
}

/**
 * The page's request, checked whole: its shape (`startShape`), then its item against the live
 * backlog (`GET /projects/<pid>/backlog`'s body), then the command's length. Null for anything else.
 */
export function startWorkRequest(params: unknown, projects: readonly MenuProject[], backlog: unknown): StartWork | null {
  const s = startShape(params, projects);
  return s === null ? null : startWorkFrom(s, backlog);
}

/** The argv that starts a T3 Code thread titled by the action and item, in the project folder, with the command sent. */
export const startArgv = (t3: string, w: StartWork): string[] => [t3, 'thread', 'start', '--title', w.title, w.project.root, w.command];
