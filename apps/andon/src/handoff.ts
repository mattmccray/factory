// Handing a needs-human command to T3 Code (036), runtime-neutral. The page names a project, a job,
// an action, and (for rework and abandon) the person's note, through the one hand-off method
// (HAND_OFF_METHOD), and nothing else: never a command or a prompt. Everything else lives here: the
// request's checks (the project from the backend's own `/projects` list, the factory job id form,
// the three actions, a non-blank note, the 8,000-character limit), the `/factory …` command (built
// exactly as the Andon UI's inspector.ts builds it), the repository a draft names (brief
// andon-remote-handoff: T3 Code's primary remote among the project's listed `repositories`, the
// host allowlist, and the one-project-per-repository check over the whole merged list), the T3 Code
// prompt link (draft) and the `t3 thread start` argv (send), the answers the page's toast reads, and
// the failure text. backend.ts opens the link or runs the argv (with no shell), and notifies; it runs
// no `git`: each project's repositories come from its own machine's service. Andon still writes no
// job state: the factory CLI does, when the person (or a sent thread) runs the command.
// The job id check and the command building are reimplemented here, on purpose: contract code
// must not run in the Mac app (boundary.test.ts), and a test pins the command to the UI's.
import { menuProject } from './projectmenu';
import type { MenuProject } from './projectmenu';
import { isPart, isRecord } from './state';
import type { AppRepository } from './state';

/** The one hand-off method the main window's page calls (tinyjs.json's `api` gate names it). */
export const HAND_OFF_METHOD = 'handOff';

/** The main window's id: the hand-off is answered only for it. */
export const MAIN_WINDOW_ID = 'main';

/** The call came from the main window: Tiny's api meta names its id. Anything else is refused. */
export const fromMainWindow = (meta: unknown): boolean => isRecord(meta) && meta.window === MAIN_WINDOW_ID;

export type HandoffAction = 'approve' | 'rework' | 'abandon';
const ACTIONS: readonly HandoffAction[] = ['approve', 'rework', 'abandon'];
const isAction = (v: unknown): v is HandoffAction => ACTIONS.some((a) => a === v);

/** The factory job id form (`packages/contract`'s, reimplemented: see the header). */
export const JOB_ID = /^\d{3}-[a-z0-9-]+$/;

/** T3 Code's prompt limit: a longer command is refused. */
export const MAX_COMMAND = 8000;

/** A free-text argument for the skill: trimmed, newlines as spaces, `"` and `\` escaped, in double
 *  quotes. The same as the Andon UI's `quoteArg` (a test pins that both agree). */
export function quoteArg(text: string): string {
  const flat = text.trim().replace(/\r\n|\r|\n/g, ' ');
  return `"${flat.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** The `/factory …` command for an action: approve takes no note, rework and abandon quote theirs. */
export function factoryCommand(action: HandoffAction, job: string, note: string): string {
  return action === 'approve' ? `/factory approve ${job}` : `/factory ${action} ${job} ${quoteArg(note)}`;
}

/** A checked request: the listed project (with its absolute root), the job, the action, and the
 *  command the backend built. */
export interface Handoff {
  project: MenuProject & { root: string };
  job: string;
  action: HandoffAction;
  command: string;
}

/**
 * The page's request, checked: a plain object with exactly `project`, `job`, and `action` (and
 * `note`, for rework and abandon only), all strings; a project in the backend's `/projects` list
 * with an absolute root; a job id of the factory form; one of the three actions; a non-blank note
 * for rework and abandon; and a built command within MAX_COMMAND. Null for anything else.
 */
export function handoffRequest(params: unknown, projects: readonly MenuProject[]): Handoff | null {
  if (!isRecord(params)) return null;
  const { project, job, action, note } = params;
  if (typeof project !== 'string' || typeof job !== 'string' || !isAction(action)) return null;
  const keys = Object.keys(params).sort();
  const want = action === 'approve' ? ['action', 'job', 'project'] : ['action', 'job', 'note', 'project'];
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) return null;
  if (!JOB_ID.test(job)) return null;
  let text = '';
  if (action !== 'approve') {
    if (typeof note !== 'string' || note.trim() === '') return null;
    text = note;
  }
  const p = menuProject(projects, project);
  if (p === null || !p.root.startsWith('/')) return null;
  const command = factoryCommand(action, job, text);
  if (command.length > MAX_COMMAND) return null;
  return { project: p, job, action, command };
}

/** The hosts a T3 Code link's `repo=` can name: the one allowlist (brief andon-remote-handoff, Decision 3). */
export const T3_HOSTS: readonly string[] = ['github.com'];

/** Repositories in remote-name order. */
const byRemote = (a: AppRepository, b: AppRepository): number => (a.remote < b.remote ? -1 : a.remote > b.remote ? 1 : 0);

/** The remotes T3 Code prefers, in order; with neither, the first by remote name. */
const PREFERRED_REMOTES: readonly string[] = ['upstream', 'origin'];

/**
 * T3 Code's primary remote among a project's repositories: `upstream`, else `origin`, else the first
 * by remote name. Null with none.
 */
export function primaryRepository(repos: readonly AppRepository[]): AppRepository | null {
  for (const name of PREFERRED_REMOTES) {
    const r = repos.find((x) => x.remote === name);
    if (r !== undefined) return r;
  }
  return [...repos].sort(byRemote)[0] ?? null;
}

/** Whether a link can name the repository: its host is on the allowlist, and its owner and name are
 *  plain path parts (so `repo=<owner>/<name>` needs no escaping). */
export const linkable = (r: AppRepository): boolean => T3_HOSTS.includes(r.host.toLowerCase()) && isPart(r.owner) && isPart(r.name);

/** The same repository: host, owner, and name equal, compared without case. */
export const sameRepository = (a: AppRepository, b: AppRepository): boolean =>
  a.host.toLowerCase() === b.host.toLowerCase() && a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

/** The name a toast gives a project's machine: its entry's, else its id's, else "this Mac". */
export const machineLabel = (p: Pick<MenuProject, 'machine' | 'machineName'>): string => p.machineName ?? p.machine ?? 'this Mac';

/** Where a draft for a project can go: a link's `repo` (`<owner>/<name>`), no linkable remote at
 *  all, a primary repository that is also another listed project's (with every such project's
 *  machine, in feed order, each named once), or a primary remote that isn't linkable beside one
 *  that is (`primary`: the primary's remote name; `github`: the first linkable other remote's, by
 *  remote name; brief t3-primary-remote-toast). */
export type DraftTarget =
  | { kind: 'repo'; repo: string }
  | { kind: 'no-github-remote' }
  | { kind: 'several-machines'; machines: string[] }
  | { kind: 'not-primary'; primary: string; github: string };

/**
 * The draft target for `project` among `projects` (the backend's merged `/projects` list, local and
 * remote): its primary repository, when linkable, and exactly one listed project has it as its own
 * primary repository (brief andon-remote-handoff, Decision 5). A primary that isn't linkable, beside
 * another listed repository that is, is `not-primary`: T3 Code only matches its primary remote, so
 * the draft still can't go there (brief t3-primary-remote-toast, Decision 1), but the toast can name
 * the fix.
 */
export function draftTarget(project: MenuProject, projects: readonly MenuProject[]): DraftTarget {
  const primary = primaryRepository(project.repositories);
  if (primary === null) return { kind: 'no-github-remote' };
  if (!linkable(primary)) {
    const github = project.repositories.filter((r) => r !== primary && linkable(r)).sort(byRemote)[0];
    return github === undefined ? { kind: 'no-github-remote' } : { kind: 'not-primary', primary: primary.remote, github: github.remote };
  }
  const holders = projects.filter((p) => {
    const other = primaryRepository(p.repositories);
    return other !== null && sameRepository(other, primary);
  });
  if (holders.length > 1) {
    const machines: string[] = [];
    for (const p of holders) {
      const m = machineLabel(p);
      if (!machines.includes(m)) machines.push(m);
    }
    return { kind: 'several-machines', machines };
  }
  return { kind: 'repo', repo: `${primary.owner}/${primary.name}` };
}

/** T3 Code's prompt link: a new thread in the GitHub repo's project, with the command as an unsent
 *  draft. Only ever built with a repo. */
export const draftLink = (command: string, repo: string): string => `t3code://new?prompt=${encodeURIComponent(command)}&repo=${repo}`;

/** The argv that starts a T3 Code thread titled "<action> <job>" in the project folder, with the command sent. */
export const sendArgv = (t3: string, h: Handoff): string[] => [t3, 'thread', 'start', '--title', `${h.action} ${h.job}`, h.project.root, h.command];

/** Send mode for a remote project: a draft opened instead, since `t3 thread start` reaches only
 *  this Mac's T3 Code (`machine`: the machine the project is on). */
export interface DraftedNotSent {
  outcome: 'drafted-not-sent';
  machine: string;
}

/** The project's repository is several listed projects' primary: nothing opened, copy only. */
export interface SeveralMachines {
  outcome: 'several-machines';
  project: string; // the project's name
  machines: string[]; // the machines of every project with that repository, in feed order
}

/** The project's GitHub remote isn't T3 Code's primary one: nothing opened, copy only, and the
 *  toast names both remotes and the fix (make `github` the `upstream` remote). */
export interface GithubNotPrimary {
  outcome: 'github-not-primary';
  project: string; // the project's name
  primary: string; // T3 Code's primary remote's name, not on GitHub
  github: string; // the first GitHub remote's name, by remote name
}

/** What the hand-off did, for the page's toast: a draft opened, a thread sent, copy only (the copy
 *  mode, no `t3`, or a failure, which a notification explains), no GitHub remote for a draft, a
 *  draft opened in place of a send (a remote project), a repository on several machines, or a
 *  GitHub remote that isn't the primary one. */
export type HandoffOutcome = 'drafted' | 'sent' | 'copy-only' | 'no-github-remote' | DraftedNotSent | SeveralMachines | GithubNotPrimary;

/** The notification text when sending failed. */
export const sendFailureText = (reason: string): string => `Couldn't send to T3 Code: ${reason}`;

/** The notification text when opening the draft failed. */
export const draftFailureText = (reason: string): string => `Couldn't open a draft in T3 Code: ${reason}`;
