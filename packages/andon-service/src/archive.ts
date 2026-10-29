// Reading the job archive (docs/contract/v1.md "Job archive" and "Andon service"): the jobs on a
// project's `factory/archive` branch, re-projected from their archived `events.jsonl` (a legacy job
// keeps its archived `job.json`), with the markdown the `docs` endpoint serves, held in memory and
// keyed by the branch's tip sha. Git is only read: `rev-parse`, `ls-tree`, and `cat-file`, spawned
// without a shell, with fixed argument arrays. A rebuild runs one `ls-tree` and one
// `cat-file --batch` for all files, and only when the tip has moved. The same pass reads each
// archived epic's `epics/<slug>/events.jsonl` and `plan.md`; an archived epic is re-projected with
// the contract's `projectEpic` per board build, since its member jobs come from the board.
import { JOB_KINDS, isEpicSlug, isJobId, parseEpicLog, parseLog, parsePlan, planPath, project, projectEpic } from '@factory/contract';
import type { EpicEvent, EpicJob, PlanMember } from '@factory/contract';

export interface GitOutput {
  code: number;
  stdout: Uint8Array;
}

/**
 * Runs `git <args>` in `cwd`, without a shell, with `input` on stdin when given. Injectable, so a
 * test can record every invocation; `spawnGit` is the real one.
 */
export type GitRunner = (args: readonly string[], opts: { cwd: string; input?: string }) => Promise<GitOutput>;

/** The archive branch's ref: the only ref the service ever names. */
export const ARCHIVE_REF = 'refs/heads/factory/archive';

// Variables that would point git at another repo, index, object store, or config than the
// project's own (the same guard as the CLI's runner), plus every other inherited GIT_* setting.
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('GIT_')) env[k] = v;
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

const READ_ONLY = new Set(['rev-parse', 'ls-tree', 'cat-file']);

export const spawnGit: GitRunner = async (args, { cwd, input }) => {
  if (!READ_ONLY.has(args[0] ?? '')) throw new Error(`git ${args[0] ?? ''}: not a read-only command`);
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdin: input === undefined ? 'ignore' : new Blob([input]),
    stdout: 'pipe',
    stderr: 'ignore',
    env: gitEnv(),
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
  return { code, stdout: new Uint8Array(out) };
};

type Job = Record<string, unknown>;

/** One archived job: its board snapshot and its docs-relevant files (path relative to `<id>/`). */
export interface ArchivedJob {
  job: Job;
  files: Map<string, string>;
}

/** One archived epic: its parsed log (starting with `epic.started`) and its archived plan. */
export interface ArchivedEpic {
  slug: string;
  log: EpicEvent[];
  plan: string | null; // `plan.md`'s text; null when the archive holds none
  members: PlanMember[]; // the members that parsed from the plan
  planError: string | null; // why the plan couldn't be read or parsed in full, as `epic.json` says it
}

/** The archive as read at `tip` (null: no branch, so no jobs or epics). */
export interface ArchiveCache {
  tip: string | null;
  jobs: Map<string, ArchivedJob>;
  epics: Map<string, ArchivedEpic>; // by slug, in slug order
}

export const EMPTY_ARCHIVE: ArchiveCache = { tip: null, jobs: new Map(), epics: new Map() };

const HEX_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const TOP_MD = /^(feature|spec|build|decision|rework-\d+|conflict-\d+)\.md$/;
const ROUND_MD = /^round-\d+\/[^/]+\.md$/;
// Mode 100644 or 100755: a regular file. A symlink (120000) or a submodule (160000) is never read.
const REGULAR = /^100(644|755)$/;

// Keeps BOMs and replaces invalid bytes, as `readFile(path, 'utf8')` does for a local copy.
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const isRecord = (v: unknown): v is Job => typeof v === 'object' && v !== null && !Array.isArray(v);
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';

/** Whether a path inside a job's archived dir is read: the log, a legacy job.json, or a docs file. */
export const wanted = (rel: string): boolean => rel === 'events.jsonl' || rel === 'job.json' || TOP_MD.test(rel) || ROUND_MD.test(rel);

/**
 * The git common dir of the repo at `root` (absolute), or null when `root` isn't in a git repo or
 * git can't run. Shared by linked worktrees, so the archive ref is found from any of them.
 */
export async function gitCommonDir(git: GitRunner, root: string): Promise<string | null> {
  try {
    const r = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root });
    const dir = decoder.decode(r.stdout).trim();
    return r.code === 0 && dir.startsWith('/') && !dir.includes('\n') ? dir : null;
  } catch {
    return null;
  }
}

/** The archive branch's tip commit, or null when there is no branch. Throws when git fails otherwise. */
export async function archiveTip(git: GitRunner, root: string): Promise<string | null> {
  const r = await git(['rev-parse', '--verify', '--quiet', `${ARCHIVE_REF}^{commit}`], { cwd: root });
  const out = decoder.decode(r.stdout).trim();
  if (r.code === 0 && HEX_SHA.test(out)) return out;
  if (r.code === 1 || (r.code === 0 && out === '')) return null;
  throw new Error(`git rev-parse exited ${r.code}`);
}

interface TreeBlob {
  id: string; // job id
  rel: string; // path inside the job's dir
  sha: string;
}

interface EpicBlob {
  slug: string;
  rel: 'events.jsonl' | 'plan.md';
  sha: string;
}

// `git ls-tree -r -z <tip>` records: `<mode> SP <type> SP <sha> TAB <path>`, NUL-terminated. Kept:
// regular-file blobs only (never a symlink or a submodule).
function blobs(raw: Uint8Array): Array<{ path: string; sha: string }> {
  const out: Array<{ path: string; sha: string }> = [];
  for (const rec of decoder.decode(raw).split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, sha] = rec.slice(0, tab).split(' ');
    if (type !== 'blob' || mode === undefined || !REGULAR.test(mode) || sha === undefined || !HEX_SHA.test(sha)) continue;
    out.push({ path: rec.slice(tab + 1), sha });
  }
  return out;
}

// The job blobs: under a top-level dir named like a job id, at a path the service reads.
function jobBlobs(all: ReadonlyArray<{ path: string; sha: string }>): TreeBlob[] {
  const out: TreeBlob[] = [];
  for (const { path, sha } of all) {
    const slash = path.indexOf('/');
    if (slash < 0) continue; // a file at the top level is not a job
    const id = path.slice(0, slash);
    const rel = path.slice(slash + 1);
    if (!isJobId(id) || !wanted(rel)) continue;
    out.push({ id, rel, sha });
  }
  return out;
}

// The epic blobs: exactly `epics/<slug>/events.jsonl` and `epics/<slug>/plan.md`, for an epic slug.
function epicBlobs(all: ReadonlyArray<{ path: string; sha: string }>): EpicBlob[] {
  const out: EpicBlob[] = [];
  for (const { path, sha } of all) {
    const [top, slug, rel, ...rest] = path.split('/');
    if (top !== 'epics' || slug === undefined || !isEpicSlug(slug) || rest.length > 0) continue;
    if (rel === 'events.jsonl' || rel === 'plan.md') out.push({ slug, rel, sha });
  }
  return out;
}

/** The archived jobs' blobs in `git ls-tree -r -z` output. */
export const parseTree = (raw: Uint8Array): TreeBlob[] => jobBlobs(blobs(raw));

/** The archived epics' blobs in `git ls-tree -r -z` output. */
export const parseEpicTree = (raw: Uint8Array): EpicBlob[] => epicBlobs(blobs(raw));

// `git cat-file --batch` output: per requested id, `<sha> <type> <size>\n<content>\n`, or
// `<sha> missing\n`. Returns each blob's text by sha.
export function parseBatch(raw: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (at < raw.length) {
    const nl = raw.indexOf(10, at);
    if (nl < 0) break;
    const [sha, type, size] = decoder.decode(raw.subarray(at, nl)).split(' ');
    at = nl + 1;
    if (sha === undefined || type === undefined || size === undefined) continue; // `missing` and the like
    const n = Number(size);
    if (!Number.isSafeInteger(n) || n < 0 || at + n > raw.length) throw new Error('git cat-file: truncated output');
    if (type === 'blob') out.set(sha, decoder.decode(raw.subarray(at, at + n)));
    at += n + 1;
  }
  return out;
}

// The job's board snapshot, as the CLI would project it into `job.json`: from `events.jsonl`, or a
// legacy job's archived `job.json`. Throws a one-line reason when it can't be projected.
function snapshot(id: string, files: Map<string, string>): Job {
  const log = files.get('events.jsonl');
  if (log !== undefined) {
    const snap: unknown = JSON.parse(JSON.stringify(project(parseLog(log))));
    if (!isRecord(snap)) throw new Error('projection is not an object');
    if (snap.id !== id) throw new Error(`events.jsonl claims ${JSON.stringify(snap.id)}`);
    return snap;
  }
  const legacy = files.get('job.json');
  if (legacy === undefined) throw new Error('no events.jsonl and no job.json');
  const job: unknown = JSON.parse(legacy);
  if (!isRecord(job)) throw new Error('job.json is not a JSON object');
  return job;
}

/**
 * Reads the archive at `tip`: one `git ls-tree` and one `git cat-file --batch` for every file. A
 * job that can't be projected is left out, and `log` says why.
 */
export async function readArchive(git: GitRunner, root: string, tip: string, log: (line: string) => void): Promise<ArchiveCache> {
  if (!HEX_SHA.test(tip)) throw new Error('archive tip is not an object id');
  const tree = await git(['ls-tree', '-r', '-z', '--full-tree', tip], { cwd: root });
  if (tree.code !== 0) throw new Error(`git ls-tree exited ${tree.code}`);
  const all = blobs(tree.stdout);
  const jobFiles = jobBlobs(all);
  const epicFiles = epicBlobs(all);
  const shas = [...new Set([...jobFiles, ...epicFiles].map((b) => b.sha))];
  let texts = new Map<string, string>();
  if (shas.length > 0) {
    const batch = await git(['cat-file', '--batch'], { cwd: root, input: shas.map((s) => `${s}\n`).join('') });
    if (batch.code !== 0) throw new Error(`git cat-file exited ${batch.code}`);
    texts = parseBatch(batch.stdout);
  }

  const byJob = new Map<string, Map<string, string>>();
  for (const b of jobFiles) {
    const text = texts.get(b.sha);
    if (text === undefined) continue;
    const files = byJob.get(b.id) ?? new Map<string, string>();
    files.set(b.rel, text);
    byJob.set(b.id, files);
  }
  const jobs = new Map<string, ArchivedJob>();
  for (const [id, files] of [...byJob].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    try {
      jobs.set(id, { job: snapshot(id, files), files });
    } catch (e) {
      log(`andon: ${root}: factory/archive ${id}: ${message(e)}; left out`);
    }
  }
  const byEpic = new Map<string, Map<string, string>>();
  for (const b of epicFiles) {
    const text = texts.get(b.sha);
    if (text === undefined) continue;
    const files = byEpic.get(b.slug) ?? new Map<string, string>();
    files.set(b.rel, text);
    byEpic.set(b.slug, files);
  }
  const epics = new Map<string, ArchivedEpic>();
  for (const [slug, files] of [...byEpic].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    try {
      epics.set(slug, archivedEpic(slug, files));
    } catch (e) {
      log(`andon: ${root}: factory/archive epics/${slug}: ${message(e)}; left out`);
    }
  }
  return { tip, jobs, epics };
}

// An archived epic's parsed log and plan. Throws a one-line reason when it can't be projected (no
// log, a torn or malformed one, or one that doesn't start with this epic's `epic.started`).
function archivedEpic(slug: string, files: Map<string, string>): ArchivedEpic {
  const text = files.get('events.jsonl');
  if (text === undefined) throw new Error('no events.jsonl');
  if (text !== '' && !text.endsWith('\n')) throw new Error('events.jsonl does not end with a newline (torn)');
  const log = parseEpicLog(text);
  const first = log[0];
  if (first === undefined || first.type !== 'epic.started') throw new Error('events.jsonl does not start with epic.started');
  if (first.slug !== slug) throw new Error(`events.jsonl claims ${JSON.stringify(first.slug)}`);
  const plan = files.get('plan.md') ?? null;
  let members: PlanMember[] = [];
  let planError: string | null = null;
  if (plan === null) planError = `plan ${planPath(slug)} is missing`;
  else {
    const parsed = parsePlan(plan);
    members = parsed.members;
    const [problem] = parsed.errors;
    if (problem !== undefined) planError = `plan ${planPath(slug)} ${problem}`;
  }
  return { slug, log, plan, members, planError };
}

// A board job as the epic projection reads it (as the CLI reads `job.json`), or null when it isn't
// one of `slug`'s jobs or has no string `stage`.
function epicJob(job: Job, slug: string): EpicJob | null {
  if (job.epic !== slug || typeof job.id !== 'string' || typeof job.stage !== 'string') return null;
  return {
    id: job.id,
    stage: job.stage,
    kind: JOB_KINDS.find((k) => k === job.kind) ?? 'member',
    brief: typeof job.brief === 'string' ? job.brief : null,
    updated: typeof job.updated === 'string' ? job.updated : null,
  };
}

/**
 * An archived epic's `epic.json`, as the CLI would project it: by `projectEpic` from its archived
 * log and plan and its jobs as the board holds them (`jobs`: local wins, else archived).
 */
export function projectArchivedEpic(epic: ArchivedEpic, jobs: readonly Job[]): Job {
  const mine = jobs.map((j) => epicJob(j, epic.slug)).filter((j) => j !== null).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const snap: unknown = JSON.parse(JSON.stringify(projectEpic(epic.log, epic.members, mine, epic.planError)));
  if (!isRecord(snap)) throw new Error('projection is not an object');
  return snap;
}
