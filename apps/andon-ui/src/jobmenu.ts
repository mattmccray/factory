// A job's native right-click menu, in the Mac app only (Open in T3 Code, Copy Job ID). As with the
// project menu (projectmenu.ts), the menu is the Mac app's: its backend fetches the job's board,
// checks the job's `session`, and builds the link. The page only says which job token the pointer is
// on, by its project id and job id, through one backend method, and never a thread id, a link, or a
// path. Board job tokens mark themselves with JOB_MENU_ATTR (the job id) and JOB_MENU_PROJECT_ATTR
// (its project id); "stopped here" ghosts, the inspector header, and the Settled sheet don't, so
// they get WebKit's own menu. In a browser nothing here does anything.
import { isRecord } from './job';
import type { ShellMode } from './sidebar';

/** The Mac app backend method for a job's menu (tinyjs.json's `api` gate enables it by name). */
export const JOB_MENU_METHOD = 'jobMenu';

/** The attributes a board job token carries: its job id, and its project's id. */
export const JOB_MENU_ATTR = 'data-job-menu';
export const JOB_MENU_PROJECT_ATTR = 'data-job-menu-project';

/** A job the menu is asked for: exactly a project id and a job id. */
export interface MenuJob {
  project: string;
  job: string;
}

/** Ask the Mac app for a job's menu. */
export type AskJobMenu = (job: MenuJob) => void;

/**
 * How the page asks for a job's menu: Tiny's backend call, found by narrowing `window.tiny` (passed
 * in as `unknown`), only ever with JOB_MENU_METHOD and `{ project, job }`. Null in a browser, or when
 * it isn't there.
 */
export function jobMenuCaller(mode: ShellMode, host: unknown): AskJobMenu | null {
  if (mode !== 'mac' || !isRecord(host) || !isRecord(host.api)) return null;
  const api = host.api;
  const call = api.call;
  if (typeof call !== 'function') return null;
  return ({ project, job }) => {
    try {
      const r: unknown = Reflect.apply(call, api, [JOB_MENU_METHOD, { project, job }]);
      if (r instanceof Promise) r.catch(() => undefined); // a refused or failed ask leaves the menu as it was
    } catch {
      // the same
    }
  };
}

/** The element an event target is, narrowed to the DOM member this needs. */
interface Marked {
  closest(selector: string): unknown;
}
const isMarked = (v: unknown): v is Marked => isRecord(v) && typeof v.closest === 'function';

/** An element's attribute, when it is a non-empty string. */
function attr(el: unknown, name: string): string | null {
  if (!isRecord(el) || typeof el.getAttribute !== 'function') return null;
  const v: unknown = Reflect.apply(el.getAttribute, el, [name]);
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * The job whose menu a pointer on `target` gets: the ids on the nearest board job token around it.
 * Null in a browser, and anywhere else (ghosts, the inspector, the Settled sheet, the rest).
 */
export function menuJobAt(mode: ShellMode, target: unknown): MenuJob | null {
  if (mode !== 'mac' || !isMarked(target)) return null;
  const el: unknown = target.closest(`[${JOB_MENU_ATTR}]`);
  const job = attr(el, JOB_MENU_ATTR);
  const project = attr(el, JOB_MENU_PROJECT_ATTR);
  return job === null || project === null ? null : { project, job };
}

/** A board token's job id, from its key (`<pid>/<job id>`, board.ts) and its project's id. */
export const tokenJobId = (key: string, project: string): string => (key.startsWith(`${project}/`) ? key.slice(project.length + 1) : '');
