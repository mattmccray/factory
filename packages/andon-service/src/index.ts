// The Andon service (docs/contract/v1.md "Andon service"): one Bun daemon per machine that reads every
// project listed in the Andon registry through `@factory/contract` and serves it, read-only, on
// loopback:
//   GET /projects                        → { projects: [{ id, name, root }] } (name: config.json's `name`, else basename(root))
//   GET /projects/<pid>/board            → { jobs, config, epics } (a bad config is a 500 carrying the reason);
//                                          epics: the on-board (unsettled) epics' epic.json, in slug order
//   GET /projects/<pid>/board?settled=summary → { jobs, config, settled, epics }: unsettled jobs only, plus
//                                          settled: { count, lastMergedAt, epics } (only the exact value `summary` opts in)
//   GET /projects/<pid>/settled          → { jobs, epics }, the project's settled jobs and epics only (errors as for board)
//   GET /projects/<pid>/jobs/<id>/docs   → { files: [{ path, text }] }, that job's markdown in reading order
//   GET /projects/<pid>/epics/<slug>/docs → { files: [{ path, text }] }, the epic's plan, then its member briefs in plan order
//   GET /events                          → text/event-stream of `projects`, `board`, and `error` events
//   GET /events?settled=summary          → the same stream, with each `board` event narrow
//                                          ({ project, jobs, config, settled, epics }, as for the narrow board)
//   GET /, GET /<asset>                  → the built Andon UI (`uiDir`), read-only; a path outside it is a 404
// `board` (endpoint and event) and `docs` also serve jobs found only on the project's
// `factory/archive` branch, in the same shapes: re-projected from the archived `events.jsonl` (a
// legacy job keeps its archived `job.json`); a local `factory/jobs/<id>/` always wins. The archive
// is read from git (`rev-parse`, `ls-tree`, `cat-file` only; see archive.ts) into a cache keyed by
// the branch's tip sha, so a `jobs/` change runs no git and an archive move runs one `ls-tree` and
// one `cat-file --batch`.
// Epics are read the same way: each local `factory/jobs/epics/<slug>/epic.json` as stored (last
// good snapshot kept), and each archived-only `epics/<slug>/` re-projected with the contract's
// `projectEpic` from its archived log and plan and the board's jobs; a local epic dir always wins.
// Changes are found with fs.watch, never by polling: one recursive watch on each project's
// `factory/jobs/` (epic runtime state included), one non-recursive watch on its `factory/` (for
// `config.json`), one non-recursive watch on its `factory/epics/` (plan edits), and one on the
// registry file's directory. The archive ref is watched in the git common dir (so a linked
// worktree's project works too): non-recursive watches on `refs/heads/factory/`, on `refs/heads/`
// (for `factory/` appearing), and on the common dir itself for `packed-refs` only.
// `.worktrees/` and `.lock/` are never watched or served.
// "Settled" is the contract's epic-aware rule (settled.ts). A merged job or a landed epic settles
// with no file change, so while any narrow `/events` client is connected each project has at most
// one one-shot settle timer, armed for its next crossing (an unsettled merged job with no epic, or
// an unsettled landed epic, whose jobs settle with it) and re-armed after every build; it sends a
// narrow `board` event to narrow clients only. It is not polling: with no narrow client, or no
// coming crossing, no timer is armed.
// A project's name is resolved from its config.json on every GET /projects and on connect, and
// `projects` is re-sent whenever a resolved name changes (or the registry's list does).
// The board and docs readers are ported from the vendored `factory/serve.ts` (not imported).
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { isEpicSlug, parseConfig, parsePlan, readRegistry } from '@factory/contract';
import type { Config } from '@factory/contract';
import { EMPTY_ARCHIVE, archiveTip, gitCommonDir, projectArchivedEpic, readArchive, spawnGit } from './archive';
import type { ArchiveCache, GitRunner } from './archive';
import { MAX_DELAY_MS, nextSettle, partition, summarize } from './settled';
import type { SettledSummary } from './settled';

export type { GitRunner } from './archive';

export interface ServiceOptions {
  port: number; // 0 picks a free port
  registryPath: string; // `$ANDON_HOME/projects.json`
  debounceMs?: number; // the burst window before one `board` event per project (default 50)
  log?: (line: string) => void; // diagnostics (default: stderr)
  uiDir?: string; // the Andon UI build (`apps/andon/dist`), served at `/`; absent or unbuilt: `/` is a 404
  git?: GitRunner; // how git is run to read `factory/archive` (default: spawned without a shell)
  settleTimers?: SettleTimers; // how the per-project settle timers are set and cleared (default: setTimeout)
}

/** Sets and clears the one-shot settle timers (injectable so a test can see what is pending). */
export interface SettleTimers {
  set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (t: ReturnType<typeof setTimeout>) => void;
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
  lastGoodEpic: Map<string, Job>; // per epic slug: the last epic.json that parsed
  factoryWatcher: FSWatcher | null;
  jobsWatcher: FSWatcher | null;
  epicsWatcher: FSWatcher | null; // `factory/epics/` (plan files), non-recursive
  timer: ReturnType<typeof setTimeout> | null;
  settleTimer: ReturnType<typeof setTimeout> | null; // armed only while a narrow `/events` client is connected
  settleDue: number; // when the settle timer's job crosses the line (ms since the epoch)
  closed: boolean;
  archive: ArchiveCache; // `factory/archive` as last read, keyed by its tip
  archiveDirty: boolean; // the archive ref may have moved since it was read
  archiveTask: Promise<void>; // the archive's setup or latest refresh; readers wait on it
  refs: { common: FSWatcher | null; heads: FSWatcher | null; factory: FSWatcher | null }; // the archive ref watches, in the git common dir
  log: (line: string) => void; // the service's diagnostics
  epicFailures: Set<string>; // `<tip> <slug>`: archived epics already logged as unprojectable at that tip
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

// The same for an epic's epic.json, under `jobs/epics/<slug>/` (the slug is already checked).
async function readEpic(p: Project, slug: string): Promise<Job | undefined> {
  try {
    const epic: unknown = JSON.parse(await readFile(join(p.factory, 'jobs', 'epics', slug, 'epic.json'), 'utf8'));
    if (isRecord(epic)) p.lastGoodEpic.set(slug, { ...epic });
  } catch {
    // missing or mid-write: fall back to the last good read
  }
  return p.lastGoodEpic.get(slug);
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

const bySlugOrId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Local jobs, then the archived jobs that have no local dir, sorted by id together; and every
// epic, local (its epic.json as stored) or archived-only (re-projected over those jobs), by slug.
async function board(p: Project): Promise<Board> {
  const config = await readConfig(p);
  await p.archiveTask;
  const ids = (await entries(join(p.factory, 'jobs')))
    .filter((d) => d.isDirectory() && JOB_ID.test(d.name))
    .map((d) => d.name);
  const local = new Set(ids);
  const read = await Promise.all(ids.map(async (id) => ({ id, job: await readJob(p, id) })));
  for (const [id, a] of p.archive.jobs) if (!local.has(id)) read.push({ id, job: { ...a.job } });
  read.sort(bySlugOrId);
  const jobs = read.map((r) => r.job).filter((j) => j !== undefined);

  const slugs = (await entries(join(p.factory, 'jobs', 'epics')))
    .filter((d) => d.isDirectory() && isEpicSlug(d.name))
    .map((d) => d.name);
  const localEpics = new Set(slugs);
  const epicRead = await Promise.all(slugs.map(async (id) => ({ id, epic: await readEpic(p, id) })));
  for (const [slug, a] of p.archive.epics) {
    if (localEpics.has(slug)) continue;
    try {
      epicRead.push({ id: slug, epic: projectArchivedEpic(a, jobs) });
    } catch (e) {
      // Logged once per archive tip, not on every board build.
      const key = `${p.archive.tip ?? ''} ${slug}`;
      if (!p.epicFailures.has(key)) {
        p.epicFailures.add(key);
        p.log(`andon: ${p.info.root}: factory/archive epics/${slug}: ${message(e)}; left out`);
      }
    }
  }
  epicRead.sort(bySlugOrId);
  const epics = new Map<string, Job>();
  for (const r of epicRead) if (r.epic !== undefined) epics.set(r.id, r.epic);
  return { jobs, config, epics };
}

// `epics` holds every epic the project has, settled or not; the payloads below split it.
type Board = { jobs: Job[]; config: Config; epics: Map<string, Job> };

// The plain form of a board: every job, its config, and the on-board (unsettled) epics, by the
// system clock.
function plain(b: Board, now: number): { jobs: Job[]; config: Config; epics: Job[] } {
  const { unsettledEpics } = partition([], b.epics, b.config.dashboard.settleAfterHours, now);
  return { jobs: b.jobs, config: b.config, epics: unsettledEpics };
}

// The narrow form of a board: its unsettled jobs, its config, the settled summary, and the
// on-board epics, by the system clock.
function narrow(b: Board, now: number): { jobs: Job[]; config: Config; settled: SettledSummary; epics: Job[] } {
  const { unsettled, settled, unsettledEpics, settledEpics } = partition(b.jobs, b.epics, b.config.dashboard.settleAfterHours, now);
  return { jobs: unsettled, config: b.config, settled: summarize(settled, settledEpics), epics: unsettledEpics };
}

// The settled side: the settled jobs and epics.
function settledOf(b: Board, now: number): { jobs: Job[]; epics: Job[] } {
  const { settled, settledEpics } = partition(b.jobs, b.epics, b.config.dashboard.settleAfterHours, now);
  return { jobs: settled, epics: settledEpics };
}

// The text of `rel` (relative to factory/) when it is a regular file, not a symlink, that resolves
// inside the project's factory/; null otherwise (missing, a symlink, a directory, or outside).
async function readInside(p: Project, rel: string): Promise<string | null> {
  const path = join(p.factory, rel);
  try {
    if (!(await lstat(path)).isFile()) return null;
    const [root, real] = await Promise.all([realpath(p.factory), realpath(path)]);
    if (!real.startsWith(root + sep)) return null;
    return await readFile(real, 'utf8');
  } catch {
    return null;
  }
}

// An epic's docs: its plan (`epics/<slug>.md`, locally when that is a regular file, else the
// archived `plan.md`), then each member's brief (`briefs/<m>.md`, local regular files only) in
// plan order. Null when the slug has no plan locally or archived. `slug` is already checked.
async function epicDocs(p: Project, slug: string): Promise<{ files: Array<{ path: string; text: string }> } | null> {
  const path = `epics/${slug}.md`;
  let plan = await readInside(p, path);
  if (plan === null) {
    await p.archiveTask;
    plan = p.archive.epics.get(slug)?.plan ?? null;
  }
  if (plan === null) return null;
  const files = [{ path, text: plan }];
  // Member slugs are checked by the plan parser (the slug rule), so no path escapes `briefs/`.
  for (const m of parsePlan(plan).members) {
    const brief = `briefs/${m.slug}.md`;
    const text = await readInside(p, brief);
    if (text !== null) files.push({ path: brief, text });
  }
  return { files };
}

const num = (name: string): number => Number(name.match(/\d+/)?.[0] ?? 0);

// A job's docs in reading order, as paths inside its dir: `top` is its top-level file names,
// `rounds` maps each `round-<N>` dir to the `.md` file names in it.
function readingOrder(top: readonly string[], rounds: ReadonlyMap<string, string[]>, reviewers: readonly string[]): string[] {
  const reworks = top.filter((f) => /^rework-\d+\.md$/.test(f)).sort((a, b) => num(a) - num(b));
  const conflicts = top.filter((f) => /^conflict-\d+\.md$/.test(f)).sort((a, b) => num(a) - num(b));
  const paths = ['feature.md', 'spec.md', 'build.md', ...reworks, ...conflicts, 'decision.md'].filter((f) => top.includes(f));
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
type Form = 'plain' | 'narrow'; // a `/events` client's `board` form: every job, or `?settled=summary`
const encoder = new TextEncoder();
const frame = (event: string, data: unknown): Uint8Array => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/** Starts the service on `127.0.0.1:<port>`. */
export async function startService(opts: ServiceOptions): Promise<Service> {
  const debounceMs = opts.debounceMs ?? 50;
  const log = opts.log ?? ((line: string) => console.error(line));
  const git = opts.git ?? spawnGit;
  const timers: SettleTimers = opts.settleTimers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) };
  const clients = new Map<Client, Form>();
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

  const hasForm = (form: Form): boolean => [...clients.values()].includes(form);

  // Removes a client; when it was the last narrow one, every settle timer is cleared.
  function removeClient(c: Client): void {
    if (!clients.delete(c)) return;
    if (!hasForm('narrow')) for (const p of projects.values()) clearSettle(p);
  }

  // Sends to every client, or only to those of one form.
  function broadcast(event: string, data: unknown, form?: Form): void {
    const bytes = frame(event, data);
    for (const [c, f] of [...clients]) {
      if (form !== undefined && f !== form) continue;
      try {
        c.enqueue(bytes);
      } catch {
        removeClient(c);
      }
    }
  }

  function clearSettle(p: Project): void {
    if (p.settleTimer !== null) timers.clear(p.settleTimer);
    p.settleTimer = null;
  }

  // Re-arms the project's settle timer from a fresh build: one one-shot deadline, for its next
  // unsettled merged job, and only while a narrow client is connected. A longer delay than
  // setTimeout accepts is clamped; firing early just rebuilds and re-arms.
  function armSettle(p: Project, b: Board): void {
    clearSettle(p);
    if (p.closed || stopped || !hasForm('narrow')) return;
    const now = Date.now();
    const delay = nextSettle(b.jobs, b.epics, b.config.dashboard.settleAfterHours, now);
    if (delay === null) return;
    p.settleDue = now + delay;
    p.settleTimer = timers.set(() => {
      p.settleTimer = null;
      void settleFired(p);
    }, Math.min(delay, MAX_DELAY_MS));
  }

  // A build for arming only (a narrow client's first connect, a project opened while one is
  // connected). A bad config arms nothing: its error event comes from the config change itself.
  async function armFromBuild(p: Project): Promise<void> {
    try {
      await archiveReady(p);
      const b = await board(p);
      if (!p.closed) armSettle(p, b);
    } catch {
      clearSettle(p);
    }
  }

  // The settle timer fired: narrow clients get a fresh narrow `board` event (plain clients none),
  // unless it fired early (a clamped delay), and the timer is re-armed from the same build.
  async function settleFired(p: Project): Promise<void> {
    if (p.closed || !hasForm('narrow')) return;
    try {
      await archiveReady(p);
      const b = await board(p);
      if (p.closed) return;
      const now = Date.now();
      if (now >= p.settleDue) broadcast('board', { project: p.info.id, ...narrow(b, now) }, 'narrow');
      armSettle(p, b);
    } catch {
      clearSettle(p);
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
      if (!p.closed) {
        p.archive = next;
        p.epicFailures.clear();
      }
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
      if (!p.closed) {
        // Each form is built only when a client of that form is connected.
        const now = Date.now();
        if (hasForm('plain')) broadcast('board', { project: p.info.id, ...plain(b, now) }, 'plain');
        if (hasForm('narrow')) broadcast('board', { project: p.info.id, ...narrow(b, now) }, 'narrow');
        armSettle(p, b);
      }
    } catch (e) {
      clearSettle(p);
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

  // Plan files: a non-recursive watch on `factory/epics/`, attached when it appears.
  function watchEpics(p: Project): void {
    if (p.closed || p.epicsWatcher !== null) return;
    p.epicsWatcher = watchDir(join(p.factory, 'epics'), () => schedule(p), (w) => {
      if (p.epicsWatcher === w) p.epicsWatcher = null;
    });
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
      lastGoodEpic: new Map(),
      factoryWatcher: null,
      jobsWatcher: null,
      epicsWatcher: null,
      timer: null,
      settleTimer: null,
      settleDue: 0,
      closed: false,
      archive: EMPTY_ARCHIVE,
      archiveDirty: false,
      archiveTask: Promise.resolve(),
      refs: { common: null, heads: null, factory: null },
      log,
      epicFailures: new Set(),
    };
    p.archiveTask = openArchive(p);
    try {
      // Non-recursive: sees config.json and jobs/ appearing, never anything inside .worktrees/ or
      // .lock/. Dot-named entries (those two, and temp files) are ignored.
      const w = watch(p.factory, (_event, filename) => {
        if (filename !== null && filename.startsWith('.')) return;
        if (filename === null || filename === 'jobs') watchJobs(p);
        if (filename === null || filename === 'epics') watchEpics(p);
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
    watchEpics(p);
    return p;
  }

  function closeProject(p: Project): void {
    p.closed = true;
    p.factoryWatcher?.close();
    p.jobsWatcher?.close();
    p.epicsWatcher?.close();
    p.factoryWatcher = null;
    p.jobsWatcher = null;
    p.epicsWatcher = null;
    for (const w of [p.refs.common, p.refs.heads, p.refs.factory]) w?.close();
    p.refs = { common: null, heads: null, factory: null };
    if (p.timer !== null) clearTimeout(p.timer);
    p.timer = null;
    clearSettle(p);
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
    const opened: Project[] = [];
    for (const root of roots) {
      const id = projectId(root);
      const known = projects.get(id);
      if (known !== undefined) next.set(id, known);
      else {
        const p = openProject(root);
        opened.push(p);
        next.set(id, p);
      }
    }
    for (const [id, p] of projects) if (!next.has(id)) closeProject(p);
    projects = next;
    // A project opened while a narrow client is connected gets its settle timer now.
    if (hasForm('narrow')) for (const p of opened) void armFromBuild(p);
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
  async function events(req: Request, form: Form): Promise<Response> {
    const list = await announce(false);
    let self: Client | null = null;
    const drop = (): void => {
      if (self === null) return;
      removeClient(self);
      try {
        self.close();
      } catch {
        // already closed
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        self = c;
        const first = form === 'narrow' && !hasForm('narrow');
        clients.set(c, form);
        c.enqueue(frame('projects', { projects: list }));
        // The first narrow client arms every project's settle timer (later ones find them armed).
        if (first) for (const p of projects.values()) void armFromBuild(p);
      },
      cancel() {
        if (self !== null) removeClient(self);
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
    const url = new URL(req.url);
    const { pathname } = url;
    // Only the exact value `summary` opts in; no parameter, or any other value, is the plain form.
    const summary = url.searchParams.get('settled') === 'summary';
    if (pathname === '/projects') return json({ projects: await announce(false) });
    if (pathname === '/events') return events(req, summary ? 'narrow' : 'plain');

    const b = pathname.match(/^\/projects\/([^/]+)\/(board|settled)$/);
    if (b !== null) {
      const p = projects.get(b[1] ?? '');
      if (p === undefined) return notFound();
      try {
        await archiveReady(p);
        const full = await board(p);
        const now = Date.now();
        if (b[2] === 'settled') return json(settledOf(full, now));
        return json(summary ? narrow(full, now) : plain(full, now));
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

    const e = pathname.match(/^\/projects\/([^/]+)\/epics\/([^/]+)\/docs$/);
    if (e !== null) {
      const p = projects.get(e[1] ?? '');
      const slug = e[2] ?? '';
      if (p === undefined || !isEpicSlug(slug)) return notFound(); // checked before any path is built
      try {
        await archiveReady(p);
        const docs = await epicDocs(p, slug);
        return docs === null ? notFound() : json(docs);
      } catch (e) {
        return text(`epic docs: ${message(e)}`, 500);
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
      for (const c of clients.keys()) {
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
