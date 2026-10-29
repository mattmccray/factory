// The job archive (docs/contract/v1.md "Job archive"): `factory archive` copies a terminal job's
// files to the orphan branch `factory/jobs`, one top-level `<id>/` dir per job, with git plumbing
// only. It never touches the main checkout's working tree, index, or HEAD, never fetches, and
// never pushes. `archivedIds` lists the branch's job ids for `claim`.
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isJobId, project, readLog } from '@factory/contract';
import { runGit } from './git';
import type { GitOptions, GitResult } from './git';
import { isNotFound } from './paths';

/** The archive branch. `refs/heads/factory/jobs` sits beside job branches without a conflict: ids start with digits. */
export const ARCHIVE_BRANCH = 'factory/jobs';
const ARCHIVE_REF = `refs/heads/${ARCHIVE_BRANCH}`;
const WHAT = 'archive';
// A lost compare-and-swap race is retried from the new tip, this many times in all.
const MAX_ATTEMPTS = 50;
const HEX_SHA = /^[0-9a-f]{4,64}$/;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function git(repo: string, args: readonly string[], opts: GitOptions = {}): Promise<GitResult> {
  const r = await runGit(repo, args, { what: WHAT, ...opts });
  if (r.code !== 0) throw new Error(`${WHAT}: git ${args[0] ?? ''} failed: ${r.err || `exit ${r.code}`}`);
  return r;
}

/** The archive branch's tip commit in `repo`, or null when the branch doesn't exist. */
export async function archiveTip(repo: string): Promise<string | null> {
  const r = await runGit(repo, ['rev-parse', '--verify', '--quiet', `${ARCHIVE_REF}^{commit}`], { what: WHAT });
  if (r.code === 0 && r.out !== '') return r.out;
  if (r.code === 1) return null;
  throw new Error(`${WHAT}: git rev-parse failed in ${repo}: ${r.err || `exit ${r.code}`}`);
}

interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  name: string;
}

// `git ls-tree -z` lines: `<mode> SP <type> SP <sha> TAB <name>`, NUL-terminated.
async function lsTree(repo: string, treeish: string): Promise<TreeEntry[]> {
  const r = await git(repo, ['ls-tree', '-z', treeish]);
  const out: TreeEntry[] = [];
  for (const line of r.raw.split('\0')) {
    if (line === '') continue;
    const tab = line.indexOf('\t');
    const [mode, type, sha] = line.slice(0, tab).split(' ');
    if (tab < 0 || mode === undefined || type === undefined || sha === undefined) throw new Error(`${WHAT}: unexpected git ls-tree line`);
    out.push({ mode, type, sha, name: line.slice(tab + 1) });
  }
  return out;
}

const mkTreeLine = (e: TreeEntry): string => `${e.mode} ${e.type} ${e.sha}\t${e.name}`;

async function mkTree(repo: string, entries: readonly TreeEntry[], env?: Record<string, string>): Promise<string> {
  const input = entries.map((e) => `${mkTreeLine(e)}\0`).join('');
  return (await git(repo, ['mktree', '-z'], { input, env })).out;
}

/**
 * The job ids archived on `factory/jobs`: its top-level directories named like a job id, sorted.
 * None when the branch is missing. Reads the local branch only; never fetches.
 */
export async function archivedIds(repo: string): Promise<string[]> {
  const tip = await archiveTip(repo);
  if (tip === null) return [];
  return (await lsTree(repo, tip)).filter((e) => e.type === 'tree' && isJobId(e.name)).map((e) => e.name).sort();
}

/** A local job dir, read for archiving. */
export interface LocalJob {
  id: string;
  dir: string;
  legacy: boolean; // no events.jsonl: its job.json is its only state, so it is archived too
  stage: string | null; // null: unreadable
  claimed: { id: string; ts: string } | null; // the log's job.claimed, when it has one
  mergedSha: string | null; // the last job.merged sha, when there is one
}

// `lstat`, so a symlinked job dir is never followed.
async function isDir(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

async function legacyStage(dir: string): Promise<string | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, 'job.json'), 'utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || !('stage' in raw) || typeof raw.stage !== 'string') return null;
  return raw.stage;
}

/** Reads `jobs/<id>/` under `root` (the factory/ directory). The id is checked before any path is built. */
export async function readLocalJob(root: string, id: string): Promise<LocalJob> {
  if (!isJobId(id)) throw new Error(`job id '${id}' must match ^\\d{3}-[a-z0-9-]+$`);
  const dir = join(root, 'jobs', id);
  if (!(await isDir(dir))) {
    if (await exists(dir)) throw new Error(`${id}: not a directory (a symlinked job dir is never followed); not archived`);
    throw new Error(`${id}: no such job`);
  }
  const log = await readLog(root, id);
  // Legacy means no events.jsonl at all; an empty one is a broken log, not a legacy job.
  if (log.length === 0 && (await exists(join(dir, 'events.jsonl')))) throw new Error(`${id}: events.jsonl is empty; not archived`);
  if (log.length === 0) {
    const stage = await legacyStage(dir);
    if (stage === null) throw new Error(`${id}: no events.jsonl and no readable job.json; not archived`);
    return { id, dir, legacy: true, stage, claimed: null, mergedSha: null };
  }
  const [first] = log;
  if (first === undefined || first.type !== 'job.claimed') throw new Error(`${id}: events.jsonl does not start with job.claimed; not archived`);
  const claimed = { id: first.id, ts: first.ts };
  let mergedSha: string | null = null;
  for (const e of log) if (e.type === 'job.merged') mergedSha = e.sha;
  // The stage comes from the log (the truth), never from job.json.
  return { id, dir, legacy: false, stage: project(log).stage, claimed, mergedSha };
}

export const isTerminal = (job: LocalJob): boolean => job.stage === 'merged' || job.stage === 'abandoned';

// What is copied from the job dir's top level: everything but `job.json` (and its temp file) and
// lock dirs. A legacy job keeps its `job.json`. Only regular files and dirs are copied; symlinks
// are never followed. Empty dirs have no git tree, so they are left out.
function skipTop(name: string, isDirectory: boolean, legacy: boolean): boolean {
  if (isDirectory) return name.endsWith('.lock');
  return (name === 'job.json' && !legacy) || name === 'job.json.tmp';
}

async function buildTree(repo: string, dir: string, top: boolean, legacy: boolean, env: Record<string, string> | undefined): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  const tree: TreeEntry[] = [];
  for (const e of entries) {
    if (top && skipTop(e.name, e.isDirectory(), legacy)) continue;
    if (e.isFile()) files.push(e.name);
    else if (e.isDirectory()) {
      const sha = await buildTree(repo, join(dir, e.name), false, legacy, env);
      if (sha !== null) tree.push({ mode: '040000', type: 'tree', sha, name: e.name });
    }
  }
  if (files.length > 0) {
    const shas = (await git(repo, ['hash-object', '-w', '--no-filters', '--', ...files.map((f) => join(dir, f))], { env })).out.split('\n');
    if (shas.length !== files.length) throw new Error(`${WHAT}: git hash-object returned ${shas.length} ids for ${files.length} files`);
    files.forEach((name, i) => tree.push({ mode: '100644', type: 'blob', sha: shas[i] ?? '', name }));
  }
  if (tree.length === 0) return null;
  return mkTree(repo, tree, env);
}

async function jobTree(repo: string, job: LocalJob, env?: Record<string, string>): Promise<string> {
  const sha = await buildTree(repo, job.dir, true, job.legacy, env);
  if (sha === null) throw new Error(`${job.id}: nothing to archive (no files)`);
  return sha;
}

// One entry for GIT_ALTERNATE_OBJECT_DIRECTORIES: C-quoted when it holds the ':' separator or
// starts with a quote, so git never splits a repo path.
function alternate(path: string): string {
  if (!path.includes(':') && !path.startsWith('"')) return path;
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Builds the job's tree in a scratch object directory (the repo's objects are read through it as
// an alternate), so comparing it with the archive writes nothing to the repo.
async function trialTree(repo: string, job: LocalJob): Promise<string> {
  const objects = (await git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'])).out;
  const scratch = await mkdtemp(join(tmpdir(), 'factory-archive-'));
  try {
    return await jobTree(repo, job, { GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate(objects) });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// The archived job's `job.claimed` id and ts, read from `<id>/events.jsonl` on the branch.
async function archivedClaim(repo: string, tree: string): Promise<{ id: string; ts: string } | null> {
  const log = (await lsTree(repo, tree)).find((e) => e.name === 'events.jsonl' && e.type === 'blob');
  if (log === undefined) return null;
  const text = (await git(repo, ['cat-file', 'blob', log.sha])).raw;
  const first = text.split('\n')[0] ?? '';
  let raw: unknown;
  try {
    raw = JSON.parse(first);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || !('type' in raw) || raw.type !== 'job.claimed') return null;
  if (!('id' in raw) || typeof raw.id !== 'string' || !('ts' in raw) || typeof raw.ts !== 'string') return null;
  return { id: raw.id, ts: raw.ts };
}

const describeClaim = (c: { id: string; ts: string } | null): string => (c === null ? 'no job.claimed' : `job.claimed id=${c.id} ts=${c.ts}`);

function commitMessage(job: LocalJob): string[] {
  const trailers = [`Factory-Job: ${job.id}`];
  if (job.stage === 'merged' && job.mergedSha !== null) trailers.push(`Merged-As: ${job.mergedSha}`);
  return ['-m', `chore(factory): archive job ${job.id}`, '-m', trailers.join('\n')];
}

export type ArchiveOutcome = { kind: 'archived'; commit: string } | { kind: 'unchanged' };

/**
 * Archives one local job (which must be `merged` or `abandoned`) on `factory/jobs` in `repo`.
 * Unchanged on the branch: a no-op. Changed: refused unless `force`, which adds a new commit.
 * A different job at the same id: always refused. Every refusal moves no ref and writes no object.
 * The ref moves only by a compare-and-swap `update-ref`; a lost race is retried from the new tip.
 */
export async function archiveJob(repo: string, job: LocalJob, force: boolean): Promise<ArchiveOutcome> {
  if (!isTerminal(job)) throw new Error(`${job.id} is ${job.stage ?? 'unreadable'}: only merged or abandoned jobs are archived`);
  if (job.mergedSha !== null && !HEX_SHA.test(job.mergedSha)) throw new Error(`${job.id}: job.merged sha is not a hex commit id (${HEX_SHA.source}); not archived`);
  if (!job.legacy && job.claimed === null) throw new Error(`${job.id}: events.jsonl does not start with job.claimed; not archived`);
  let lastErr = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const tip = await archiveTip(repo);
    const top = tip === null ? [] : await lsTree(repo, tip);
    const existing = top.find((e) => e.name === job.id);
    if (existing !== undefined && existing.type !== 'tree') throw new Error(`${job.id}: ${ARCHIVE_BRANCH} has ${job.id} as a ${existing.type}, not a directory; nothing written`);
    if (existing !== undefined && !job.legacy) {
      const there = await archivedClaim(repo, existing.sha);
      if (there === null || there.id !== job.claimed?.id || there.ts !== job.claimed.ts) {
        throw new Error(`${job.id}: ${ARCHIVE_BRANCH} already holds a different job at ${job.id}/ (archived: ${describeClaim(there)}; local: ${describeClaim(job.claimed)}); nothing written`);
      }
    }
    if (existing !== undefined) {
      const trial = await trialTree(repo, job);
      if (trial === existing.sha) return { kind: 'unchanged' };
      if (job.legacy) {
        throw new Error(`${job.id}: ${ARCHIVE_BRANCH} already holds a different job at ${job.id}/ (archived: tree ${existing.sha.slice(0, 7)}; local legacy job: tree ${trial.slice(0, 7)}); nothing written`);
      }
      if (!force) throw new Error(`${job.id}: changed since it was archived on ${ARCHIVE_BRANCH}; run archive ${job.id} --force to add a new commit`);
    }
    const tree = await jobTree(repo, job);
    const root = await mkTree(repo, [...top.filter((e) => e.name !== job.id), { mode: '040000', type: 'tree', sha: tree, name: job.id }]);
    const commit = (await git(repo, ['commit-tree', root, ...(tip === null ? [] : ['-p', tip]), ...commitMessage(job)])).out;
    // The old value guards the swap: '' means the branch must not exist yet.
    const r = await runGit(repo, ['update-ref', '-m', `archive job ${job.id}`, ARCHIVE_REF, commit, tip ?? ''], { what: WHAT });
    if (r.code === 0) return { kind: 'archived', commit };
    lastErr = r.err || `exit ${r.code}`;
    await sleep(5 + Math.floor(Math.random() * 25));
  }
  throw new Error(`${job.id}: ${ARCHIVE_BRANCH} kept moving; gave up after ${MAX_ATTEMPTS} tries (${lastErr})`);
}

/** The local job dirs under `root`/jobs (names matching the job-id pattern), in id order. */
export async function localJobIds(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, 'jobs'), { withFileTypes: true })).filter((d) => d.isDirectory() && isJobId(d.name)).map((d) => d.name).sort();
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
}
