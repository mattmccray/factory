// Search and Needs Me (design §10), pure. Search matches a job's id, title, project name, and its
// epic's name and slug, case-insensitively, and an epic's name and slug; the board dims what doesn't
// match to 25% (tokens, sub-lanes, and whole lanes) and hides nothing. Needs Me hides every job that
// doesn't need a human to look at it, every sub-lane whose epic has none and doesn't wait on you,
// and every lane left with neither.
// Search also finds backlog items (brief andon-backlog-ui): queued and exploring items with a page
// whose title matches, listed under the search field; they never dim or light the board.
import { BACKLOG_HITS_MAX, docKey, pageOf } from './backlog';
import type { BacklogHit, BacklogList } from './backlog';
import { isEpicSettled, isSettled } from './board';
import type { BoardEpic, BoardJob } from './board';
import { epicName } from './job';
import type { Epic } from './job';
import { isReviewFailed } from './lanes';

/** The query as matched: trimmed and lower-cased. Empty means no search. */
export const normalize = (query: string): string => query.trim().toLowerCase();

/** Whether an epic matches a query: its name or slug contains it. An empty query matches everything. */
export function epicMatches(e: Pick<Epic, 'slug' | 'title'>, query: string): boolean {
  const q = normalize(query);
  return q === '' || [epicName(e), e.slug].some((s) => s.toLowerCase().includes(q));
}

/** Whether a job matches a query: its id, title, project name, or its epic's name or slug contains it. An empty query matches everything. */
export function matches(b: BoardJob, query: string): boolean {
  const q = normalize(query);
  if (q === '') return true;
  return [b.job.id, b.job.title, b.project.name].some((s) => s.toLowerCase().includes(q)) || (b.epic !== undefined && epicMatches(b.epic, q));
}

export interface Find {
  active: boolean; // a non-empty query: something may be dimmed
  keys: ReadonlySet<string>; // the matching jobs' keys
  epics: ReadonlySet<string>; // the matching epics' keys (`<pid>/<slug>`): a hit opens the epic page from its sub-lane's name
  dimLanes: ReadonlySet<string>; // project ids of lanes with no matching job or epic
  dimSubs: ReadonlySet<string>; // epic keys of sub-lanes whose epic and jobs all miss
}

const none = (): Find => ({ active: false, keys: new Set(), epics: new Set(), dimLanes: new Set(), dimSubs: new Set() });

/**
 * The search over the board: which jobs and epics match, which lanes are dimmed (exactly those with
 * no matching job or epic on them), and which sub-lanes are (those whose epic misses and whose jobs
 * all miss). A lane's jobs are the ones it shows: never settled or abandoned ones, focused or not;
 * its epics are its unsettled ones. An empty or whitespace query dims nothing.
 */
export function find(projects: ReadonlyArray<{ id: string }>, jobs: readonly BoardJob[], query: string, now: number, epics: readonly BoardEpic[] = []): Find {
  if (normalize(query) === '') return none();
  const onLane = (b: BoardJob): boolean => !isSettled(b, now);
  const hits = jobs.filter((b) => onLane(b) && matches(b, query));
  const shown = epics.filter((e) => !isEpicSettled(e.epic, e.settleAfterHours, now));
  const epicHits = shown.filter((e) => epicMatches(e.epic, query));
  const lit = new Set([...hits.map((b) => b.project.id), ...epicHits.map((e) => e.project.id)]);
  const litSubs = new Set([...epicHits.map((e) => e.key), ...hits.filter((b) => b.job.epic !== null).map((b) => `${b.project.id}/${b.job.epic}`)]);
  return {
    active: true,
    keys: new Set(hits.map((b) => b.key)),
    epics: new Set(epicHits.map((e) => e.key)),
    dimLanes: new Set(projects.map((p) => p.id).filter((id) => !lit.has(id))),
    dimSubs: new Set(shown.map((e) => e.key).filter((key) => !litSubs.has(key))),
  };
}

/**
 * Whether a job needs me: its stage is `needs-human` (Escalated, "Approved · not merged", and
 * merge-failed), or it is review-failed. An approver wait never does, however long it waits, and
 * neither does a merged, settled, or abandoned job.
 */
export const needsMe = (b: BoardJob): boolean => b.job.stage === 'needs-human' || isReviewFailed(b.job);

/**
 * Needs Me over the board: only the jobs that need me; only the epics waiting on you or with a job
 * that needs me (their sub-lanes); and only the projects with any of either left.
 */
export function needsFilter<P extends { id: string }>(projects: readonly P[], jobs: readonly BoardJob[], epics: readonly BoardEpic[] = []): { projects: P[]; jobs: BoardJob[]; epics: BoardEpic[] } {
  const kept = jobs.filter(needsMe);
  const needed = new Set(kept.filter((b) => b.job.epic !== null).map((b) => `${b.project.id}/${b.job.epic}`));
  const keptEpics = epics.filter((e) => e.epic.waitingOn === 'you' || needed.has(e.key));
  const ids = new Set([...kept.map((b) => b.project.id), ...keptEpics.map((e) => e.project.id)]);
  return { projects: projects.filter((p) => ids.has(p.id)), jobs: kept, epics: keptEpics };
}

/**
 * The search's Backlog results: each queued, then exploring, item of the given projects' cached
 * backlogs whose title contains the query (as `normalize` reads it) and that has a page (a `text`
 * line has none), in project order, at most `BACKLOG_HITS_MAX`. An empty query has none.
 */
export function backlogHits(projects: ReadonlyArray<{ id: string; name: string }>, lists: Readonly<Record<string, BacklogList>>, query: string): BacklogHit[] {
  const q = normalize(query);
  if (q === '') return [];
  const out: BacklogHit[] = [];
  for (const p of projects) {
    const list = lists[p.id];
    if (list === undefined) continue;
    const groups: Array<['Queued' | 'In exploration', BacklogList['queued']]> = [
      ['Queued', list.queued],
      ['In exploration', list.exploring],
    ];
    for (const [group, items] of groups) {
      for (const item of items ?? []) {
        const page = pageOf(p.id, item);
        if (page === null || !item.title.toLowerCase().includes(q)) continue;
        const key = docKey(page);
        if (out.some((h) => h.key === key)) continue; // two lines naming one brief: one result
        out.push({ key, title: item.title, project: p.name, kindLabel: page.kind === 'brief' ? 'Brief' : 'Epic', group, page });
        if (out.length >= BACKLOG_HITS_MAX) return out;
      }
    }
  }
  return out;
}
