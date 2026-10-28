// A project's native right-click menu, in the Mac app only. The menu is the Mac app's (its backend
// builds it and runs what is chosen); the page only says which project the pointer is on, by id,
// through the one backend method it may call. Tiny's context menu is one setting for the window,
// not a popup at a point, so the page arms it while the pointer is over a sidebar project row or a
// lane's project gutter (and again on the press that opens it), and disarms it everywhere else
// (`null`: WebKit's own menu), so All Projects, job cells, and the rest of the page never show a
// stale project menu. A right-click or control-click changes no selection, focus, or route.
// Tiny doesn't tell the page when the menu closes, so there is no highlight ring.
// In a browser nothing here does anything: the browser's own menu shows.
// Nothing here touches the DOM itself; App.svelte wires the events, and rows mark themselves with
// PROJECT_MENU_ATTR.
import { isRecord } from './job';
import type { ShellMode } from './sidebar';

/** The one Mac app backend method the page calls (tinyjs.json's `api` gate enables it by name). */
export const PROJECT_MENU_METHOD = 'projectMenu';

/** The attribute a sidebar project row and a lane's gutter carry: the project's id. */
export const PROJECT_MENU_ATTR = 'data-project-menu';

/** Ask the Mac app for a project's menu, or (null) for WebKit's default menu. */
export type AskMenu = (project: string | null) => void;

/**
 * How the page asks for a project's menu: Tiny's backend call, found by narrowing the page's
 * `window.tiny` (passed in as `unknown`), and only ever with PROJECT_MENU_METHOD and a project id
 * or null. Null in a browser, or when it isn't there.
 */
export function projectMenuCaller(mode: ShellMode, host: unknown): AskMenu | null {
  if (mode !== 'mac' || !isRecord(host) || !isRecord(host.api)) return null;
  const api = host.api;
  const call = api.call;
  if (typeof call !== 'function') return null;
  return (project) => {
    try {
      const r: unknown = Reflect.apply(call, api, [PROJECT_MENU_METHOD, { project }]);
      if (r instanceof Promise) r.catch(() => undefined); // a refused or failed ask leaves WebKit's menu
    } catch {
      // the same
    }
  };
}

/** The element an event target is, narrowed to the two DOM members this needs. */
interface Marked {
  closest(selector: string): unknown;
}
const isMarked = (v: unknown): v is Marked => isRecord(v) && typeof v.closest === 'function';

/**
 * The project whose menu a pointer on `target` gets: the id on the nearest sidebar project row or
 * lane gutter around it. Null in a browser, and anywhere else (All Projects, job cells, the rest).
 */
export function menuProjectAt(mode: ShellMode, target: unknown): string | null {
  if (mode !== 'mac' || !isMarked(target)) return null;
  const el: unknown = target.closest(`[${PROJECT_MENU_ATTR}]`);
  if (!isRecord(el) || typeof el.getAttribute !== 'function') return null;
  const id: unknown = Reflect.apply(el.getAttribute, el, [PROJECT_MENU_ATTR]);
  return typeof id === 'string' && id !== '' ? id : null;
}

/** A press that opens the context menu: the secondary button, or a control-click. */
export const opensMenu = (e: { button: number; ctrlKey: boolean }): boolean => e.button === 2 || (e.button === 0 && e.ctrlKey);

/** A control-click on a project row or gutter in the Mac app opens the menu, so it must not also
 *  click through (select the project, focus it, or open the Settled sheet). */
export const swallowsClick = (mode: ShellMode, target: unknown, e: { button: number; ctrlKey: boolean }): boolean =>
  e.ctrlKey && e.button === 0 && menuProjectAt(mode, target) !== null;

export interface MenuArmer {
  /** The pointer moved onto `target`: ask when the project under it changed. */
  point(target: unknown): void;
  /** A press on `target`: when it opens the menu, ask again for the project under it. */
  press(target: unknown, e: { button: number; ctrlKey: boolean }): void;
  /** The pointer left the window. */
  leave(): void;
}

/** Arms the window's menu as the pointer moves: one ask per change of project, and one per opening press. */
export function menuArmer(mode: ShellMode, ask: AskMenu): MenuArmer {
  let armed: string | null = null;
  const set = (project: string | null, force: boolean): void => {
    if (!force && project === armed) return;
    armed = project;
    ask(project);
  };
  return {
    point: (target) => set(menuProjectAt(mode, target), false),
    press: (target, e) => {
      if (opensMenu(e)) set(menuProjectAt(mode, target), true);
    },
    leave: () => set(null, false),
  };
}
