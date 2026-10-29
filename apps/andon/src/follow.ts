// Follows the service's `GET /events` (`projects`, `board`, `error`), with no polling, like the UI's
// live.ts. Each `projects` event (sent on every connect, and when the registry changes) fetches
// `GET /projects/<pid>/board` once per listed project; after that, `board` and `error` events keep
// each project current. A stream that fails or ends is reopened after a fixed delay. Boards are
// never fetched on a timer. Runtime-neutral: it uses only the injected GET, `TextDecoder`,
// `ReadableStream`, and timers.
import { getJson, reason } from './http';
import type { Http } from './http';
import { createSseParser } from './sse';
import type { SseEvent } from './sse';
import { emptyState, isListed, isRecord, revOf, setBoard, setError, setProjects, toEpics, toJobs, toProjects } from './state';
import type { AppEpic, AppJob, AppProject, AppState } from './state';

export const RECONNECT_MS = 3000;

export const boardPath = (pid: string): string => `/projects/${encodeURIComponent(pid)}/board`;

export interface FollowHandlers {
  /** A stream opened (the first, or a reconnect). Its `projects` event follows. */
  onOpen?(): void;
  /** The stream failed or ended; it is reopened after the delay. */
  onDown?(why: string): void;
  /** A `projects` event replaced the list. */
  onProjects?(projects: AppProject[]): void;
  /** A project's board was applied (from a `board` event or its fetch): its jobs and its epics. */
  onBoard?(pid: string, jobs: AppJob[], epics: AppEpic[]): void;
  /** The state changed. */
  onState?(s: AppState): void;
}

export interface Follower {
  state(): AppState;
  stop(): void;
}

const parse = (text: string): { ok: true; data: unknown } | { ok: false } => {
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
};

export function startFollow(opts: FollowHandlers & { http: Http; retryMs?: number }): Follower {
  let state = emptyState();
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let reader: { cancel(): Promise<void> } | null = null;

  const set = (next: AppState): boolean => {
    if (stopped || next === state) return false;
    state = next;
    opts.onState?.(state);
    return true;
  };
  const board = (pid: string, jobs: AppJob[], epics: AppEpic[]): void => {
    if (set(setBoard(state, pid, jobs, epics))) opts.onBoard?.(pid, jobs, epics);
  };

  async function load(pid: string): Promise<void> {
    const rev = revOf(state, pid);
    let result: { ok: true; jobs: AppJob[]; epics: AppEpic[] } | { ok: false; reason: string };
    try {
      const data = await getJson(opts.http, boardPath(pid));
      result = { ok: true, jobs: toJobs(isRecord(data) ? data.jobs : null), epics: toEpics(isRecord(data) ? data.epics : null) };
    } catch (e) {
      result = { ok: false, reason: reason(e) };
    }
    // An event for this project since the request was sent is newer than this answer.
    if (stopped || !isListed(state, pid) || revOf(state, pid) !== rev) return;
    if (result.ok) board(pid, result.jobs, result.epics);
    else set(setError(state, pid, result.reason));
  }

  function handle(e: SseEvent): void {
    if (stopped) return;
    const msg = parse(e.data);
    if (!msg.ok) return;
    const data = msg.data;
    if (e.event === 'projects') {
      const projects = toProjects(data);
      if (projects === null) return;
      set(setProjects(state, projects));
      opts.onProjects?.(projects);
      for (const p of projects) void load(p.id);
      return;
    }
    if (!isRecord(data) || typeof data.project !== 'string' || !isListed(state, data.project)) return;
    if (e.event === 'board') board(data.project, toJobs(data.jobs), toEpics(data.epics));
    else if (e.event === 'error') set(setError(state, data.project, typeof data.reason === 'string' ? data.reason : 'config.json: unreadable'));
    // any other event type is ignored (docs/contract/v1.md "Versioning": readers are tolerant)
  }

  async function follow(): Promise<string> {
    const res = await opts.http('/events');
    if (!res.ok || res.body === null) {
      await res.body?.cancel().catch(() => undefined);
      return `GET /events: HTTP ${res.status}`;
    }
    if (stopped) {
      await res.body.cancel().catch(() => undefined);
      return 'stopped';
    }
    opts.onOpen?.();
    const r = res.body.getReader();
    reader = r;
    const decoder = new TextDecoder();
    const parser = createSseParser(handle);
    for (;;) {
      const { value, done } = await r.read();
      if (done || stopped) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.end();
    return 'the event stream ended';
  }

  function open(): void {
    follow().then(
      (why) => down(why),
      (e: unknown) => down(reason(e)),
    );
  }
  function down(why: string): void {
    reader = null;
    if (stopped) return;
    opts.onDown?.(why);
    retry = setTimeout(() => {
      retry = null;
      if (!stopped) open();
    }, opts.retryMs ?? RECONNECT_MS);
  }
  open();

  return {
    state: () => state,
    stop() {
      stopped = true;
      if (retry !== null) clearTimeout(retry);
      retry = null;
      void reader?.cancel().catch(() => undefined);
    },
  };
}
