// A project's right-click menu in the Mac app: Copy Project Path, Reveal in Finder, a separator, and
// Open in ▸ VS Code, T3 Code, Ghostty. The page asks for a project's menu by its id alone (the one
// custom backend method, PROJECT_MENU_METHOD); everything else lives here, runtime-neutral: the item
// list and its ids, which apps are grayed out, where `t3` is looked for, each Open in app's bundle id
// and fallback `.app` locations and which item gets which icon, what a clicked item does (built only
// from the root the backend's own `/projects` feed holds), and the failure text. backend.ts sets the
// menu, checks the apps, finds their icons, and runs the actions.
import { isRecord } from './state';

/** The one custom backend method the page may call (tinyjs.json's `api` gate names it). */
export const PROJECT_MENU_METHOD = 'projectMenu';

/** What an item does. */
export type ProjectItem = 'copy' | 'reveal' | 'vscode' | 't3' | 'ghostty';
const ITEMS: readonly ProjectItem[] = ['copy', 'reveal', 'vscode', 't3', 'ghostty'];
const isProjectItem = (v: string): v is ProjectItem => ITEMS.some((i) => i === v);

/** The prefix of every project menu item id: `project-menu:<item>:<project id>`. */
export const ITEM_PREFIX = 'project-menu';
/** The Open in submenu's id (it is never clicked itself). */
export const OPEN_IN_ID = `${ITEM_PREFIX}:open-in`;

/** The apps' names, as `open -a` knows them. */
export const VSCODE_APP = 'Visual Studio Code';
export const GHOSTTY_APP = 'Ghostty';

/** A project the menu can act on: listed in the backend's `/projects` feed. */
export interface MenuProject {
  id: string;
  name: string;
  root: string | null;
}

/** Which apps exist, checked when the menu is built: VS Code and Ghostty installed, and the `t3` found (or null). */
export interface Availability {
  vscode: boolean;
  ghostty: boolean;
  t3: string | null;
}

/** One item of the context menu, in the shape Tiny's `menu.setContext` takes. */
export interface ContextItem {
  id?: string;
  label?: string;
  enabled?: boolean;
  separator?: boolean;
  submenu?: ContextItem[];
  /** A png path drawn beside the label (a menu item's `icon`, from Tiny JS 0.68.0). */
  icon?: string;
}

// ---- the Open in apps' own icons ----
// Each Open in item can carry its app's own icon: the backend finds the app's `.app` (Spotlight by
// bundle id first, then the fixed locations below), asks Tiny for a thumbnail of it, and hands the
// png path in here. Nothing here touches the machine.

/** An app of the Open in submenu. */
export type OpenInApp = 'vscode' | 't3' | 'ghostty';
export const OPEN_IN_APPS: readonly OpenInApp[] = ['vscode', 't3', 'ghostty'];

/** Each app's bundle id, as Spotlight (`kMDItemCFBundleIdentifier`) and `open -b` know it. */
export const BUNDLE_IDS: Readonly<Record<OpenInApp, string>> = {
  vscode: 'com.microsoft.VSCode',
  t3: 'com.t3tools.t3code',
  ghostty: 'com.mitchellh.ghostty',
};

/** Each app's display name, for log lines. */
export const APP_NAMES: Readonly<Record<OpenInApp, string>> = { vscode: 'VS Code', t3: 'T3 Code', ghostty: 'Ghostty' };

/** The `.app` folder names each app is looked for under, in order. */
const APP_BUNDLES: Readonly<Record<OpenInApp, readonly string[]>> = {
  vscode: ['Visual Studio Code.app'],
  t3: ['T3 Code.app', 'T3 Code (Beta).app'],
  ghostty: ['Ghostty.app'],
};

/** The icon png found for each app this session; an app with none has no key. */
export type AppIcons = Partial<Record<OpenInApp, string>>;

/** The Spotlight query for an app's bundle, as one `mdfind` argument. */
export const mdfindQuery = (app: OpenInApp): string => `kMDItemCFBundleIdentifier == "${BUNDLE_IDS[app]}"`;

/** Where an app's `.app` is looked for when Spotlight has no hit, in order: under `/Applications`,
 *  then under `~/Applications` (only when `home` is absolute). */
export function appFallbacks(app: OpenInApp, home: string | undefined): string[] {
  const dirs = ['/Applications'];
  if (typeof home === 'string' && home.startsWith('/')) dirs.push(`${home.replace(/\/+$/, '')}/Applications`);
  return dirs.flatMap((d) => APP_BUNDLES[app].map((b) => `${d}/${b}`));
}

/** `mdfind`'s first hit: its first non-blank line that is an absolute path, or null. */
export function mdfindHit(stdout: string | null): string | null {
  if (stdout === null) return null;
  return (
    stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('/')) ?? null
  );
}

/** The `.app` an app's icon comes from: `mdfind`'s first hit, else the first fallback present, else null. */
export function pickAppPath(app: OpenInApp, mdfindOut: string | null, home: string | undefined, present: (path: string) => boolean): string | null {
  return mdfindHit(mdfindOut) ?? appFallbacks(app, home).find(present) ?? null;
}

export const itemId = (item: ProjectItem, pid: string): string => `${ITEM_PREFIX}:${item}:${pid}`;

/** The item and project id an item id carries, or null when it isn't one of ours. */
export function parseItemId(id: string): { item: ProjectItem; pid: string } | null {
  const head = `${ITEM_PREFIX}:`;
  if (!id.startsWith(head)) return null;
  const rest = id.slice(head.length);
  const colon = rest.indexOf(':');
  if (colon < 0) return null;
  const item = rest.slice(0, colon);
  const pid = rest.slice(colon + 1);
  if (!isProjectItem(item) || pid === '') return null;
  return { item, pid };
}

/** Where `t3` is looked for, in order: the self-updating launcher in the home folder, then Homebrew's. */
export function t3Candidates(home: string | undefined): string[] {
  const out: string[] = [];
  if (typeof home === 'string' && home.startsWith('/')) out.push(`${home.replace(/\/+$/, '')}/.t3/bin/t3`);
  out.push('/opt/homebrew/bin/t3');
  return out;
}

/** The first `t3` candidate that is present, or null. */
export function pickT3(home: string | undefined, present: (path: string) => boolean): string | null {
  return t3Candidates(home).find(present) ?? null;
}

/** An Open in item, carrying its app's icon when one was found (enabled or not). */
function openInItem(pid: string, app: OpenInApp, enabled: boolean, icons: AppIcons): ContextItem {
  const item: ContextItem = { id: itemId(app, pid), label: APP_NAMES[app], enabled };
  const icon = icons[app];
  if (icon !== undefined) item.icon = icon;
  return item;
}

/** A project's menu, for the apps that are there, with the Open in icons found so far. */
export function projectMenuItems(pid: string, apps: Availability, icons: AppIcons = {}): ContextItem[] {
  return [
    { id: itemId('copy', pid), label: 'Copy Project Path' },
    { id: itemId('reveal', pid), label: 'Reveal in Finder' },
    { separator: true },
    {
      id: OPEN_IN_ID,
      label: 'Open in',
      submenu: [
        openInItem(pid, 'vscode', apps.vscode, icons),
        openInItem(pid, 't3', apps.t3 !== null, icons),
        openInItem(pid, 'ghostty', apps.ghostty, icons),
      ],
    },
  ];
}

/** The page's request: a project id, or null to restore the default menu. Null when malformed. */
export function menuRequest(params: unknown): { project: string | null } | null {
  if (!isRecord(params)) return null;
  const p = params.project;
  if (p === null) return { project: null };
  return typeof p === 'string' && p !== '' ? { project: p } : null;
}

/** The listed project with this id and a root, or null. */
export function menuProject(projects: readonly MenuProject[], pid: string): (MenuProject & { root: string }) | null {
  const p = projects.find((x) => x.id === pid);
  if (p === undefined || p.root === null || p.root === '') return null;
  return { ...p, root: p.root };
}

/** What a clicked item does: copy or reveal the root, or run an argv. */
export type ProjectAction =
  | { kind: 'copy'; root: string; project: string }
  | { kind: 'reveal'; root: string; project: string }
  | { kind: 'spawn'; argv: string[]; app: string; project: string };

const display = (p: MenuProject): string => (p.name === '' ? p.id : p.name);

/**
 * The action for a clicked item id: its project looked up again in the backend's list, its root
 * from there. Null (nothing runs) for an id that isn't ours, a project that isn't listed or has no
 * root, and T3 Code with no `t3` found.
 */
export function resolveAction(id: unknown, projects: readonly MenuProject[], t3: string | null): ProjectAction | null {
  if (typeof id !== 'string') return null;
  const parsed = parseItemId(id);
  if (parsed === null) return null;
  const p = menuProject(projects, parsed.pid);
  if (p === null) return null;
  const project = display(p);
  switch (parsed.item) {
    case 'copy':
      return { kind: 'copy', root: p.root, project };
    case 'reveal':
      return { kind: 'reveal', root: p.root, project };
    case 'vscode':
      return { kind: 'spawn', argv: ['open', '-a', VSCODE_APP, p.root], app: 'VS Code', project };
    case 't3':
      return t3 === null ? null : { kind: 'spawn', argv: [t3, 'app', p.root], app: 'T3 Code', project };
    case 'ghostty':
      return { kind: 'spawn', argv: ['open', '-a', GHOSTTY_APP, p.root], app: 'Ghostty', project };
  }
}

/** The notification text for an action that failed. */
export function failureText(action: ProjectAction, reason: string): string {
  switch (action.kind) {
    case 'copy':
      return `Couldn't copy the path of ${action.project}: ${reason}`;
    case 'reveal':
      return `Couldn't reveal ${action.project} in Finder: ${reason}`;
    case 'spawn':
      return `Couldn't open ${action.project} in ${action.app}: ${reason}`;
  }
}

/** A failed command's reason: the last line it wrote to stderr, or its exit status. */
export function exitReason(status: number, stderr: string): string {
  const last = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .at(-1);
  return last ?? `exited with status ${status}`;
}
