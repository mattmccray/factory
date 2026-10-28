// A job's right-click menu in the Mac app: Open in T3 Code, a separator, and Copy Job ID. The page
// asks for a job's menu by its project id and job id alone (JOB_MENU_METHOD); everything else lives
// here, runtime-neutral: the request check, the job-id form, the item ids, the `session` check (the
// contract's rule, re-implemented: contract code doesn't run in the backend, decision 10), the link
// built only from a checked `session` on the service's own board, the items, and the failure text.
// backend.ts fetches the board, sets the menu, and opens or copies.
import { isRecord } from './state';
import type { ContextItem } from './projectmenu';

/** The backend method the page calls for a job's menu (tinyjs.json's `api` gate names it). */
export const JOB_MENU_METHOD = 'jobMenu';

/** What an item does. */
export type JobItem = 't3' | 'copy';
const ITEMS: readonly JobItem[] = ['t3', 'copy'];
const isJobItem = (v: string): v is JobItem => ITEMS.some((i) => i === v);

/** The prefix of every job menu item id: `job-menu:<item>:<project id>:<job id>`. */
export const JOB_ITEM_PREFIX = 'job-menu';

/** A factory job id: three digits, then a slug (docs/contract/v1.md, "File layout"). */
export const JOB_ID_PATTERN = /^\d{3}-[a-z0-9-]+$/;
export const isJobId = (v: unknown): v is string => typeof v === 'string' && JOB_ID_PATTERN.test(v);

/** The one `session` app accepted today, and the form of its ids (docs/contract/v1.md, "Session"). */
export const SESSION_APP = 't3code';
export const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** A job's orchestrator thread, as `job.json` stores it: ids only, never a link. */
export interface Session {
  app: typeof SESSION_APP;
  environment: string;
  thread: string;
}

/** True when `v` is a well-formed stored `session`: exactly `app`, `environment`, and `thread`. */
export function isSession(v: unknown): v is Session {
  return (
    isRecord(v) &&
    Object.keys(v).length === 3 &&
    v.app === SESSION_APP &&
    typeof v.environment === 'string' &&
    SESSION_ID_PATTERN.test(v.environment) &&
    typeof v.thread === 'string' &&
    SESSION_ID_PATTERN.test(v.thread)
  );
}

/** The T3 Code link to a thread, built only from a checked `session` (its ids need no escaping). */
export const threadLink = (s: Session): string => `t3code://threads/${s.environment}/${s.thread}`;

/** A job menu item's id. */
export const jobItemId = (item: JobItem, pid: string, job: string): string => `${JOB_ITEM_PREFIX}:${item}:${pid}:${job}`;

/** True when an item id belongs to the job menu (`onContextMenu` sends it here, not to the project menu). */
export const isJobItemId = (id: string): boolean => id.startsWith(`${JOB_ITEM_PREFIX}:`);

/** The item, project id, and job id an item id carries, or null when it isn't a well-formed one of ours. */
export function parseJobItemId(id: unknown): { item: JobItem; pid: string; job: string } | null {
  if (typeof id !== 'string' || !isJobItemId(id)) return null;
  const parts = id.slice(JOB_ITEM_PREFIX.length + 1).split(':');
  if (parts.length !== 3) return null;
  const [item = '', pid = '', job = ''] = parts;
  if (!isJobItem(item) || pid === '' || !isJobId(job)) return null;
  return { item, pid, job };
}

/** The page's request: exactly a non-empty project id and a job id of the factory form. Null for
 *  anything else, including a request that carries any other field (a thread id, a link, a path). */
export function jobMenuRequest(params: unknown): { project: string; job: string } | null {
  if (!isRecord(params)) return null;
  const keys = Object.keys(params).sort();
  if (keys.length !== 2 || keys[0] !== 'job' || keys[1] !== 'project') return null;
  const { project, job } = params;
  if (typeof project !== 'string' || project === '' || !isJobId(job)) return null;
  return { project, job };
}

/** The job with this id on a board payload (`{ jobs: [...] }`, as the service gives it), or null. */
export function boardJob(board: unknown, job: string): Record<string, unknown> | null {
  if (!isRecord(board) || !Array.isArray(board.jobs)) return null;
  for (const j of board.jobs) if (isRecord(j) && j.id === job) return j;
  return null;
}

/** A board job's `session`, when it passes the check; null when it is missing, null, or malformed. */
export function jobSession(j: Record<string, unknown>): Session | null {
  const s = j.session;
  return isSession(s) ? { app: s.app, environment: s.environment, thread: s.thread } : null;
}

/** A job's menu: Open in T3 Code (grayed out unless it can open), a separator, and Copy Job ID. */
export function jobMenuItems(pid: string, job: string, canOpen: boolean): ContextItem[] {
  return [{ id: jobItemId('t3', pid, job), label: 'Open in T3 Code', enabled: canOpen }, { separator: true }, { id: jobItemId('copy', pid, job), label: 'Copy Job ID' }];
}

/** The notification text for a job that couldn't be opened in T3 Code. */
export const openFailureText = (job: string, reason: string): string => `Couldn't open ${job} in T3 Code: ${reason}`;

/** The notification text for a job id that couldn't be copied. */
export const copyFailureText = (job: string, reason: string): string => `Couldn't copy the job ID ${job}: ${reason}`;

/** The reasons a click on Open in T3 Code finds nothing to open. */
export const NOT_ON_BOARD = 'the job is not on its board';
export const NO_SESSION = 'the job has no T3 Code thread recorded';
