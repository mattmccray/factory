// The slice of a fetch `Response` the Mac app reads, and the GET it is handed. A real `fetch`
// response satisfies it; under txiki the adapter supplies its own (see curl.ts). Runtime-neutral.

export interface HttpResponse {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

/** GETs a path on the service (`/projects`, `/events`, ...). Rejects when the service is unreachable. */
export type Http = (path: string) => Promise<HttpResponse>;

/** GETs JSON. A non-2xx response throws with the first line of its body (e.g. `config.json: <reason>`). */
export async function getJson(http: Http, path: string): Promise<unknown> {
  const res = await http(path);
  const body = await res.text();
  if (!res.ok) throw new Error(body.trim().split('\n')[0]?.slice(0, 160) || `HTTP ${res.status}`);
  return JSON.parse(body);
}

export const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));
