// Reads from the Andon service. The fetch function is passed in, so tests can fake the service.
import type { BoardJob } from './board';
import { isRecord } from './job';
import { boardPath, docsPath } from './projects';

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

/** One project's board, or the reason it couldn't be read. */
export async function fetchBoard(fetcher: Fetcher, pid: string): Promise<{ ok: true; data: unknown } | { ok: false; reason: string }> {
  try {
    return { ok: true, data: await getJson(fetcher, boardPath(pid)) };
  } catch (e) {
    return { ok: false, reason: reason(e) };
  }
}

export interface DocFile {
  path: string; // relative to the project's factory/
  text: string;
}

/** A job's docs, from its own project's `/projects/<pid>/jobs/<id>/docs`. */
export async function fetchDocs(fetcher: Fetcher, b: Pick<BoardJob, 'project' | 'job'>): Promise<DocFile[]> {
  const data = await getJson(fetcher, docsPath(b));
  const files = isRecord(data) && Array.isArray(data.files) ? data.files : [];
  const out: DocFile[] = [];
  for (const f of files) if (isRecord(f) && typeof f.path === 'string' && typeof f.text === 'string') out.push({ path: f.path, text: f.text });
  return out;
}
