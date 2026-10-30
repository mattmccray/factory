// Deep links and history (design §10): the URL hash holds the view, so a reload or a shared link
// restores it. The hash is a list of forms joined with `&`, each value URI-encoded:
//   project=<id>                    the focused project (absent: All Projects)
//   job=<project>/<job id>          the open inspector's job
//   epic=<project>/<slug>           the open inspector's epic page (instead of a job; it wins over job=)
//   brief=<project>/<slug>          the open inspector's brief page (instead of a job or an epic)
//   plan=<project>/<slug>           the open inspector's plan page (instead of a job or an epic)
//   file=<path|timing>              its selected file (only with job= or epic=)
//   settled  or  settled=<project>  the Settled sheet, optionally filtered to one project
//   backlog  or  backlog=<project>  the Backlog sheet, optionally filtered to one project
//   whats-new  or  whats-new=<project>  the What's New sheet: every release, or the ones a project is missing
//   needs                           the Needs Me filter
// The Rework, Abandon, and shortcut sheets, and an inspector open with nothing selected, have no
// hash form: they ride in `history.state`. Opening a layer pushes a history entry, so Back closes
// it; every other change (a file, the focus, Needs Me) replaces the entry. Pure: App.svelte reads
// and writes `location` and `history` with what this returns. `?shell=mac` stays in the query.
import { isSlug } from './backlog';
import type { DocRef } from './backlog';
import { TIMING } from './docs';
import { isRecord } from './job';

/** A job, by its project's id and its own id. */
export interface JobRef {
  project: string;
  id: string;
}

/** An epic, by its project's id and its slug. */
export interface EpicRef {
  project: string;
  slug: string;
}

/** The sheets with no hash form. */
export type SheetName = 'rework' | 'abandon' | 'epic-abandon' | 'keys';

/** Everything the URL and its history entry restore. */
export interface View {
  project: string | null; // the focused project; null: All Projects
  inspector: boolean; // the inspector is open (with `job` or `epic`, or "Nothing selected")
  job: JobRef | null;
  epic?: EpicRef | undefined; // the epic page; absent (or undefined): none. Never set together with `job`.
  page?: DocRef | undefined; // a brief's or plan's page; absent (or undefined): none. Never set together with `job` or `epic`.
  file: string | null; // a doc path, or TIMING; null: the inspector picks
  settled: { project: string | null } | null; // the Settled sheet and its project filter
  backlog: { project: string | null } | null; // the Backlog sheet and its project filter
  whatsNew: { project: string | null } | null; // the What's New sheet: whole (null), or scoped to one project
  sheet: SheetName | null;
  needs: boolean;
}

/** The default view: All Projects, nothing open. */
export const defaultView = (): View => ({ project: null, inspector: false, job: null, file: null, settled: null, backlog: null, whatsNew: null, sheet: null, needs: false });

/** The board's key for a job (`projects.ts` `boardJobs`). */
export const jobKey = (ref: JobRef): string => `${ref.project}/${ref.id}`;

/** The board's key for an epic (`projects.ts` `boardEpics`). */
export const epicKey = (ref: EpicRef): string => `${ref.project}/${ref.slug}`;

/** Whether a view's inspector shows something: a job, an epic, or a brief's or plan's page. */
const named = (v: View): boolean => v.job !== null || v.epic !== undefined || v.page !== undefined;

/** Whether a view's inspector shows a job or an epic: the subjects with files. */
const withFiles = (v: View): boolean => v.page === undefined && (v.job !== null || v.epic !== undefined);

const enc = encodeURIComponent;

function dec(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null; // a malformed escape: the form is ignored
  }
}

/** The hash for a view, with its leading `#`, or `''` for the default view. */
export function formatHash(v: View): string {
  const parts: string[] = [];
  if (v.project !== null) parts.push(`project=${enc(v.project)}`);
  if (v.page !== undefined) parts.push(`${v.page.kind}=${enc(v.page.project)}/${enc(v.page.slug)}`);
  else if (v.epic !== undefined) parts.push(`epic=${enc(v.epic.project)}/${enc(v.epic.slug)}`);
  else if (v.job !== null) parts.push(`job=${enc(v.job.project)}/${enc(v.job.id)}`);
  if (withFiles(v) && v.file !== null) parts.push(`file=${v.file === TIMING ? 'timing' : enc(v.file)}`);
  if (v.settled !== null) parts.push(v.settled.project === null ? 'settled' : `settled=${enc(v.settled.project)}`);
  if (v.backlog !== null) parts.push(v.backlog.project === null ? 'backlog' : `backlog=${enc(v.backlog.project)}`);
  if (v.whatsNew !== null) parts.push(v.whatsNew.project === null ? 'whats-new' : `whats-new=${enc(v.whatsNew.project)}`);
  if (v.needs) parts.push('needs');
  return parts.length > 0 ? `#${parts.join('&')}` : '';
}

/** `<project>/<rest>`, each half encoded: the first raw `/` is the separator. Null when either half is missing or malformed. */
function parsePair(value: string): [string, string] | null {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return null;
  const project = dec(value.slice(0, slash));
  const rest = dec(value.slice(slash + 1));
  return project === null || rest === null || project === '' || rest === '' ? null : [project, rest];
}

function parseJob(value: string): JobRef | null {
  const pair = parsePair(value);
  return pair === null ? null : { project: pair[0], id: pair[1] };
}

function parseEpic(value: string): EpicRef | null {
  const pair = parsePair(value);
  return pair === null ? null : { project: pair[0], slug: pair[1] };
}

/** A brief's or plan's page: its slug must pass the slug rule, or the form is ignored. */
function parsePage(kind: DocRef['kind'], value: string): DocRef | null {
  const pair = parsePair(value);
  return pair === null || !isSlug(pair[1]) ? null : { kind, project: pair[0], slug: pair[1] };
}

/**
 * The view a hash names (with or without its `#`). Unknown keys and malformed values are ignored,
 * so an empty or broken hash is the default view; it never throws. A file needs a job or an epic.
 * The inspector is open exactly when a job, an epic, or a page is named; one subject at a time: a
 * brief or plan page wins over an epic, and an epic over a job (the last good `brief=` or `plan=` wins).
 * A file needs a job or an epic, never a page.
 */
export function parseHash(hash: string): View {
  const v = defaultView();
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  let file: string | null = null;
  let epic: EpicRef | null = null;
  let page: DocRef | null = null;
  for (const part of body.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const key = eq < 0 ? part : part.slice(0, eq);
    const raw = eq < 0 ? null : part.slice(eq + 1);
    if (key === 'project' && raw !== null) {
      const p = dec(raw);
      if (p !== null && p !== '') v.project = p;
    } else if (key === 'job' && raw !== null) {
      v.job = parseJob(raw) ?? v.job;
    } else if (key === 'epic' && raw !== null) {
      epic = parseEpic(raw) ?? epic;
    } else if ((key === 'brief' || key === 'plan') && raw !== null) {
      page = parsePage(key, raw) ?? page;
    } else if (key === 'file' && raw !== null) {
      const f = raw === 'timing' ? TIMING : dec(raw);
      if (f !== null && f !== '') file = f;
    } else if (key === 'settled') {
      const p = raw === null || raw === '' ? null : dec(raw);
      v.settled = { project: p };
    } else if (key === 'backlog') {
      if (raw === null || raw === '') v.backlog = { project: null };
      else {
        const p = dec(raw);
        if (p !== null) v.backlog = { project: p }; // a malformed escape: the form is ignored
      }
    } else if (key === 'whats-new') {
      if (raw === null || raw === '') v.whatsNew = { project: null };
      else {
        const p = dec(raw);
        if (p !== null) v.whatsNew = { project: p }; // a malformed escape: the form is ignored
      }
    } else if (key === 'needs' && raw === null) {
      v.needs = true;
    }
  }
  if (page !== null) {
    v.page = page;
    v.job = null;
  } else if (epic !== null) {
    v.epic = epic;
    v.job = null;
  }
  v.inspector = named(v);
  v.file = withFiles(v) ? file : null;
  return v;
}

// ---- history.state ----

/** What a history entry carries besides its hash: the layers with no hash form, and the view under it. */
export interface EntryState {
  inspector: boolean; // open with nothing selected
  sheet: SheetName | null;
  under: string | null; // viewKey of the entry this one was pushed over
}

const SHEETS: readonly SheetName[] = ['rework', 'abandon', 'epic-abandon', 'keys'];

/** Narrows `history.state`; anything else (another app's state, or null) is no state. */
export function readEntry(state: unknown): EntryState {
  const a = isRecord(state) && isRecord(state.andon) ? state.andon : {};
  const sheet = SHEETS.find((s) => s === a.sheet) ?? null;
  return { inspector: a.inspector === true, sheet, under: typeof a.under === 'string' ? a.under : null };
}

/** The `history.state` for a view and the view it was pushed over. */
export const entryOf = (v: View, under: string | null): { andon: EntryState } => ({ andon: { inspector: v.inspector && !named(v), sheet: v.sheet, under } });

/** The view of a history entry: its hash, plus what its state carries. */
export function viewOf(hash: string, state: unknown): View {
  const v = parseHash(hash);
  const e = readEntry(state);
  return { ...v, inspector: v.inspector || e.inspector, sheet: e.sheet };
}

/** A view as one comparable string: two views are the same exactly when their keys are. */
export const viewKey = (v: View): string => `${formatHash(v)}|${v.inspector && !named(v) ? 'i' : ''}|${v.sheet ?? ''}`;

/**
 * The view on load: a present hash wins over the stored `andon.project` selection (`stored`, a
 * project id or `all`); with no hash, the stored selection is focused and nothing is open.
 */
export function initialView(hash: string, stored: string, all: string, state: unknown): View {
  if (hash.replace(/^#/, '') !== '') return viewOf(hash, state);
  return { ...viewOf('', state), project: stored === all ? null : stored };
}

export type Step = 'none' | 'push' | 'replace' | 'back';

/** Whether `next` opens a layer that `prev` didn't have: the inspector, the Settled or Backlog sheet, the What's New sheet, or another sheet. */
export const opensLayer = (prev: View, next: View): boolean =>
  (!prev.inspector && next.inspector) ||
  (prev.settled === null && next.settled !== null) ||
  (prev.backlog === null && next.backlog !== null) ||
  (prev.whatsNew === null && next.whatsNew !== null) ||
  (next.sheet !== null && next.sheet !== prev.sheet);

/**
 * How the history follows a view change. Opening a layer pushes, so Back closes it. Returning to
 * exactly the view the current entry was pushed over (`under`, a viewKey) goes back instead, so a
 * closed layer leaves no entry behind. Anything else (a file, the focus, Needs Me, a filter, a
 * What's New sheet's scope, a layer closing onto a different view) replaces the entry.
 */
export function historyStep(prev: View, next: View, under: string | null): Step {
  const key = viewKey(next);
  if (viewKey(prev) === key) return 'none';
  if (opensLayer(prev, next)) return 'push';
  if (under !== null && under === key) return 'back';
  return 'replace';
}
