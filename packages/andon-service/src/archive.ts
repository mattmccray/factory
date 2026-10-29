// Reading the job archive (docs/contract/v1.md "Job archive" and "Andon service"): the jobs on a
// project's `factory/archive` branch, re-projected from their archived `events.jsonl` (a legacy job
// keeps its archived `job.json`), with the markdown the `docs` endpoint serves, held in memory and
// keyed by the branch's tip sha. Git is only read: `rev-parse`, `ls-tree`, and `cat-file`, spawned
// without a shell, with fixed argument arrays. A rebuild runs one `ls-tree` and one
// `cat-file --batch` for all files, and only when the tip has moved.
import { isJobId, parseLog, project } from '@factory/contract';

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

/** The archive as read at `tip` (null: no branch, so no jobs). */
export interface ArchiveCache {
  tip: string | null;
  jobs: Map<string, ArchivedJob>;
}

export const EMPTY_ARCHIVE: ArchiveCache = { tip: null, jobs: new Map() };

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

// `git ls-tree -r -z <tip>` records: `<mode> SP <type> SP <sha> TAB <path>`, NUL-terminated. Kept:
// regular-file blobs under a top-level dir named like a job id, at a path the service reads.
export function parseTree(raw: Uint8Array): TreeBlob[] {
  const out: TreeBlob[] = [];
  for (const rec of decoder.decode(raw).split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, sha] = rec.slice(0, tab).split(' ');
    const path = rec.slice(tab + 1);
    if (type !== 'blob' || mode === undefined || !REGULAR.test(mode) || sha === undefined || !HEX_SHA.test(sha)) continue;
    const slash = path.indexOf('/');
    if (slash < 0) continue; // a file at the top level is not a job
    const id = path.slice(0, slash);
    const rel = path.slice(slash + 1);
    if (!isJobId(id) || !wanted(rel)) continue;
    out.push({ id, rel, sha });
  }
  return out;
}

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
  const blobs = parseTree(tree.stdout);
  const shas = [...new Set(blobs.map((b) => b.sha))];
  let texts = new Map<string, string>();
  if (shas.length > 0) {
    const batch = await git(['cat-file', '--batch'], { cwd: root, input: shas.map((s) => `${s}\n`).join('') });
    if (batch.code !== 0) throw new Error(`git cat-file exited ${batch.code}`);
    texts = parseBatch(batch.stdout);
  }

  const byJob = new Map<string, Map<string, string>>();
  for (const b of blobs) {
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
  return { tip, jobs };
}
