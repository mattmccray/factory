// An epic's native right-click menu, in the Mac app only (Open in T3 Code, Copy Epic Name). As with
// the job menu (jobmenu.ts), the menu is the Mac app's: its backend fetches the project's board,
// checks the epic's `session`, and builds the link. The page only says which epic name the pointer
// is on, by its project id and epic slug, through one backend method, and never a thread id, a link,
// or a path. An epic's name in its sub-lane marks itself with EPIC_MENU_ATTR (the slug) and
// EPIC_MENU_PROJECT_ATTR (its project id); the epic page, the inspector, and the rest don't, so they
// get WebKit's own menu. In a browser nothing here does anything.
import { isRecord } from './job';
import type { ShellMode } from './sidebar';

/** The Mac app backend method for an epic's menu (tinyjs.json's `api` gate enables it by name). */
export const EPIC_MENU_METHOD = 'epicMenu';

/** The attributes an epic's name in its sub-lane carries: the epic's slug, and its project's id. */
export const EPIC_MENU_ATTR = 'data-epic-menu';
export const EPIC_MENU_PROJECT_ATTR = 'data-epic-menu-project';

/** An epic the menu is asked for: exactly a project id and an epic slug. */
export interface MenuEpic {
  project: string;
  epic: string;
}

/** Ask the Mac app for an epic's menu. */
export type AskEpicMenu = (epic: MenuEpic) => void;

/**
 * How the page asks for an epic's menu: Tiny's backend call, found by narrowing `window.tiny`
 * (passed in as `unknown`), only ever with EPIC_MENU_METHOD and `{ project, epic }`. Null in a
 * browser, or when it isn't there.
 */
export function epicMenuCaller(mode: ShellMode, host: unknown): AskEpicMenu | null {
  if (mode !== 'mac' || !isRecord(host) || !isRecord(host.api)) return null;
  const api = host.api;
  const call = api.call;
  if (typeof call !== 'function') return null;
  return ({ project, epic }) => {
    try {
      const r: unknown = Reflect.apply(call, api, [EPIC_MENU_METHOD, { project, epic }]);
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
 * The epic whose menu a pointer on `target` gets: the ids on the nearest epic name around it. Null
 * in a browser, and anywhere else (the sub-lane's cells and job tokens, the epic page, the rest).
 */
export function menuEpicAt(mode: ShellMode, target: unknown): MenuEpic | null {
  if (mode !== 'mac' || !isMarked(target)) return null;
  const el: unknown = target.closest(`[${EPIC_MENU_ATTR}]`);
  const epic = attr(el, EPIC_MENU_ATTR);
  const project = attr(el, EPIC_MENU_PROJECT_ATTR);
  return epic === null || project === null ? null : { project, epic };
}
