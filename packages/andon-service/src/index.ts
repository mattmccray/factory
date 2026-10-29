// The Andon service (docs/contract/v1.md "Andon service"): one Bun daemon per machine that reads every
// project listed in the Andon registry through `@factory/contract` and serves it, read-only, on
// loopback:
//   GET /projects                        → { projects: [{ id, name, root }] } (name: config.json's `name`, else basename(root))
//   GET /projects/<pid>/board            → { jobs, config } (a bad config is a 500 carrying the reason)
//   GET /projects/<pid>/jobs/<id>/docs   → { files: [{ path, text }] }, that job's markdown in reading order
//   GET /events                          → text/event-stream of `projects`, `board`, and `error` events
//   GET /, GET /<asset>                  → the built Andon UI (`uiDir`), read-only; a path outside it is a 404
// `board` (endpoint and event) and `docs` also serve jobs found only on the project's
// `factory/archive` branch, in the same shapes: re-projected from the archived `events.jsonl` (a
// legacy job keeps its archived `job.json`); a local `factory/jobs/<id>/` always wins. The archive
// is read from git (`rev-parse`, `ls-tree`, `cat-file` only; see archive.ts) into a cache keyed by
// the branch's tip sha, so a `jobs/` change runs no git and an archive move runs one `ls-tree` and
// one `cat-file --batch`.
// Changes are found with fs.watch, never by polling: one recursive watch on each project's
// `factory/jobs/`, one non-recursive watch on its `factory/` (for `config.json`), and one on the
// registry file's directory. The archive ref is watched in the git common dir (so a linked
// worktree's project works too): non-recursive watches on `refs/heads/factory/`, on `refs/heads/`
// (for `factory/` appearing), and on the common dir itself for `packed-refs` only.
// `.worktrees/` and `.lock/` are never watched or served.
// A project's name is resolved from its config.json on every GET /projects and on connect, and
// `projects` is re-sent whenever a resolved name changes (or the registry's list does).
// The board and docs readers are ported from the vendored `factory/serve.ts` (not imported).
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseConfig, readRegistry } from '@factory/contract';
import type { Config } from '@factory/contract';
import { EMPTY_ARCHIVE, archiveTip, gitCommonDir, readArchive, spawnGit } from './archive';
import type { ArchiveCache, GitRunner } from './archive';

export type { GitRunner } from './archive';

export interface ServiceOptions {
  port: number; // 0 picks a free port
  registryPath: string; // `$ANDON_HOME/projects.json`
  debounceMs?: number; // the burst window before one `board` event per project (default 50)
  log?: (line: string) => void; // diagnostics (default: stderr)
  uiDir?: string; // the Andon UI build (`apps/andon/dist`), served at `/`; absent or unbuilt: `/` is a 404
  git?: GitRunner; // how git is run to read `factory/archive` (default: spawned without a shell)
}

export interface Service {
  url: string;
  stop: () => Promise<void>;
}

export interface ProjectInfo {
  id: string; // first 12 hex characters of sha256(root)
  name: string; // config.json's `name` when the config is valid and sets it, else basename(root)
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
  archive: ArchiveCache; // `factory/archive` as last read, keyed by its tip
  archiveDirty: boolean; // the archive ref may have moved since it was read
  archiveTask: Promise<void>; // the archive's setup or latest refresh; readers wait on it
  refs: { common: FSWatcher | null; heads: FSWatcher | null; factory: FSWatcher | null }; // the archive ref watches, in the git common dir
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

// The project's display name: the config's `name` when config.json is valid and sets one, else
// the root's basename (no factory/, no config.json, unreadable, or invalid).
async function resolveName(p: Project): Promise<string> {
  try {
    return (await readConfig(p)).name ?? basename(p.info.root);
  } catch {
    return basename(p.info.root);
  }
}

// Local jobs, then the archived jobs that have no local dir, sorted by id together.
async function board(p: Project): Promise<{ jobs: Job[]; config: Config }> {
  const config = await readConfig(p);
  await p.archiveTask;
  const ids = (await entries(join(p.factory, 'jobs')))
    .filter((d) => d.isDirectory() && JOB_ID.test(d.name))
    .map((d) => d.name);
  const local = new Set(ids);
  const read = await Promise.all(ids.map(async (id) => ({ id, job: await readJob(p, id) })));
  for (const [id, a] of p.archive.jobs) if (!local.has(id)) read.push({ id, job: { ...a.job } });
  read.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { jobs: read.map((r) => r.job).filter((j) => j !== undefined), config };
}

const num = (name: string): number => Number(name.match(/\d+/)?.[0] ?? 0);

// A job's docs in reading order, as paths inside its dir: `top` is its top-level file names,
// `rounds` maps each `round-<N>` dir to the `.md` file names in it.
function readingOrder(top: readonly string[], rounds: ReadonlyMap<string, string[]>, reviewers: readonly string[]): string[] {
  const reworks = top.filter((f) => /^rework-\d+\.md$/.test(f)).sort((a, b) => num(a) - num(b));
  const paths = ['feature.md', 'spec.md', 'build.md', ...reworks, 'decision.md'].filter((f) => top.includes(f));
  const rank = (f: string): number => {
    const i = reviewers.indexOf(f.replace(/^review-|\.md$/g, ''));
    return i === -1 ? reviewers.length : i;
  };
  for (const round of [...rounds.keys()].filter((r) => /^round-\d+$/.test(r)).sort((a, b) => num(a) - num(b))) {
    const files = [...(rounds.get(round) ?? [])].filter((f) => f.endsWith('.md'));
    files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    paths.push(...files.map((f) => `${round}/${f}`));
  }
  return paths;
}

// The brief the job names, relative to factory/, when it exists locally as a regular file.
async function briefPath(p: Project, job: Job | undefined): Promise<string | null> {
  const brief = job?.brief;
  if (typeof brief !== 'string' || !BRIEF.test(brief)) return null;
  const rel = brief.replace(/^factory\//, '');
  const info = await lstat(join(p.factory, rel)).catch(() => null);
  return info?.isFile() === true ? rel : null;
}

// `id` is already checked against JOB_ID. Paths in `files` are relative to factory/. A local job
// dir is read from disk; with none, an archived job is served from the cache (no git per request).
async function docs(p: Project, id: string): Promise<{ files: Array<{ path: string; text: string }> }> {
  const { reviewers } = await readConfig(p);
  const dir = join(p.factory, 'jobs', id);
  const info = await lstat(dir).catch(() => null);
  if (info === null || !info.isDirectory()) {
    await p.archiveTask;
    const archived = info === null || !info.isSymbolicLink() ? p.archive.jobs.get(id) : undefined;
    if (archived === undefined) return { files: [] }; // never through a symlinked job dir
    const top: string[] = [];
    const rounds = new Map<string, string[]>();
    for (const rel of archived.files.keys()) {
      const [head, name, ...rest] = rel.split('/');
      if (head === undefined) continue;
      if (name === undefined) top.push(head);
      else if (rest.length === 0) rounds.set(head, [...(rounds.get(head) ?? []), name]);
    }
    const files = readingOrder(top, rounds, reviewers).map((rel) => ({ path: `jobs/${id}/${rel}`, text: archived.files.get(rel) ?? '' }));
    const brief = await briefPath(p, archived.job);
    if (brief !== null) files.unshift({ path: brief, text: await readFile(join(p.factory, brief), 'utf8') });
    return { files };
  }
  const top = (await entries(dir)).filter((d) => d.isFile()).map((d) => d.name);
  const rounds = new Map<string, string[]>();
  for (const d of await entries(dir)) {
    if (!d.isDirectory() || !/^round-\d+$/.test(d.name)) continue;
    rounds.set(d.name, (await entries(join(dir, d.name))).filter((f) => f.isFile()).map((f) => f.name));
  }
  const paths = readingOrder(top, rounds, reviewers).map((rel) => `jobs/${id}/${rel}`);
  const brief = await briefPath(p, await readJob(p, id));
  if (brief !== null) paths.unshift(brief);
  const files = await Promise.all(paths.map(async (path) => ({ path, text: await readFile(join(p.factory, path), 'utf8') })));
  return { files };
}

const NO_STORE = { 'cache-control': 'no-store' };
const json = (body: unknown): Response => Response.json(body, { headers: NO_STORE });
const text = (body: string, status: number): Response => new Response(body, { status, headers: NO_STORE });
const notFound = (): Response => text('Not found', 404);

/** The Content-Security-Policy sent on successful UI route responses only (docs/contract/v1.md "Andon service"). */
export const UI_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

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
  return new Response(file, { headers: { ...NO_STORE, 'content-type': file.type, 'content-security-policy': UI_CSP } });
}

type Client = ReadableStreamDefaultController<Uint8Array>;
const encoder = new TextEncoder();
const frame = (event: string, data: unknown): Uint8Array => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/** Starts the service on `127.0.0.1:<port>`. */
export async function startService(opts: ServiceOptions): Promise<Service> {
  const debounceMs = opts.debounceMs ?? 50;
  const log = opts.log ?? ((line: string) => console.error(line));
  const git = opts.git ?? spawnGit;
  const clients = new Set<Client>();
  let projects = new Map<string, Project>();
  let stopped = false;

  // Resolves every project's name and returns the list. `info.name` is the name connected clients
  // were last sent: when a resolved name differs from it (or `force`, for a registry change), the
  // list is sent to every connected client as a `projects` event. Runs one at a time, so clients
  // always end on the latest list.
  let announcing: Promise<unknown> = Promise.resolve();
  function announce(force: boolean): Promise<ProjectInfo[]> {
    const run = announcing.then(async () => {
      const open = [...projects.values()];
      const names = await Promise.all(open.map(resolveName));
      let changed = force;
      const current = open.filter((p, i) => {
        const name = names[i] ?? basename(p.info.root);
        if (name !== p.info.name) {
          p.info.name = name;
          changed = true;
        }
        return !p.closed;
      });
      const list = current.map((p) => ({ ...p.info }));
      if (changed) broadcast('projects', { projects: list });
      return list;
    });
    announcing = run.catch(() => undefined);
    return run;
  }

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

  // Re-reads the archive tip, and the archive itself only when the tip moved. A git failure keeps
  // the last read (and is logged); a missing branch is no archived jobs, and is not an error.
  async function readArchiveOf(p: Project): Promise<void> {
    if (p.closed) return;
    try {
      const tip = await archiveTip(git, p.info.root);
      if (tip === p.archive.tip || p.closed) return;
      const next = tip === null ? EMPTY_ARCHIVE : await readArchive(git, p.info.root, tip, log);
      if (!p.closed) p.archive = next;
    } catch (e) {
      if (!p.closed) log(`andon: ${p.info.root}: reading factory/archive: ${message(e)}`);
    }
  }

  // One refresh at a time per project; `board` and `docs` wait on the latest.
  function refreshArchive(p: Project): Promise<void> {
    p.archiveDirty = false;
    p.archiveTask = p.archiveTask.then(() => readArchiveOf(p));
    return p.archiveTask;
  }
  const archiveReady = (p: Project): Promise<void> => (p.archiveDirty ? refreshArchive(p) : p.archiveTask);

  async function emitBoard(p: Project): Promise<void> {
    if (p.closed || clients.size === 0) return;
    try {
      await archiveReady(p);
      const b = await board(p);
      if (!p.closed) broadcast('board', { project: p.info.id, ...b });
    } catch (e) {
      if (!p.closed) broadcast('error', { project: p.info.id, reason: `config.json: ${message(e)}` });
    }
    // A config.json edit may have changed the project's resolved name.
    if (!p.closed) await announce(false);
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

  // The archive ref may have moved: the next `board` (event or request) re-reads the tip first.
  function refMoved(p: Project): void {
    p.archiveDirty = true;
    schedule(p);
  }

  // A non-recursive watch on `dir`, calling `on` with each changed entry's name (null: unknown).
  // A missing dir is no watch (null).
  function watchDir(dir: string, on: (name: string | null) => void, drop: (w: FSWatcher) => void): FSWatcher | null {
    try {
      const w = watch(dir, (_event, name) => on(name));
      w.on('error', () => {
        w.close();
        drop(w);
      });
      return w;
    } catch {
      return null;
    }
  }

  // `refs/heads/factory/` holds the loose archive ref (and job branches, whose moves re-read only
  // the tip). It is re-attached whenever `refs/heads/` sees `factory` appear or be replaced.
  function watchFactoryRefs(p: Project, common: string): void {
    if (p.closed) return;
    p.refs.factory?.close();
    p.refs.factory = watchDir(join(common, 'refs', 'heads', 'factory'), () => refMoved(p), (w) => {
      if (p.refs.factory === w) p.refs.factory = null;
    });
  }

  function watchRefs(p: Project, common: string): void {
    p.refs.common = watchDir(common, (name) => {
      if (name === null || name === 'packed-refs') refMoved(p);
    }, (w) => {
      if (p.refs.common === w) p.refs.common = null;
    });
    p.refs.heads = watchDir(join(common, 'refs', 'heads'), (name) => {
      if (name !== null && name !== 'factory') return;
      watchFactoryRefs(p, common);
      refMoved(p);
    }, (w) => {
      if (p.refs.heads === w) p.refs.heads = null;
    });
    watchFactoryRefs(p, common);
  }

  // Finds the git common dir once, starts the ref watches, then reads the archive. Not a git repo
  // (or no git): no archive, no watches, and nothing logged.
  async function openArchive(p: Project): Promise<void> {
    const common = await gitCommonDir(git, p.info.root);
    if (common === null || p.closed) return;
    watchRefs(p, common);
    await readArchiveOf(p);
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
      archive: EMPTY_ARCHIVE,
      archiveDirty: false,
      archiveTask: Promise.resolve(),
      refs: { common: null, heads: null, factory: null },
    };
    p.archiveTask = openArchive(p);
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
    for (const w of [p.refs.common, p.refs.heads, p.refs.factory]) w?.close();
    p.refs = { common: null, heads: null, factory: null };
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
    if ([...projects.keys()].join(',') !== before) await announce(true);
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

  // The connecting client gets the freshly resolved list (any change is first sent to the others).
  async function events(req: Request): Promise<Response> {
    const list = await announce(false);
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
        c.enqueue(frame('projects', { projects: list }));
      },
      cancel() {
        if (self !== null) clients.delete(self);
      },
    });
    req.signal.addEventListener('abort', drop);
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' } });
  }

  // DNS-rebinding guard: loopback binding alone does not stop a page whose hostname resolves to
  // 127.0.0.1, so the Host must name this service, and an Origin, when sent, must be this service's.
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
    if (pathname === '/projects') return json({ projects: await announce(false) });
    if (pathname === '/events') return events(req);

    const b = pathname.match(/^\/projects\/([^/]+)\/board$/);
    if (b !== null) {
      const p = projects.get(b[1] ?? '');
      if (p === undefined) return notFound();
      try {
        await archiveReady(p);
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
        await archiveReady(p);
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
      const open = [...projects.values()];
      for (const p of open) closeProject(p);
      await Promise.all(open.map((p) => p.archiveTask)); // no git process outlives the service
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
