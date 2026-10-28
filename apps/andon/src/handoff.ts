// Handing a needs-human command to T3 Code (036), runtime-neutral. The page names a project, a job,
// an action, and (for rework and abandon) the person's note, through the one hand-off method
// (HAND_OFF_METHOD), and nothing else: never a command or a prompt. Everything else lives here: the
// request's checks (the project from the backend's own `/projects` list, the factory job id form,
// the three actions, a non-blank note, the 8,000-character limit), the `/factory …` command (built
// exactly as the Andon UI's inspector.ts builds it), the `origin` remote read as a GitHub
// `owner/name`, the T3 Code prompt link (draft) and the `t3 thread start` argv (send), the answers
// the page's toast reads, and the failure text. backend.ts reads `origin`, opens the link or runs
// the argv (with no shell), and notifies. Andon still writes no job state: the factory CLI does,
// when the person (or a sent thread) runs the command.
// The job id check and the command building are reimplemented here, on purpose: contract code
// must not run in the Mac app (boundary.test.ts), and a test pins the command to the UI's.
import { menuProject } from './projectmenu';
import type { MenuProject } from './projectmenu';
import { isRecord } from './state';

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

/** The argv that reads a project root's `origin` remote. */
export const originArgv = (root: string): string[] => ['git', '-C', root, 'remote', 'get-url', 'origin'];

const PART = '[A-Za-z0-9._-]+';
const GITHUB_ORIGINS: readonly RegExp[] = [
  new RegExp(`^https://github\\.com/(${PART})/(${PART})$`),
  new RegExp(`^git@github\\.com:(${PART})/(${PART})$`),
  new RegExp(`^ssh://git@github\\.com/(${PART})/(${PART})$`),
];

/**
 * The GitHub `owner/name` of an `origin` URL (git's output, so one trailing newline is fine):
 * `https://github.com/<owner>/<name>`, `git@github.com:<owner>/<name>`, or
 * `ssh://git@github.com/<owner>/<name>`, each with or without `.git`. Null for anything else
 * (another host, a local path, empty output, or no output: a failed `git`).
 */
export function githubRepo(origin: string | null): string | null {
  if (origin === null) return null;
  const url = origin.replace(/\r?\n$/, '');
  for (const re of GITHUB_ORIGINS) {
    const m = re.exec(url);
    const owner = m?.[1];
    const raw = m?.[2];
    if (owner === undefined || raw === undefined) continue;
    const name = raw.endsWith('.git') ? raw.slice(0, -'.git'.length) : raw;
    if (name === '' || owner === '.' || owner === '..' || name === '.' || name === '..') return null;
    return `${owner}/${name}`;
  }
  return null;
}

/** T3 Code's prompt link: a new thread in the GitHub repo's project, with the command as an unsent
 *  draft. Only ever built with a repo. */
export const draftLink = (command: string, repo: string): string => `t3code://new?prompt=${encodeURIComponent(command)}&repo=${repo}`;

/** The argv that starts a T3 Code thread titled "<action> <job>" in the project folder, with the command sent. */
export const sendArgv = (t3: string, h: Handoff): string[] => [t3, 'thread', 'start', '--title', `${h.action} ${h.job}`, h.project.root, h.command];

/** What the hand-off did, for the page's toast: a draft opened, a thread sent, copy only (the copy
 *  mode, no `t3`, or a failure, which a notification explains), or no GitHub remote for a draft. */
export type HandoffOutcome = 'drafted' | 'sent' | 'copy-only' | 'no-github-remote';

/** The notification text when sending failed. */
export const sendFailureText = (reason: string): string => `Couldn't send to T3 Code: ${reason}`;

/** The notification text when opening the draft failed. */
export const draftFailureText = (reason: string): string => `Couldn't open a draft in T3 Code: ${reason}`;
