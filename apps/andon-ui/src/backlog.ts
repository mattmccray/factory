// The backlog and explorations (brief andon-backlog-ui; docs/contract/v1.md "Andon service",
// "Backlog in the service"), pure. The service serves each project's backlog read-only as
// `GET /projects/<pid>/backlog` (`{ queued, exploring }`), its briefs and plans as
// `GET …/briefs/<slug>` and `GET …/plans/<slug>` (`{ path, text }`), and a narrow board's
// `backlog: { queued, exploring }` counts. This module narrows those payloads, builds the Backlog
// sheet's model (per project, a Queued group in backlog order and an In exploration group), and the
// brief and plan pages (a plan's members, with each member brief's `- Status:` value). It reads the
// plan's `## Members` and a brief's `- Status:` line itself, as the contract describes them: the
// UI never runs contract code (`boundary.test.ts`). Nothing here fetches or touches the DOM.
import { isRecord } from './job';
import { markdown } from './markdown';

/** A narrow board's backlog counts: the lengths of its project's `queued` and `exploring` lists. */
export interface BacklogCounts {
  queued: number;
  exploring: number;
}

export const NO_BACKLOG: BacklogCounts = { queued: 0, exploring: 0 };

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** A board's `backlog`; anything but `{ queued: <count>, exploring: <count> }` (absent, an older service, malformed) is none. */
export function toBacklogCounts(v: unknown): BacklogCounts {
  if (!isRecord(v) || !isCount(v.queued) || !isCount(v.exploring)) return NO_BACKLOG;
  return { queued: v.queued, exploring: v.exploring };
}

export type BacklogKind = 'brief' | 'epic' | 'text';

/** One queued line or one exploration, as the service sends it. */
export interface BacklogItem {
  kind: BacklogKind;
  slug: string | null;
  title: string;
  done: string | null;
  status: string | null;
  members: number | null; // a number for an epic, null otherwise
  abandoned: string[];
}

export interface Backlog {
  queued: BacklogItem[];
  exploring: BacklogItem[];
}

/** The slug rule (`^[a-z0-9]+(-[a-z0-9]+)*$`), checked before a slug becomes a path or a link. */
export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const isSlug = (s: string): boolean => SLUG.test(s);

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** One item; a malformed one (no known kind, no title) is null. A `brief` or `epic` with no good slug is kept as text. */
export function toBacklogItem(v: unknown): BacklogItem | null {
  if (!isRecord(v) || typeof v.title !== 'string') return null;
  if (v.kind !== 'brief' && v.kind !== 'epic' && v.kind !== 'text') return null;
  const slug = typeof v.slug === 'string' && isSlug(v.slug) ? v.slug : null;
  const kind: BacklogKind = v.kind !== 'text' && slug === null ? 'text' : v.kind;
  const abandoned = Array.isArray(v.abandoned) ? v.abandoned.filter((a): a is string => typeof a === 'string') : [];
  return {
    kind,
    slug: kind === 'text' ? null : slug,
    title: v.title,
    done: strOrNull(v.done),
    status: strOrNull(v.status),
    members: kind === 'epic' ? (isCount(v.members) ? v.members : 0) : null,
    abandoned,
  };
}

const items = (v: unknown): BacklogItem[] => (Array.isArray(v) ? v.map(toBacklogItem).filter((x): x is BacklogItem => x !== null) : []);

/** A `GET /projects/<pid>/backlog` body; a missing or malformed list is empty. */
export const toBacklog = (data: unknown): Backlog => ({ queued: items(isRecord(data) ? data.queued : null), exploring: items(isRecord(data) ? data.exploring : null) });

// ---- the pages: a brief or a plan ----

/** A brief's or a plan's page, by its project's id and its slug. A queued `epic` line opens its plan. */
export interface DocRef {
  kind: 'brief' | 'plan';
  project: string;
  slug: string;
}

/** The key a page is known by (`brief:<pid>/<slug>`). */
export const docKey = (r: DocRef): string => `${r.kind}:${r.project}/${r.slug}`;

/** The page an item opens: its brief, or its epic's plan; a `text` line has none. */
export function pageOf(project: string, item: BacklogItem): DocRef | null {
  if (item.slug === null || !isSlug(item.slug)) return null;
  if (item.kind === 'brief') return { kind: 'brief', project, slug: item.slug };
  if (item.kind === 'epic') return { kind: 'plan', project, slug: item.slug };
  return null;
}

const STATUS = /^- Status:(.*)$/;

/** A brief's or plan's `- Status:` value: the first such line before the first `## ` heading, trimmed; null when there is none. */
export function statusOf(text: string): string | null {
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) return null;
    const m = STATUS.exec(line.trimEnd());
    if (m !== null) return (m[1] ?? '').trim();
  }
  return null;
}

/** A brief's or plan's title: its first `# ` heading, else its slug. */
export function titleOf(text: string, slug: string): string {
  for (const line of text.split('\n')) if (line.startsWith('# ')) return line.slice(2).trim() || slug;
  return slug;
}

const MEMBER = /^- `([^`]+)`/;

/**
 * A plan's member slugs, in plan order: each column-0 `` - `<slug>` `` item of its `## Members`
 * section (to the next `#` or `##` heading) whose slug passes the slug rule, each once. Anything
 * else is skipped, never an error: the page lists what parses.
 */
export function planMembers(text: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (/^#{1,2} /.test(line)) {
      inside = line.trimEnd() === '## Members';
      continue;
    }
    if (!inside) continue;
    const slug = MEMBER.exec(line)?.[1];
    if (slug !== undefined && isSlug(slug) && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/** A fetched brief or plan: its text, missing (a 404), or unreadable (any other failure). */
export type DocText = { state: 'ok'; path: string; text: string } | { state: 'missing' } | { state: 'failed'; reason: string };

/** A `{ path, text }` body; anything else is null. */
export function toDocText(data: unknown): { path: string; text: string } | null {
  return isRecord(data) && typeof data.path === 'string' && typeof data.text === 'string' ? { path: data.path, text: data.text } : null;
}

/** One member row of a plan's page. */
export interface PlanMemberRow {
  n: number; // 1-based, plan order
  slug: string;
  status: string; // the brief's `- Status:` value, "no status", "no brief" (a 404), "unreadable", or "…" while it loads
  tone: 'ready' | 'done' | 'draft' | 'abandoned' | 'none';
  page: DocRef; // opens the member's brief
}

const toneOf = (status: string | null): PlanMemberRow['tone'] =>
  status === 'ready' || status === 'done' || status === 'draft' || status === 'abandoned' ? status : 'none';

/** A plan's member rows, in plan order: each member's brief status, from its fetched brief (absent: still loading). */
export function planMemberRows(project: string, slugs: readonly string[], briefs: ReadonlyMap<string, DocText>): PlanMemberRow[] {
  return slugs.map((slug, i): PlanMemberRow => {
    const b = briefs.get(slug);
    const page: DocRef = { kind: 'brief', project, slug };
    if (b === undefined) return { n: i + 1, slug, status: '…', tone: 'none', page };
    if (b.state === 'missing') return { n: i + 1, slug, status: 'no brief', tone: 'none', page };
    if (b.state === 'failed') return { n: i + 1, slug, status: 'unreadable', tone: 'none', page };
    const status = statusOf(b.text);
    return { n: i + 1, slug, status: status ?? 'no status', tone: toneOf(status), page };
  });
}

/** A brief's or plan's page in the inspector. */
export interface DocPage {
  ref: DocRef;
  project: string; // the project's name
  kindLabel: 'Brief' | 'Plan';
  title: string;
  status: string | null;
  path: string; // relative to factory/: briefs/<slug>.md or epics/<slug>.md
  html: string | null; // the text, rendered as job files are; null until it loads or when it can't
  note: string | null; // "Loading…", "No such brief.", or the reason it couldn't be read
  members: PlanMemberRow[] | null; // a plan's members; null for a brief
}

/** The page for a brief or plan, from its fetched text (null: still loading) and, for a plan, its members' fetched briefs. */
export function docPage(ref: DocRef, projectName: string, doc: DocText | null, briefs: ReadonlyMap<string, DocText> = new Map()): DocPage {
  const path = ref.kind === 'brief' ? `briefs/${ref.slug}.md` : `epics/${ref.slug}.md`;
  const kindLabel: DocPage['kindLabel'] = ref.kind === 'brief' ? 'Brief' : 'Plan';
  const base = { ref, project: projectName, kindLabel, path };
  if (doc === null) return { ...base, title: ref.slug, status: null, html: null, note: 'Loading…', members: null };
  if (doc.state === 'missing') return { ...base, title: ref.slug, status: null, html: null, note: `No such ${ref.kind}.`, members: null };
  if (doc.state === 'failed') return { ...base, title: ref.slug, status: null, html: null, note: doc.reason, members: null };
  return {
    ...base,
    path: doc.path,
    title: titleOf(doc.text, ref.slug),
    status: statusOf(doc.text),
    html: markdown(doc.text),
    note: null,
    members: ref.kind === 'plan' ? planMemberRows(ref.project, planMembers(doc.text), briefs) : null,
  };
}

// ---- the Backlog sheet ----

/** One project's cached backlog. */
export interface BacklogList {
  status: 'loading' | 'loaded' | 'failed';
  queued: BacklogItem[] | null; // the last list that arrived; null until one has
  exploring: BacklogItem[] | null;
  reason: string | null; // why the last fetch failed
  rev: number; // bumped by every fetch, so only the newest one applies
}

/** One row of the sheet. */
export interface BacklogRow {
  key: string;
  kind: BacklogKind;
  kindLabel: 'Brief' | 'Epic' | 'Text';
  title: string;
  done: string | null;
  members: string | null; // "3 members" for an epic
  status: string | null; // an exploration's status (draft)
  abandoned: string[]; // earlier abandoned attempts
  page: DocRef | null; // null: a text line, no page
}

export interface BacklogGroup {
  name: 'Queued' | 'In exploration';
  rows: BacklogRow[];
}

/** One project in the sheet: its groups (an empty one omitted), or why its backlog couldn't be read. */
export interface BacklogProject {
  id: string;
  name: string;
  loading: boolean; // no list has arrived yet
  reason: string | null; // the last fetch failed
  groups: BacklogGroup[];
}

export interface BacklogSheet {
  projects: BacklogProject[]; // the shown projects with something to show (rows, a failure, or a first load)
  loading: boolean; // some shown project's first list is still loading
  queued: number; // queued rows shown
  exploring: number; // exploration rows shown
}

const KIND_LABELS: Record<BacklogKind, BacklogRow['kindLabel']> = { brief: 'Brief', epic: 'Epic', text: 'Text' };

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function rowOf(project: string, group: 'q' | 'x', item: BacklogItem, i: number): BacklogRow {
  return {
    key: `${project}/${group}/${i}/${item.kind}/${item.slug ?? ''}`,
    kind: item.kind,
    kindLabel: KIND_LABELS[item.kind],
    title: item.title,
    done: item.done,
    members: item.kind === 'epic' ? plural(item.members ?? 0, 'member', 'members') : null,
    status: group === 'x' ? item.status : null,
    abandoned: item.abandoned,
    page: pageOf(project, item),
  };
}

/** The projects a Backlog sheet lists: one (its filter, when registered), or every project, in registration order. */
export const backlogProjects = (projects: ReadonlyArray<{ id: string }>, filter: string | null): string[] => projects.map((p) => p.id).filter((id) => filter === null || id === filter);

/**
 * The Backlog sheet's model over the shown projects' cached lists: per project, a Queued group (the
 * service's `queued`, in its order) and an In exploration group (its `exploring`, as served); an
 * empty group is omitted, and a project with neither (and no failure, and loaded) is left out. A
 * failed fetch shows that project's reason only; a list being re-fetched keeps showing the last one.
 */
export function backlogSheet(projects: ReadonlyArray<{ id: string; name: string }>, lists: Readonly<Record<string, BacklogList>>, filter: string | null): BacklogSheet {
  const out: BacklogProject[] = [];
  let loading = false;
  let queued = 0;
  let exploring = 0;
  for (const id of backlogProjects(projects, filter)) {
    const name = projects.find((p) => p.id === id)?.name ?? id;
    const list = lists[id];
    const first = list === undefined || (list.queued === null && list.status !== 'failed');
    if (first) loading = true;
    const q = (list?.queued ?? []).map((item, i) => rowOf(id, 'q', item, i));
    const x = (list?.exploring ?? []).map((item, i) => rowOf(id, 'x', item, i));
    queued += q.length;
    exploring += x.length;
    const groups: BacklogGroup[] = [];
    if (q.length > 0) groups.push({ name: 'Queued', rows: q });
    if (x.length > 0) groups.push({ name: 'In exploration', rows: x });
    const reason = list?.status === 'failed' ? (list.reason ?? 'unreadable') : null;
    if (groups.length > 0 || reason !== null || (first && filter !== null)) out.push({ id, name, loading: first, reason, groups });
  }
  return { projects: out, loading, queued, exploring };
}

/** The sheet's footer: "3 queued · 1 in exploration". */
export const backlogCountText = (s: Pick<BacklogSheet, 'queued' | 'exploring'>): string => `${s.queued} queued · ${s.exploring} in exploration`;

// ---- search ----

/** One backlog search result: an item with a page whose title matches. */
export interface BacklogHit {
  key: string;
  title: string;
  project: string; // the project's name
  kindLabel: 'Brief' | 'Epic';
  group: 'Queued' | 'In exploration';
  page: DocRef;
}

/** Search results shown at most. */
export const BACKLOG_HITS_MAX = 8;
