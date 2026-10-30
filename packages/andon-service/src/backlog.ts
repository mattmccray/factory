// The backlog and explorations (docs/contract/v1.md "Andon service", "Backlog in the service"): a
// pure, tolerant parser over the text of a project's `factory/backlog.md` and of its briefs and
// plans. It never throws and never reads a file; the service hands it the texts it read.
//   queued:    the open `- [ ] …` lines of backlog.md, in file order
//   exploring: every draft brief and draft plan that no open line points at, in slug order,
//              briefs before plans
import { SLUG_PATTERN, parsePlan, statusLine } from '@factory/contract';

export type BacklogKind = 'brief' | 'epic' | 'text';

/** One queued line, or one exploration. */
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

/** What the service read: backlog.md's text (null: none), and each brief's and plan's text by slug. */
export interface BacklogInput {
  backlog: string | null;
  briefs: ReadonlyMap<string, string>;
  plans: ReadonlyMap<string, string>;
}

/** A brief's or plan's facts: its title, `- Status:` value, `- Abandoned:` lines, and (a plan) members. */
export interface DocMeta {
  title: string;
  status: string | null;
  abandoned: string[];
  members: number;
}

/** True when `slug` matches the slug rule `^[a-z0-9]+(-[a-z0-9]+)*$`, safe to build a path from. */
export const isBacklogSlug = (slug: string): boolean => SLUG_PATTERN.test(slug);

const OPEN = '- [ ] ';
const SEP = ' — ';
const POINTER = /^(brief|epic): factory\/(briefs|epics)\/([^/]*)\.md$/;

/** A parsed open line: its kind, slug, title, and done-text (the file's facts come later). */
export interface QueuedLine {
  kind: BacklogKind;
  slug: string | null;
  title: string;
  done: string | null;
}

// Only `brief: factory/briefs/<slug>.md` and `epic: factory/epics/<slug>.md`, with a good slug.
function pointer(part: string): { kind: 'brief' | 'epic'; slug: string } | null {
  const m = POINTER.exec(part.trim());
  if (m === null) return null;
  const [, key, dir, slug = ''] = m;
  if (!isBacklogSlug(slug)) return null;
  if (key === 'brief' && dir === 'briefs') return { kind: 'brief', slug };
  if (key === 'epic' && dir === 'epics') return { kind: 'epic', slug };
  return null;
}

/** The open lines of backlog.md, in file order. Ticked lines and other text are ignored. */
export function parseBacklogLines(text: string): QueuedLine[] {
  const out: QueuedLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.startsWith(OPEN)) continue;
    const body = line.slice(OPEN.length).trim();
    const parts = body.split(SEP);
    const [title = '', ...rest] = parts;
    if (rest.length === 0) {
      out.push({ kind: 'text', slug: null, title: body, done: null });
      continue;
    }
    const last = rest[rest.length - 1] ?? '';
    const ptr = pointer(last);
    if (ptr === null) {
      out.push({ kind: 'text', slug: null, title: title.trim(), done: rest.join(SEP).trim() });
      continue;
    }
    const done = rest.slice(0, -1).join(SEP).trim();
    out.push({ kind: ptr.kind, slug: ptr.slug, title: title.trim(), done: done === '' ? null : done });
  }
  return out;
}

/** A brief's or plan's facts. `members` counts the `## Members` items `parsePlan` yields (0 if none). */
export function docMeta(slug: string, text: string): DocMeta {
  let title = slug;
  const abandoned: string[] = [];
  let titled = false;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!titled && line.startsWith('# ')) {
      const t = line.slice(2).trim();
      if (t !== '') title = t;
      titled = true;
    }
    if (line.startsWith('- Abandoned: ')) abandoned.push(line.slice('- Abandoned: '.length).trim());
  }
  let status: string | null = null;
  try {
    status = statusLine(text);
  } catch {
    status = null;
  }
  let members = 0;
  try {
    members = parsePlan(text).members.length;
  } catch {
    members = 0;
  }
  return { title, status, abandoned, members };
}

const bySlug = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The backlog's queued lines and explorations from the texts the service read. Never throws. */
export function buildBacklog(input: BacklogInput): Backlog {
  const lines = input.backlog === null ? [] : parseBacklogLines(input.backlog);
  const pointed = { brief: new Set<string>(), epic: new Set<string>() };
  const queued = lines.map((l): BacklogItem => {
    if (l.kind === 'text' || l.slug === null) return { ...l, status: null, members: null, abandoned: [] };
    if (l.kind === 'brief') pointed.brief.add(l.slug);
    else pointed.epic.add(l.slug);
    const text = (l.kind === 'brief' ? input.briefs : input.plans).get(l.slug);
    const meta = text === undefined ? null : docMeta(l.slug, text);
    return {
      ...l,
      status: meta?.status ?? null,
      members: l.kind === 'epic' ? (meta?.members ?? 0) : null,
      abandoned: meta?.abandoned ?? [],
    };
  });

  const exploring: BacklogItem[] = [];
  const drafts = (docs: ReadonlyMap<string, string>, kind: 'brief' | 'epic', skip: Set<string>): void => {
    for (const slug of [...docs.keys()].sort(bySlug)) {
      if (!isBacklogSlug(slug) || skip.has(slug)) continue;
      const meta = docMeta(slug, docs.get(slug) ?? '');
      if (meta.status !== 'draft') continue;
      exploring.push({ kind, slug, title: meta.title, done: null, status: meta.status, members: kind === 'epic' ? meta.members : null, abandoned: meta.abandoned });
    }
  };
  drafts(input.briefs, 'brief', pointed.brief);
  drafts(input.plans, 'epic', pointed.epic);
  return { queued, exploring };
}
