// `factory prune` (docs/contract/v1.md "CLI", `prune`): removes the local `jobs/<id>/` dirs whose
// record is already on `factory/archive`, and only those. A dir is removed when it is archived,
// settled, and its tree (the file set `archive` copies) equals the archived `<id>/` tree. It reads
// only the local branch, writes no git object, moves no ref, and never fetches or pushes.
import { lstat, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { archivedTrees, isTerminal, localJobIds, matchesArchived, readLocalJob } from './archive';
import type { LocalJob } from './archive';
import { isNotFound } from './paths';

export interface PruneIo {
  root: string; // the factory/ directory
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  now?: () => Date;
}

const LOCK = '.events.lock';
const IN_FLIGHT = `an event is in flight (${LOCK})`;

type Decision = { kind: 'prune' } | { kind: 'keep'; reason: string };

// A system error (it carries a `code`, e.g. EACCES) means the job can't be checked: a failure.
// Anything else `readLocalJob` throws is its refusal, which keeps the job.
const isSystemError = (e: unknown): boolean => typeof e === 'object' && e !== null && 'code' in e;
const lineOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

/** Settled by the contract's rule: abandoned at once; merged once `endedAt` is older than `hours`. */
export function isSettled(job: LocalJob, hours: number, now: Date): boolean {
  if (job.stage === 'abandoned') return true;
  if (job.stage !== 'merged' || job.endedAt === null) return false;
  const ended = Date.parse(job.endedAt);
  return !Number.isNaN(ended) && now.getTime() - ended > hours * 3_600_000;
}

// The read-only checks, in order: an event in flight, a readable job, terminal, settled, archived.
// Returns the job and its archived tree when all pass.
async function check(io: PruneIo, id: string, trees: Map<string, string>, hours: number, now: Date): Promise<Decision | { kind: 'candidate'; job: LocalJob; tree: string }> {
  if (await exists(join(io.root, 'jobs', id, LOCK))) return { kind: 'keep', reason: IN_FLIGHT };
  let job: LocalJob;
  try {
    job = await readLocalJob(io.root, id);
  } catch (e) {
    if (isSystemError(e)) throw e;
    const text = lineOf(e);
    return { kind: 'keep', reason: text.startsWith(`${id}: `) ? text.slice(id.length + 2) : text };
  }
  if (!isTerminal(job)) return { kind: 'keep', reason: `not merged or abandoned (${job.stage ?? 'unreadable'})` };
  if (!isSettled(job, hours, now)) return { kind: 'keep', reason: 'not settled' };
  const tree = trees.get(id);
  if (tree === undefined) return { kind: 'keep', reason: 'not archived' };
  return { kind: 'candidate', job, tree };
}

// Takes the job's `.events.lock` (without waiting), so no event lands between the comparison and
// the removal; an appender waiting on it then fails on the missing dir. Kept: the lock is released.
async function compareAndRemove(repo: string, job: LocalJob, tree: string): Promise<Decision> {
  const lock = join(job.dir, LOCK);
  try {
    await mkdir(lock);
  } catch (e) {
    if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'EEXIST') return { kind: 'keep', reason: IN_FLIGHT };
    throw e;
  }
  let same: boolean;
  try {
    same = await matchesArchived(repo, job, tree);
  } catch (e) {
    await rm(lock, { recursive: true, force: true });
    throw e;
  }
  if (!same) {
    await rm(lock, { recursive: true, force: true });
    return { kind: 'keep', reason: 'differs from its archived tree' };
  }
  // `rm` unlinks symlinks inside the dir; it never follows them.
  await rm(job.dir, { recursive: true });
  return { kind: 'prune' };
}

/**
 * Sweeps every local job dir named like a job id, in id order, printing `pruned <id>` or
 * `kept <id>: <reason>` for each, then `prune: removed <n>, kept <n>, failed <n>`. A job that can't
 * be checked or removed is one stderr line and counts as failed; the rest still run. Returns 1 when
 * any job failed, else 0. The caller has already refused when archiving is off.
 */
export async function pruneAll(io: PruneIo, settleAfterHours: number): Promise<number> {
  const repo = dirname(resolve(io.root));
  const now = (io.now ?? (() => new Date()))();
  // One read of the tip, so every job is compared with the same archive.
  const trees = await archivedTrees(repo);
  let removed = 0;
  let kept = 0;
  let failed = 0;
  for (const id of await localJobIds(io.root)) {
    try {
      const first = await check(io, id, trees, settleAfterHours, now);
      const decision = first.kind === 'candidate' ? await compareAndRemove(repo, first.job, first.tree) : first;
      if (decision.kind === 'prune') {
        removed++;
        io.stdout(`pruned ${id}`);
      } else {
        kept++;
        io.stdout(`kept ${id}: ${decision.reason}`);
      }
    } catch (e) {
      failed++;
      const text = lineOf(e);
      io.stderr(text.startsWith(`${id}: `) ? text : `${id}: ${text}`);
    }
  }
  io.stdout(`prune: removed ${removed}, kept ${kept}, failed ${failed}`);
  return failed === 0 ? 0 : 1;
}
