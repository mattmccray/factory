// Live updates from the service's `GET /events?settled=summary`, with no polling. Each `projects`
// event (sent on every connect and reconnect, and when the registry changes) fetches every listed
// project's narrow board once; after that, `board` and `error` events keep each project current.
// Settled jobs are fetched on demand: `watch` names the projects whose settled lists an open view
// needs, and each is fetched once its board has loaded, then again whenever its settled summary
// changes, for as long as it is watched. A project no view needs is never fetched.
import type { Fetcher } from './api';
import { fetchBoard, fetchSettled } from './api';
import { isRecord } from './job';
import { EVENTS_PATH } from './projects';
import { applyEvent, applyFetched, applySettled, emptyState, revOf, startSettled, wantsSettled } from './state';
import type { UiState } from './state';

/** The slice of `EventSource` used here, so tests can drive it. */
export interface EventSourceLike {
  readonly readyState: number; // 2 (CLOSED): the browser gave up and won't reconnect on its own
  addEventListener(type: string, listener: (e: unknown) => void): void;
  close(): void;
}

const CLOSED = 2;
export const RECONNECT_MS = 3000;

export type Status = 'connecting' | 'live' | 'down';

export interface Live {
  state(): UiState;
  /** The projects whose settled lists the open views need; a project newly named retries a failed fetch. */
  watch(pids: readonly string[]): void;
  stop(): void;
}

const parse = (e: unknown): { ok: true; data: unknown } | { ok: false } => {
  if (!isRecord(e) || typeof e.data !== 'string') return { ok: false };
  try {
    return { ok: true, data: JSON.parse(e.data) };
  } catch {
    return { ok: false };
  }
};

/**
 * Follows the service's events. `connect` opens `GET /events`; the browser retries a dropped
 * stream itself, and a stream it has given up on (CLOSED, e.g. the service answered with an error)
 * is reopened after `RECONNECT_MS`.
 */
export function startLive(opts: {
  connect: (path: string) => EventSourceLike; // opens `path` (`EVENTS_PATH`)
  fetcher: Fetcher;
  onState: (s: UiState) => void;
  onStatus: (s: Status) => void;
  retryMs?: number;
}): Live {
  let state = emptyState();
  let stopped = false;
  let source: EventSourceLike;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const set = (next: UiState): void => {
    if (stopped || next === state) return;
    state = next;
    opts.onState(state);
  };

  let watched = new Set<string>();
  // Fetches every watched project's settled list that is missing or older than its summary.
  const sync = (retry: ReadonlySet<string>): void => {
    for (const pid of watched) if (!stopped && wantsSettled(state, pid, retry.has(pid))) void loadSettled(pid);
  };
  const update = (next: UiState): void => {
    set(next);
    sync(new Set());
  };

  async function loadSettled(pid: string): Promise<void> {
    const started = startSettled(state, pid);
    set(started.state);
    const result = await fetchSettled(opts.fetcher, pid);
    set(applySettled(state, pid, started.rev, result));
  }

  async function load(pid: string): Promise<void> {
    const rev = revOf(state, pid);
    const result = await fetchBoard(opts.fetcher, pid);
    update(applyFetched(state, pid, rev, result));
  }

  const on = (event: string) => (e: unknown) => {
    const msg = parse(e);
    if (!msg.ok) return;
    update(applyEvent(state, event, msg.data));
    if (event === 'projects') for (const p of state.projects) void load(p.id);
  };
  function open(): void {
    const src = opts.connect(EVENTS_PATH);
    source = src;
    src.addEventListener('projects', on('projects'));
    src.addEventListener('board', on('board'));
    // `error` is both the service's named event (a MessageEvent with data) and EventSource's own
    // connection error (no data): the first updates a project, the second marks the service down.
    src.addEventListener('error', (e) => {
      if (parse(e).ok) return on('error')(e);
      if (stopped || src !== source) return;
      opts.onStatus('down');
      if (src.readyState === CLOSED && retry === null) {
        retry = setTimeout(() => {
          retry = null;
          if (!stopped) open();
        }, opts.retryMs ?? RECONNECT_MS);
      }
    });
    src.addEventListener('open', () => {
      if (!stopped && src === source) opts.onStatus('live');
    });
  }
  opts.onStatus('connecting');
  open();

  return {
    state: () => state,
    watch(pids) {
      const added = new Set(pids.filter((pid) => !watched.has(pid)));
      watched = new Set(pids);
      sync(added);
    },
    stop() {
      stopped = true;
      if (retry !== null) clearTimeout(retry);
      source.close();
    },
  };
}
