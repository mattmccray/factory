// An epic's right-click menu in the Mac app: Open in T3 Code, a separator, and Copy Epic Name. It
// mirrors the job menu (jobmenu.ts): the page asks for an epic's menu by its project id and epic slug
// alone (EPIC_MENU_METHOD), answered only for the main window; everything else lives here,
// runtime-neutral: the request check, the epic slug form (the contract's, re-implemented: contract
// code doesn't run in the backend, decision 10), the item ids, the epic lookup on the service's own
// board (its `epics`, each the epic's `epic.json`), the items, and the failure text. The `session`
// check is the job menu's, imported, not copied, and backend.ts builds the link with the job menu's
// `threadLink`. backend.ts fetches the board,
// sets the menu, and opens or copies.
import { isJobId, isSession } from './jobmenu';
import type { Session } from './jobmenu';
import type { ContextItem } from './projectmenu';
import { SLUG } from './startwork';
import { isRecord } from './state';

/** The backend method the page calls for an epic's menu (tinyjs.json's `api` gate names it). */
export const EPIC_MENU_METHOD = 'epicMenu';

/** What an item does. */
export type EpicItem = 't3' | 'copy';
const ITEMS: readonly EpicItem[] = ['t3', 'copy'];
const isEpicItem = (v: string): v is EpicItem => ITEMS.some((i) => i === v);

/** The prefix of every epic menu item id: `epic-menu:<item>:<project id>:<epic slug>`. */
export const EPIC_ITEM_PREFIX = 'epic-menu';

/** The longest epic slug, in characters (`packages/contract`'s `SLUG_MAX`). */
export const EPIC_SLUG_MAX = 40;

/** An epic slug of the contract's form (`checkEpicSlug`): the slug rule, at most 40 characters, and
 *  not shaped like a job id. */
export const isEpicSlug = (v: unknown): v is string => typeof v === 'string' && v.length <= EPIC_SLUG_MAX && SLUG.test(v) && !isJobId(v);

/** An epic menu item's id. */
export const epicItemId = (item: EpicItem, pid: string, epic: string): string => `${EPIC_ITEM_PREFIX}:${item}:${pid}:${epic}`;

/** True when an item id belongs to the epic menu (`onContextMenu` sends it here). */
export const isEpicItemId = (id: string): boolean => id.startsWith(`${EPIC_ITEM_PREFIX}:`);

/** The item, project id, and epic slug an item id carries, or null when it isn't a well-formed one of ours. */
export function parseEpicItemId(id: unknown): { item: EpicItem; pid: string; epic: string } | null {
  if (typeof id !== 'string' || !isEpicItemId(id)) return null;
  const parts = id.slice(EPIC_ITEM_PREFIX.length + 1).split(':');
  if (parts.length !== 3) return null;
  const [item = '', pid = '', epic = ''] = parts;
  if (!isEpicItem(item) || pid === '' || !isEpicSlug(epic)) return null;
  return { item, pid, epic };
}

/** The page's request: exactly a non-empty project id and an epic slug of the contract's form. Null
 *  for anything else, including a request that carries any other field (a thread id, a link, a path). */
export function epicMenuRequest(params: unknown): { project: string; epic: string } | null {
  if (!isRecord(params)) return null;
  const keys = Object.keys(params).sort();
  if (keys.length !== 2 || keys[0] !== 'epic' || keys[1] !== 'project') return null;
  const { project, epic } = params;
  if (typeof project !== 'string' || project === '' || !isEpicSlug(epic)) return null;
  return { project, epic };
}

/** The epic with this slug in a board payload's `epics` (`{ epics: [...] }`, as the service gives
 *  it: each the epic's `epic.json`), or null. */
export function boardEpic(board: unknown, slug: string): Record<string, unknown> | null {
  if (!isRecord(board) || !Array.isArray(board.epics)) return null;
  for (const e of board.epics) if (isRecord(e) && e.slug === slug) return e;
  return null;
}

/** A board epic's `session`, when it passes the job menu's check; null when it is missing, null, or malformed. */
export function epicSession(e: Record<string, unknown>): Session | null {
  const s = e.session;
  return isSession(s) ? { app: s.app, environment: s.environment, thread: s.thread } : null;
}

/** An epic's menu: Open in T3 Code (grayed out unless it can open), a separator, and Copy Epic Name. */
export function epicMenuItems(pid: string, epic: string, canOpen: boolean): ContextItem[] {
  return [{ id: epicItemId('t3', pid, epic), label: 'Open in T3 Code', enabled: canOpen }, { separator: true }, { id: epicItemId('copy', pid, epic), label: 'Copy Epic Name' }];
}

/** The notification text for an epic that couldn't be opened in T3 Code. */
export const epicOpenFailureText = (epic: string, reason: string): string => `Couldn't open the epic ${epic} in T3 Code: ${reason}`;

/** The notification text for an epic name that couldn't be copied. */
export const epicCopyFailureText = (epic: string, reason: string): string => `Couldn't copy the epic name ${epic}: ${reason}`;

/** The reasons a click on Open in T3 Code finds nothing to open. */
export const EPIC_NOT_ON_BOARD = 'the epic is not on its board';
export const EPIC_NO_SESSION = 'the epic has no T3 Code thread recorded';
