// Live updates from the agent's `GET /events`, with no polling. Each `projects` event (sent on
// every connect and reconnect, and when the registry changes) fetches every listed project's
// board once; after that, `board` and `error` events keep each project current.
import type { Fetcher } from './api';
import { fetchBoard } from './api';
import { isRecord } from './job';
import { applyEvent, applyFetched, emptyState, revOf } from './state';
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
 * Follows the agent's events. `connect` opens `GET /events`; the browser retries a dropped
 * stream itself, and a stream it has given up on (CLOSED, e.g. the agent answered with an error)
 * is reopened after `RECONNECT_MS`.
 */
export function startLive(opts: {
  connect: () => EventSourceLike;
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

  async function load(pid: string): Promise<void> {
    const rev = revOf(state, pid);
    const result = await fetchBoard(opts.fetcher, pid);
    set(applyFetched(state, pid, rev, result));
  }

  const on = (event: string) => (e: unknown) => {
    const msg = parse(e);
    if (!msg.ok) return;
    set(applyEvent(state, event, msg.data));
    if (event === 'projects') for (const p of state.projects) void load(p.id);
  };
  function open(): void {
    const src = opts.connect();
    source = src;
    src.addEventListener('projects', on('projects'));
    src.addEventListener('board', on('board'));
    // `error` is both the agent's named event (a MessageEvent with data) and EventSource's own
    // connection error (no data): the first updates a project, the second marks the agent down.
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
    stop() {
      stopped = true;
      if (retry !== null) clearTimeout(retry);
      source.close();
    },
  };
}
