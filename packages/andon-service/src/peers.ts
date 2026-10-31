// Following one Andon peer (docs/contract/v1.md "Andon service", "Andon peers"): the hub side of a
// machine listed in `$ANDON_HOME/peers.json`. One follower per listed URL:
//   - learns the peer's name and release from the first entry of its `GET /machines` (a 404 there
//     is a peer from before peers: `error`, naming `factory upgrade` and `factory service restart`);
//   - follows it with exactly two streams, `GET /events?scope=local` (plain) and
//     `GET /events?scope=local&settled=summary` (narrow), never polling: the peer's own watches and
//     settle timers drive every event;
//   - keeps the peer's local projects and the last board of each form for each of them, in memory
//     only, so a peer that drops stays listed with its last boards (`down`), and nothing is written;
//   - on a drop, reconnects with a backoff from 3 s, doubling, up to 60 s, on injected timers;
//   - fetches each project's boards (both forms) when it goes live, so clients get fresh `board`
//     events after a reconnect.
// Every request goes to the listed HTTPS URL only, through the injected transport, with
// `redirect: 'manual'`: a 3xx is a failure, never followed. Peer JSON and SSE data are `unknown`
// and narrowed here.
import { isMachineName, peerLabel } from '@factory/contract';

export type Form = 'plain' | 'narrow'; // a `/events` client's `board` form: every job, or `?settled=summary`
export type MachineState = 'live' | 'connecting' | 'down' | 'error';

/** One `GET /machines` entry and `machines` event entry. */
export interface MachineEntry {
  name: string;
  url: string;
  state: MachineState;
  since: string; // ISO 8601: when the machine entered `state`
  reason: string | null; // one line, or null
  release: string | null; // the peer's `GET /release` `running`
}

/** How the hub reaches its peers (default: `fetch`). Tests map a peer's HTTPS URL to a local server. */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

/** Sets and clears the reconnect timers (injectable so a test can see and fire what is pending). */
export interface ReconnectTimers {
  set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (t: ReturnType<typeof setTimeout>) => void;
}

export const FIRST_BACKOFF_MS = 3000;
export const MAX_BACKOFF_MS = 60_000;
/** How long a peer has to answer a request (or open a stream) before it counts as failed. */
export const PEER_TIMEOUT_MS = 10_000;

/** The largest event frame a peer may send (a board of many jobs is a few MiB at most). */
const MAX_FRAME = 32 * 2 ** 20;

/** The delay before reconnect attempt `n` (0-based): 3 s, doubling, up to 60 s. */
export const backoff = (n: number): number => Math.min(FIRST_BACKOFF_MS * 2 ** Math.min(n, 30), MAX_BACKOFF_MS);

const PID = /^[0-9a-f]{12}$/;
export const isPid = (s: string): boolean => PID.test(s);

const UPGRADE = 'run factory upgrade and factory service restart on that machine';

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';

/** A failed attempt: `down` (nothing answers, or the stream dropped) or `error` (it answers, but not as a peer may). */
class PeerFailure extends Error {
  constructor(
    readonly state: 'down' | 'error',
    reason: string,
  ) {
    super(reason);
  }
}

export interface SseFrame {
  event: string;
  data: string;
}

/** Splits complete `text/event-stream` frames off `buf`: each frame's `event` (default `message`) and its `data` lines joined. */
export function parseSse(buf: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  const norm = buf.replace(/\r\n?/g, '\n');
  const blocks = norm.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const key = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (key === 'event') event = value;
      else if (key === 'data') data.push(value);
    }
    if (data.length > 0) frames.push({ event, data: data.join('\n') });
  }
  return { frames, rest };
}

/** What a follower tells the hub. */
export interface FollowerHooks {
  /** The machine entry changed: send `machines`. */
  changed: () => void;
  /** The merged projects changed (or must be re-sent): send `projects`. */
  projects: () => void;
  /** A peer event for the hub's clients of `form`, its `project` already `<pid>@<name>`. */
  event: (form: Form, event: 'board' | 'backlog' | 'error', data: Rec) => void;
  /** Why `name` can't be this follower's (the hub's own, or an earlier peer's), or null; a later peer with it is put in error. */
  claim: (f: Follower, name: string) => string | null;
  log: (line: string) => void;
}

export interface FollowerOptions {
  url: string;
  transport: Transport;
  timers: ReconnectTimers;
  hooks: FollowerHooks;
  now?: () => Date;
}

export interface Follower {
  readonly url: string;
  /** The name it is addressed by: the learned one, else its URL's first host label. */
  name(): string;
  entry(): MachineEntry;
  /** Whether its projects and events are merged: not in error, with a learned name. */
  merged(): boolean;
  /** Its projects as the hub serves them: `<pid>@<name>`, `machine: <name>`, every other field passed through. */
  projects(): Rec[];
  /** The last board of `form` the hub holds for `pid`, or undefined. */
  board(pid: string, form: Form): unknown;
  /** Forwards a read of one of its projects (`path` starts `/projects/<pid>/`): the peer's status and body, or a 502 naming it. */
  forward(path: string, search: string, form?: Form): Promise<Response>;
  /** Puts it in error for a name clash: its streams close and nothing of it is merged until `restart`. */
  clash(reason: string): void;
  /** Whether it is in error for a name clash. */
  clashed(): boolean;
  start(): void;
  restart(): void;
  stop(): void;
}

const NO_STORE = { 'cache-control': 'no-store' };
const FORMS: readonly Form[] = ['plain', 'narrow'];

export function createFollower(opts: FollowerOptions): Follower {
  const { url, transport, timers, hooks } = opts;
  const now = opts.now ?? (() => new Date());
  const label = peerLabel(url);
  let learned: string | null = null;
  let state: MachineState = 'connecting';
  let since = now().toISOString();
  let reason: string | null = null;
  let release: string | null = null;
  let clashedBy: string | null = null;
  let stopped = false;
  let generation = 0;
  let attempts = 0; // reconnect attempts since it was last live
  let retry: ReturnType<typeof setTimeout> | null = null;
  let ctl: AbortController | null = null;
  let list: Rec[] = []; // the peer's projects as it sent them (scope=local)
  let listText = '[]';
  const boards = new Map<string, { plain?: unknown; narrow?: unknown }>();

  const name = (): string => learned ?? label;
  const merged = (): boolean => state !== 'error' && learned !== null;

  function set(next: MachineState, why: string | null): void {
    if (next === state && why === reason) return;
    if (next !== state) since = now().toISOString();
    state = next;
    reason = why;
    hooks.changed();
  }

  function dropProjects(): void {
    const had = list.length > 0;
    list = [];
    listText = '[]';
    boards.clear();
    if (had) hooks.projects();
  }

  function abort(): void {
    generation++;
    ctl?.abort();
    ctl = null;
  }

  function schedule(): void {
    if (stopped || clashedBy !== null || retry !== null) return;
    const ms = backoff(attempts);
    attempts++;
    retry = timers.set(() => {
      retry = null;
      void attempt();
    }, ms);
  }

  // A failure of the current attempt (or of a live stream): `down` keeps the projects and boards;
  // `error` drops them, since nothing of a peer in error is merged. Either way it reconnects later.
  function fail(gen: number, e: unknown): void {
    if (gen !== generation || stopped) return;
    abort();
    const f = e instanceof PeerFailure ? e : new PeerFailure('down', message(e));
    if (f.state === 'error') dropProjects();
    set(f.state, f.message);
    schedule();
  }

  // One request to the peer, following no redirect, within the timeout: the whole exchange for a
  // read, only until the headers for a stream (which then stays open).
  async function request(path: string, signal: AbortSignal, stream = false): Promise<Response> {
    const limit = new AbortController();
    const timer = setTimeout(() => limit.abort(new Error(`GET ${path}: no answer within ${PEER_TIMEOUT_MS / 1000} s`)), PEER_TIMEOUT_MS);
    let res: Response;
    try {
      res = await transport(`${url}${path}`, { redirect: 'manual', signal: AbortSignal.any([signal, limit.signal]), headers: { accept: stream ? 'text/event-stream' : 'application/json' } });
    } catch (e) {
      clearTimeout(timer);
      throw limit.signal.aborted && !signal.aborted ? new PeerFailure('down', message(limit.signal.reason)) : e;
    }
    // A read's body is still read under the limit; its timer is then a no-op that holds nothing open.
    if (stream) clearTimeout(timer);
    else timer.unref();
    if (res.status >= 300 && res.status < 400) throw new PeerFailure('error', `GET ${path} answered with a redirect (HTTP ${res.status}), which is never followed`);
    if (res.status >= 500) throw new PeerFailure('down', `GET ${path}: HTTP ${res.status}`);
    return res;
  }

  async function getJson(path: string, signal: AbortSignal): Promise<unknown> {
    const res = await request(path, signal);
    if (res.status === 404 && path === '/machines') throw new PeerFailure('error', `its Andon service is from before peers (no GET /machines); ${UPGRADE}`);
    if (!res.ok) throw new PeerFailure('error', `not an Andon service (GET ${path}: HTTP ${res.status})`);
    try {
      const body: unknown = JSON.parse(await res.text());
      return body;
    } catch (e) {
      if (signal.aborted) throw e;
      throw new PeerFailure('error', `not an Andon service (GET ${path} is not JSON)`);
    }
  }

  // A `projects` event from the peer: its local projects, each with a bare 12-hex id and a `machine`.
  function readProjects(data: unknown): Rec[] {
    if (!isRecord(data) || !Array.isArray(data.projects)) throw new PeerFailure('error', 'not an Andon service (its projects event is not { projects: [...] })');
    const out: Rec[] = [];
    for (const p of data.projects) {
      if (!isRecord(p) || typeof p.id !== 'string') throw new PeerFailure('error', 'not an Andon service (a project with no id)');
      if (p.id.includes('@') || typeof p.machine !== 'string') throw new PeerFailure('error', `its Andon service is from before peers (its projects ${p.id.includes('@') ? 'are not scope=local' : 'carry no machine'}); ${UPGRADE}`);
      if (!isPid(p.id)) throw new PeerFailure('error', `not an Andon service (project id ${JSON.stringify(p.id)})`);
      out.push(p);
    }
    return out;
  }

  // Rewrites a peer event's `project` to `<pid>@<name>`; null when it names no project of the peer's.
  function rewrite(data: unknown): { pid: string; data: Rec } | null {
    if (!isRecord(data) || typeof data.project !== 'string') return null;
    const pid = data.project;
    if (!list.some((p) => p.id === pid)) return null;
    return { pid, data: { ...data, project: `${pid}@${name()}` } };
  }

  function keepBoard(pid: string, form: Form, body: Rec): void {
    const rest: Rec = { ...body };
    delete rest.project;
    const b = boards.get(pid) ?? {};
    b[form] = rest;
    boards.set(pid, b);
  }

  function onFrame(gen: number, form: Form, frame: SseFrame, ready: () => void): void {
    if (gen !== generation || stopped) return;
    let data: unknown;
    try {
      data = JSON.parse(frame.data);
    } catch {
      return; // a frame that isn't JSON is skipped
    }
    if (frame.event === 'projects') {
      const next = readProjects(data);
      const text = JSON.stringify(next);
      if (text !== listText) {
        list = next;
        listText = text;
        for (const pid of [...boards.keys()]) if (!next.some((p) => p.id === pid)) boards.delete(pid);
        if (state === 'live') hooks.projects();
      }
      ready();
      return;
    }
    if (frame.event !== 'board' && frame.event !== 'backlog' && frame.event !== 'error') return; // `release` and `machines` stay the peer's own
    const r = rewrite(data);
    if (r === null) return;
    if (frame.event === 'board') keepBoard(r.pid, form, r.data);
    if (state === 'live') hooks.event(form, frame.event, r.data);
  }

  // Opens one stream and reads it in the background; resolves when its first `projects` event has
  // been read. The stream ending, or failing, is a drop.
  async function open(gen: number, path: string, form: Form, signal: AbortSignal): Promise<void> {
    const res = await request(path, signal, true);
    if (res.status !== 200 || !(res.headers.get('content-type') ?? '').startsWith('text/event-stream') || res.body === null) {
      throw new PeerFailure('error', `not an Andon service (GET ${path}: HTTP ${res.status})`);
    }
    const reader = res.body.getReader();
    let first: () => void = () => undefined;
    let firstFail: (e: unknown) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      first = resolve;
      firstFail = reject;
    });
    const decoder = new TextDecoder();
    void (async () => {
      let buf = '';
      try {
        let chunk = await reader.read();
        while (!chunk.done) {
          buf += decoder.decode(chunk.value, { stream: true });
          const parsed = parseSse(buf);
          buf = parsed.rest;
          if (buf.length > MAX_FRAME) throw new PeerFailure('error', `not an Andon service (an event larger than ${MAX_FRAME / 2 ** 20} MiB)`);
          for (const f of parsed.frames) onFrame(gen, form, f, first);
          chunk = await reader.read();
        }
        throw new PeerFailure('down', 'its event stream closed');
      } catch (e) {
        firstFail(e);
        fail(gen, e);
      } finally {
        reader.cancel().catch(() => undefined);
      }
    })();
    const timer = setTimeout(() => firstFail(new PeerFailure('down', `GET ${path}: no projects event within ${PEER_TIMEOUT_MS / 1000} s`)), PEER_TIMEOUT_MS);
    try {
      await ready;
    } finally {
      clearTimeout(timer);
    }
  }

  // Fetches every project's boards, both forms, as the hub's clients' fresh `board` events.
  async function freshBoards(gen: number, signal: AbortSignal): Promise<void> {
    await Promise.all(
      list.flatMap((p) =>
        FORMS.map(async (form) => {
          const pid = String(p.id);
          try {
            const res = await request(`/projects/${pid}/board${form === 'narrow' ? '?settled=summary' : ''}`, signal);
            if (!res.ok) return;
            const body: unknown = JSON.parse(await res.text());
            if (gen !== generation || stopped || !isRecord(body) || !list.some((q) => q.id === pid)) return;
            const data = { project: `${pid}@${name()}`, ...body };
            keepBoard(pid, form, data);
            if (state === 'live') hooks.event(form, 'board', data);
          } catch {
            // the board stays as last held; the streams say when the peer drops
          }
        }),
      ),
    );
  }

  async function attempt(): Promise<void> {
    if (stopped || clashedBy !== null) return;
    abort();
    const gen = generation;
    const c = new AbortController();
    ctl = c;
    try {
      const machines = await getJson('/machines', c.signal);
      const first: unknown = isRecord(machines) && Array.isArray(machines.machines) ? machines.machines[0] : undefined;
      if (!isRecord(first) || typeof first.name !== 'string' || !isMachineName(first.name)) throw new PeerFailure('error', 'not an Andon service (GET /machines is not { machines: [{ name, … }] })');
      if (gen !== generation || stopped) return;
      const reported = first.name;
      const clash = hooks.claim(self, reported);
      if (clash !== null) {
        clashNow(clash);
        return;
      }
      if (learned !== null && learned !== reported) dropProjects();
      const rel = typeof first.release === 'string' ? first.release : null;
      const renamed = learned !== reported || rel !== release;
      learned = reported;
      release = rel;
      // A peer that answers again is `connecting` until both streams are open; one in error stays
      // so (with its `since`) until it is live, so a retry that fails the same way changes nothing.
      if (state === 'down') set('connecting', null);
      else if (state === 'connecting' && (renamed || reason !== null)) {
        reason = null;
        hooks.changed();
      } else if (renamed) hooks.changed();
      await Promise.all([open(gen, '/events?scope=local', 'plain', c.signal), open(gen, '/events?scope=local&settled=summary', 'narrow', c.signal)]);
      if (gen !== generation || stopped) return;
      attempts = 0;
      set('live', null);
      hooks.projects();
      await freshBoards(gen, c.signal);
    } catch (e) {
      fail(gen, e);
    }
  }

  function clashNow(why: string): void {
    abort();
    if (retry !== null) timers.clear(retry);
    retry = null;
    clashedBy = why;
    dropProjects();
    set('error', why);
  }

  const self: Follower = {
    url,
    name,
    entry: () => ({ name: name(), url, state, since, reason, release }),
    merged,
    projects: () => (merged() ? list.map((p) => ({ ...p, id: `${String(p.id)}@${name()}`, machine: name() })) : []),
    board: (pid, form) => boards.get(pid)?.[form],
    async forward(path, search, form) {
      const who = name();
      if (state !== 'live') return new Response(`${who} is ${state}${reason === null ? '' : `: ${reason}`}`, { status: 502, headers: NO_STORE });
      try {
        const res = await request(`${path}${search}`, ctl?.signal ?? new AbortController().signal);
        const body = await res.arrayBuffer();
        // Only the two types the service itself answers with: a peer can't have the hub serve HTML.
        const json = (res.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json');
        const headers = { ...NO_STORE, 'content-type': json ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8' };
        if (res.status === 200 && form !== undefined) {
          try {
            const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
            const pid = path.split('/')[2] ?? '';
            if (isRecord(parsed)) keepBoard(pid, form, parsed);
          } catch {
            // not JSON: passed through, not kept
          }
        }
        return new Response(body, { status: res.status, headers });
      } catch (e) {
        return new Response(`${who}: ${message(e)}`, { status: 502, headers: NO_STORE });
      }
    },
    clash: clashNow,
    clashed: () => clashedBy !== null,
    start() {
      void attempt();
    },
    restart() {
      if (stopped) return;
      clashedBy = null;
      attempts = 0;
      if (retry !== null) timers.clear(retry);
      retry = null;
      void attempt();
    },
    stop() {
      stopped = true;
      abort();
      if (retry !== null) timers.clear(retry);
      retry = null;
    },
  };
  return self;
}
