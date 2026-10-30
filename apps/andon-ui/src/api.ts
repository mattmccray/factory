// Reads from the Andon service. The fetch function is passed in, so tests can fake the service.
import { isSlug, toDocText } from './backlog';
import type { DocRef, DocText } from './backlog';
import type { BoardJob } from './board';
import { isRecord } from './job';
import { RELEASE_PATH, backlogPath, boardPath, briefPath, docsPath, epicDocsPath, planPath, settledPath } from './projects';

export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type Fetcher = (path: string) => Promise<FetchResponse>;

/** GETs JSON. A non-2xx response throws with the first line of its body (e.g. `config.json: <reason>`). */
export async function getJson(fetcher: Fetcher, path: string): Promise<unknown> {
  const res = await fetcher(path);
  const body = await res.text();
  if (!res.ok) throw new Error(body.trim().split('\n')[0]?.slice(0, 160) || `HTTP ${res.status}`);
  return JSON.parse(body);
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type Fetched = { ok: true; data: unknown } | { ok: false; reason: string };

async function fetchJson(fetcher: Fetcher, path: string): Promise<Fetched> {
  try {
    return { ok: true, data: await getJson(fetcher, path) };
  } catch (e) {
    return { ok: false, reason: reason(e) };
  }
}

/** One project's narrow board (`?settled=summary`), or the reason it couldn't be read. */
export const fetchBoard = (fetcher: Fetcher, pid: string): Promise<Fetched> => fetchJson(fetcher, boardPath(pid));

/** One project's settled jobs and epics (`{ jobs, epics }`), or the reason they couldn't be read (the first line of the error body). */
export const fetchSettled = (fetcher: Fetcher, pid: string): Promise<Fetched> => fetchJson(fetcher, settledPath(pid));

/** The service's release (`GET /release`), or the reason it couldn't be read (a 404 from an older service). */
export const fetchRelease = (fetcher: Fetcher): Promise<Fetched> => fetchJson(fetcher, RELEASE_PATH);

export interface DocFile {
  path: string; // relative to the project's factory/
  text: string;
}

/** A `{ files: [{ path, text }] }` payload's files; a malformed entry is skipped. */
function toFiles(data: unknown): DocFile[] {
  const files = isRecord(data) && Array.isArray(data.files) ? data.files : [];
  const out: DocFile[] = [];
  for (const f of files) if (isRecord(f) && typeof f.path === 'string' && typeof f.text === 'string') out.push({ path: f.path, text: f.text });
  return out;
}

/** A job's docs, from its own project's `/projects/<pid>/jobs/<id>/docs`. */
export const fetchDocs = async (fetcher: Fetcher, b: Pick<BoardJob, 'project' | 'job'>): Promise<DocFile[]> => toFiles(await getJson(fetcher, docsPath(b)));

/** An epic's docs (its plan, then its members' briefs), from its own project's `/projects/<pid>/epics/<slug>/docs`. */
export const fetchEpicDocs = async (fetcher: Fetcher, pid: string, slug: string): Promise<DocFile[]> => toFiles(await getJson(fetcher, epicDocsPath(pid, slug)));

/** One project's backlog (`{ queued, exploring }`), or the reason it couldn't be read (the first line of the error body). */
export const fetchBacklog = (fetcher: Fetcher, pid: string): Promise<Fetched> => fetchJson(fetcher, backlogPath(pid));

/** A brief's or plan's text: a 404 is `missing`, any other failure (or a malformed body) `failed` with its reason. A bad slug reads nothing. */
async function fetchDocText(fetcher: Fetcher, path: string | null): Promise<DocText> {
  if (path === null) return { state: 'missing' };
  try {
    const res = await fetcher(path);
    const body = await res.text();
    if (res.status === 404) return { state: 'missing' };
    if (!res.ok) return { state: 'failed', reason: body.trim().split('\n')[0]?.slice(0, 160) || `HTTP ${res.status}` };
    const doc = toDocText(JSON.parse(body));
    return doc === null ? { state: 'failed', reason: 'unreadable' } : { state: 'ok', ...doc };
  } catch (e) {
    return { state: 'failed', reason: reason(e) };
  }
}

/** A project's brief (`GET /projects/<pid>/briefs/<slug>`). */
export const fetchBrief = (fetcher: Fetcher, pid: string, slug: string): Promise<DocText> => fetchDocText(fetcher, isSlug(slug) ? briefPath(pid, slug) : null);

/** A project's plan (`GET /projects/<pid>/plans/<slug>`). */
export const fetchPlan = (fetcher: Fetcher, pid: string, slug: string): Promise<DocText> => fetchDocText(fetcher, isSlug(slug) ? planPath(pid, slug) : null);

/** A page's text: its brief or its plan. */
export const fetchPage = (fetcher: Fetcher, ref: DocRef): Promise<DocText> => (ref.kind === 'brief' ? fetchBrief(fetcher, ref.project, ref.slug) : fetchPlan(fetcher, ref.project, ref.slug));
