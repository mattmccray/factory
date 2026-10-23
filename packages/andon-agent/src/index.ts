// The Andon agent (docs/contract/v1.md "Andon agent"): one Bun daemon per machine that reads every
// project listed in the Andon registry through `@factory/contract` and serves it, read-only, on
// loopback:
//   GET /projects                        → { projects: [{ id, name, root }] }
//   GET /projects/<pid>/board            → { jobs, config } (a bad config is a 500 carrying the reason)
//   GET /projects/<pid>/jobs/<id>/docs   → { files: [{ path, text }] }, that job's markdown in reading order
//   GET /events                          → text/event-stream of `projects`, `board`, and `error` events
//   GET /, GET /<asset>                  → the built Andon UI (`uiDir`), read-only; a path outside it is a 404
// Changes are found with fs.watch, never by polling: one recursive watch on each project's
// `factory/jobs/`, one non-recursive watch on its `factory/` (for `config.json`), and one on the
// registry file's directory. `.worktrees/` and `.lock/` are never watched or served.
// The board and docs readers are ported from the vendored `factory/serve.ts` (not imported).
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseConfig, readRegistry } from '@factory/contract';
import type { Config } from '@factory/contract';

export interface AgentOptions {
  port: number; // 0 picks a free port
  registryPath: string; // `$ANDON_HOME/projects.json`
  debounceMs?: number; // the burst window before one `board` event per project (default 50)
  log?: (line: string) => void; // diagnostics (default: stderr)
  uiDir?: string; // the Andon UI build (`apps/andon/dist`), served at `/`; absent or unbuilt: `/` is a 404
}

export interface Agent {
  url: string;
  stop: () => Promise<void>;
}

export interface ProjectInfo {
  id: string; // first 12 hex characters of sha256(root)
  name: string; // basename(root)
  root: string; // absolute repo root
}

type Job = Record<string, unknown>;

interface Project {
  info: ProjectInfo;
  factory: string; // <root>/factory
  lastGood: Map<string, Job>; // per job id: the last job.json that parsed
  factoryWatcher: FSWatcher | null;
  jobsWatcher: FSWatcher | null;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

export const HOSTNAME = '127.0.0.1';
const JOB_ID = /^\d{3}-[a-z0-9-]+$/;
const BRIEF = /^factory\/briefs\/[\w.-]+\.md$/;

/** A project's id: the first 12 hex characters of the SHA-256 of its absolute root. */
export const projectId = (root: string): string => createHash('sha256').update(root).digest('hex').slice(0, 12);

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';
const isRecord = (v: unknown): v is Job => typeof v === 'object' && v !== null && !Array.isArray(v);

async function entries(dir: string) {
  return readdir(dir, { withFileTypes: true }).catch(() => []);
}

// A job.json read mid-write (or not yet written) keeps the job's last good state, so its card
// never drops out of the board. Unknown fields are kept as is (readers are tolerant).
async function readJob(p: Project, id: string): Promise<Job | undefined> {
  try {
    const job: unknown = JSON.parse(await readFile(join(p.factory, 'jobs', id, 'job.json'), 'utf8'));
    if (isRecord(job)) p.lastGood.set(id, { ...job });
  } catch {
    // missing or mid-write: fall back to the last good read
  }
  return p.lastGood.get(id);
}

// Read per request, parsed strictly, so an edit to config.json shows up on the next read.
async function readConfig(p: Project): Promise<Config> {
  return parseConfig(JSON.parse(await readFile(join(p.factory, 'config.json'), 'utf8')));
}

async function board(p: Project): Promise<{ jobs: Job[]; config: Config }> {
  const config = await readConfig(p);
  const ids = (await entries(join(p.factory, 'jobs')))
    .filter((d) => d.isDirectory() && JOB_ID.test(d.name))
    .map((d) => d.name)
    .sort();
  const jobs = await Promise.all(ids.map((id) => readJob(p, id)));
  return { jobs: jobs.filter((j) => j !== undefined), config };
}

const num = (name: string): number => Number(name.match(/\d+/)?.[0] ?? 0);

// `id` is already checked against JOB_ID. Paths in `files` are relative to factory/.
async function docs(p: Project, id: string): Promise<{ files: Array<{ path: string; text: string }> }> {
  const { reviewers } = await readConfig(p);
  const dir = join(p.factory, 'jobs', id);
  if ((await lstat(dir).catch(() => null))?.isDirectory() !== true) return { files: [] }; // never through a symlinked job dir
  const top = (await entries(dir)).filter((d) => d.isFile()).map((d) => d.name);
  const reworks = top.filter((f) => /^rework-\d+\.md$/.test(f)).sort((a, b) => num(a) - num(b));
  const paths = ['feature.md', 'spec.md', 'build.md', ...reworks, 'decision.md'].filter((f) => top.includes(f)).map((f) => `jobs/${id}/${f}`);

  const brief = (await readJob(p, id))?.brief;
  if (typeof brief === 'string' && BRIEF.test(brief)) {
    const rel = brief.replace(/^factory\//, '');
    const info = await lstat(join(p.factory, rel)).catch(() => null);
    if (info?.isFile()) paths.unshift(rel);
  }

  const rounds = (await entries(dir)).filter((d) => d.isDirectory() && /^round-\d+$/.test(d.name)).map((d) => d.name);
  for (const round of rounds.sort((a, b) => num(a) - num(b))) {
    const files = (await entries(join(dir, round))).filter((d) => d.isFile() && d.name.endsWith('.md')).map((d) => d.name);
    const rank = (f: string): number => {
      const i = reviewers.indexOf(f.replace(/^review-|\.md$/g, ''));
      return i === -1 ? reviewers.length : i;
    };
    files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    paths.push(...files.map((f) => `jobs/${id}/${round}/${f}`));
  }

  const files = await Promise.all(paths.map(async (path) => ({ path, text: await readFile(join(p.factory, path), 'utf8') })));
  return { files };
}

const NO_STORE = { 'cache-control': 'no-store' };
const json = (body: unknown): Response => Response.json(body, { headers: NO_STORE });
const text = (body: string, status: number): Response => new Response(body, { status, headers: NO_STORE });
const notFound = (): Response => text('Not found', 404);

// A file of the built UI. `/` is its index.html. The decoded path must resolve inside `uiDir`,
// before and after following symlinks, and name a regular file; anything else is a 404 (null).
async function uiFile(uiDir: string, pathname: string): Promise<Response | null> {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null; // malformed escape
  }
  if (rel.includes('\0')) return null;
  if (rel === '/') rel = '/index.html';
  const root = await realpath(uiDir).catch(() => null);
  if (root === null) return null; // no build
  const inside = (p: string): boolean => p.startsWith(root + sep);
  const target = resolve(root, `.${rel}`);
  if (!inside(target)) return null;
  const real = await realpath(target).catch(() => null);
  if (real === null || !inside(real)) return null; // missing, or a symlink out of the build
  if ((await stat(real).catch(() => null))?.isFile() !== true) return null;
  const file = Bun.file(real);
  return new Response(file, { headers: { ...NO_STORE, 'content-type': file.type } });
}

type Client = ReadableStreamDefaultController<Uint8Array>;
const encoder = new TextEncoder();
const frame = (event: string, data: unknown): Uint8Array => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/** Starts the agent on `127.0.0.1:<port>`. */
export async function startAgent(opts: AgentOptions): Promise<Agent> {
  const debounceMs = opts.debounceMs ?? 50;
  const log = opts.log ?? ((line: string) => console.error(line));
  const clients = new Set<Client>();
  let projects = new Map<string, Project>();
  let stopped = false;

  const list = (): ProjectInfo[] => [...projects.values()].map((p) => p.info);

  function broadcast(event: string, data: unknown): void {
    const bytes = frame(event, data);
    for (const c of clients) {
      try {
        c.enqueue(bytes);
      } catch {
        clients.delete(c);
      }
    }
  }

  async function emitBoard(p: Project): Promise<void> {
    if (p.closed || clients.size === 0) return;
    try {
      const b = await board(p);
      if (!p.closed) broadcast('board', { project: p.info.id, ...b });
    } catch (e) {
      if (!p.closed) broadcast('error', { project: p.info.id, reason: `config.json: ${message(e)}` });
    }
  }

  // One `board` event per project per burst: the first change starts the window, the rest join it.
  function schedule(p: Project): void {
    if (p.closed || p.timer !== null) return;
    p.timer = setTimeout(() => {
      p.timer = null;
      void emitBoard(p);
    }, debounceMs);
  }

  function watchJobs(p: Project): void {
    if (p.closed || p.jobsWatcher !== null) return;
    try {
      const w = watch(join(p.factory, 'jobs'), { recursive: true }, () => schedule(p));
      w.on('error', () => {
        w.close();
        if (p.jobsWatcher === w) p.jobsWatcher = null;
      });
      p.jobsWatcher = w;
    } catch {
      // no factory/jobs/ yet: the factory/ watch attaches it when it appears
    }
  }

  function openProject(root: string): Project {
    const p: Project = {
      info: { id: projectId(root), name: basename(root), root },
      factory: join(root, 'factory'),
      lastGood: new Map(),
      factoryWatcher: null,
      jobsWatcher: null,
      timer: null,
      closed: false,
    };
    try {
      // Non-recursive: sees config.json and jobs/ appearing, never anything inside .worktrees/ or
      // .lock/. Dot-named entries (those two, and temp files) are ignored.
      const w = watch(p.factory, (_event, filename) => {
        if (filename !== null && filename.startsWith('.')) return;
        if (filename === null || filename === 'jobs') watchJobs(p);
        schedule(p);
      });
      w.on('error', () => {
        w.close();
        if (p.factoryWatcher === w) p.factoryWatcher = null;
      });
      p.factoryWatcher = w;
    } catch {
      // no factory/: the project is still listed, just not watched
    }
    watchJobs(p);
    return p;
  }

  function closeProject(p: Project): void {
    p.closed = true;
    p.factoryWatcher?.close();
    p.jobsWatcher?.close();
    p.factoryWatcher = null;
    p.jobsWatcher = null;
    if (p.timer !== null) clearTimeout(p.timer);
    p.timer = null;
  }

  // Re-reads the registry. An unreadable or invalid registry keeps the current list.
  async function loadRegistry(): Promise<void> {
    if (stopped) return;
    let roots: string[];
    try {
      roots = (await readRegistry(opts.registryPath)).projects.map((p) => p.root);
    } catch (e) {
      log(`andon: ${opts.registryPath}: ${message(e)}`);
      return;
    }
    if (stopped) return;
    const before = [...projects.keys()].join(',');
    const next = new Map<string, Project>();
    for (const root of roots) {
      const id = projectId(root);
      next.set(id, projects.get(id) ?? openProject(root));
    }
    for (const [id, p] of projects) if (!next.has(id)) closeProject(p);
    projects = next;
    if ([...projects.keys()].join(',') !== before) broadcast('projects', { projects: list() });
  }

  let reloading: Promise<void> = Promise.resolve();
  let registryTimer: ReturnType<typeof setTimeout> | null = null;
  const reload = (): Promise<void> => {
    reloading = reloading.then(loadRegistry);
    return reloading;
  };
  function scheduleRegistry(): void {
    if (stopped || registryTimer !== null) return;
    registryTimer = setTimeout(() => {
      registryTimer = null;
      void reload();
    }, debounceMs);
  }

  // Watch the registry's directory (the file itself is replaced by rename on every write).
  const registryDir = dirname(opts.registryPath);
  let registryWatcher: FSWatcher | null = null;
  try {
    await mkdir(registryDir, { recursive: true });
    registryWatcher = watch(registryDir, () => scheduleRegistry());
    registryWatcher.on('error', (e) => log(`andon: watching ${registryDir}: ${message(e)}`));
  } catch (e) {
    log(`andon: cannot watch ${registryDir}: ${message(e)}`);
  }
  await reload();

  function events(req: Request): Response {
    let self: Client | null = null;
    const drop = (): void => {
      if (self === null) return;
      clients.delete(self);
      try {
        self.close();
      } catch {
        // already closed
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        self = c;
        clients.add(c);
        c.enqueue(frame('projects', { projects: list() }));
      },
      cancel() {
        if (self !== null) clients.delete(self);
      },
    });
    req.signal.addEventListener('abort', drop);
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' } });
  }

  // DNS-rebinding guard: loopback binding alone does not stop a page whose hostname resolves to
  // 127.0.0.1, so the Host must name this agent, and an Origin, when sent, must be this agent's.
  let boundPort = 0;
  function trusted(req: Request): boolean {
    const hosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
    const host = req.headers.get('host');
    if (host === null || !hosts.includes(host.toLowerCase())) return false;
    const origin = req.headers.get('origin');
    return origin === null || hosts.some((h) => origin.toLowerCase() === `http://${h}`);
  }

  async function handle(req: Request): Promise<Response> {
    if (!trusted(req)) return text('Forbidden', 403);
    if (req.method !== 'GET') return text('Method not allowed', 405);
    const { pathname } = new URL(req.url);
    if (pathname === '/projects') return json({ projects: list() });
    if (pathname === '/events') return events(req);

    const b = pathname.match(/^\/projects\/([^/]+)\/board$/);
    if (b !== null) {
      const p = projects.get(b[1] ?? '');
      if (p === undefined) return notFound();
      try {
        return json(await board(p));
      } catch (e) {
        return text(`config.json: ${message(e)}`, 500);
      }
    }

    const d = pathname.match(/^\/projects\/([^/]+)\/jobs\/([^/]+)\/docs$/);
    if (d !== null) {
      const p = projects.get(d[1] ?? '');
      const id = d[2] ?? '';
      if (p === undefined || !JOB_ID.test(id)) return notFound(); // checked before any path is built
      try {
        return json(await docs(p, id));
      } catch (e) {
        return text(`config.json: ${message(e)}`, 500);
      }
    }
    if (opts.uiDir !== undefined) return (await uiFile(opts.uiDir, pathname)) ?? notFound();
    return notFound();
  }

  const server = Bun.serve({
    hostname: HOSTNAME,
    port: opts.port,
    idleTimeout: 0, // an event stream stays open with no traffic
    fetch: handle,
  });
  boundPort = server.port ?? 0;

  return {
    url: `http://${HOSTNAME}:${server.port}`,
    async stop() {
      stopped = true;
      if (registryTimer !== null) clearTimeout(registryTimer);
      registryWatcher?.close();
      for (const p of projects.values()) closeProject(p);
      for (const c of clients) {
        try {
          c.close();
        } catch {
          // already closed
        }
      }
      clients.clear();
      await server.stop(true);
    },
  };
}
