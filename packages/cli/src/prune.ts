// `factory prune` (docs/contract/v1.md "CLI", `prune`): removes the local `jobs/<id>/` dirs whose
// record is already on `factory/archive`, and only those. A dir is removed when it is archived,
// settled, and its tree (the file set `archive` copies) equals the archived `<id>/` tree. It reads
// only the local branch, writes no git object, moves no ref, and never fetches or pushes. Settling
// is the contract's epic-aware rule (`isSettled` in `@factory/contract`): a job in an epic is never
// pruned while its epic isn't landed or abandoned. Then terminal epic dirs (`jobs/epics/<slug>/`)
// are swept the same way against `epics/<slug>/` on the branch.
import { lstat, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { epicSlugs, isEpicSettled, isEpicSlug, isSettled, loggedEpicState } from '@factory/contract';
import type { SettleEpic } from '@factory/contract';
import { archivedEpicLog, archivedEpicTrees, archivedTrees, isEpicTerminal, isTerminal, localJobIds, matchesArchived, matchesArchivedEpic, readLocalEpic, readLocalJob } from './archive';
import type { LocalEpic, LocalJob } from './archive';
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

// An epic's terminal facts for the settle rule: from its local dir, else from its archived log
// (a pruned epic), else null (unknown). Cached per run.
type EpicFacts = (slug: string) => Promise<SettleEpic | null>;

function epicFacts(io: PruneIo, repo: string): EpicFacts {
  const cache = new Map<string, Promise<SettleEpic | null>>();
  const read = async (slug: string): Promise<SettleEpic | null> => {
    if (!isEpicSlug(slug)) return null;
    if (await exists(join(io.root, 'jobs', 'epics', slug))) {
      try {
        const epic = await readLocalEpic(io.root, slug);
        return { state: epic.state, endedAt: epic.endedAt };
      } catch (e) {
        if (isSystemError(e)) throw e;
        return null; // a local epic that can't be read is unknown, never settled
      }
    }
    const log = await archivedEpicLog(repo, slug);
    if (log === null || log.length === 0) return null;
    const end = [...log].reverse().find((e) => e.type === 'epic.landed' || e.type === 'epic.abandoned');
    return { state: loggedEpicState(log), endedAt: end?.ts ?? null };
  };
  return (slug) => {
    let hit = cache.get(slug);
    if (hit === undefined) {
      hit = read(slug);
      cache.set(slug, hit);
    }
    return hit;
  };
}

// The read-only checks, in order: an event in flight, a readable job, terminal, its epic terminal
// (a job in an epic), settled, archived. Returns the job and its archived tree when all pass.
async function check(io: PruneIo, id: string, trees: Map<string, string>, hours: number, now: Date, facts: EpicFacts): Promise<Decision | { kind: 'candidate'; job: LocalJob; tree: string }> {
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
  let epic: SettleEpic | null = null;
  if (job.epic !== null) {
    epic = await facts(job.epic);
    if (epic === null) return { kind: 'keep', reason: `its epic ${job.epic} is not found` };
    if (epic.state !== 'landed' && epic.state !== 'abandoned') return { kind: 'keep', reason: `its epic ${job.epic} is not landed or abandoned (${epic.state ?? 'unreadable'})` };
  }
  if (!isSettled(job, hours, now, epic)) return { kind: 'keep', reason: 'not settled' };
  const tree = trees.get(id);
  if (tree === undefined) return { kind: 'keep', reason: 'not archived' };
  return { kind: 'candidate', job, tree };
}

// Takes the dir's `.events.lock` (without waiting), so no event lands between the comparison and
// the removal; an appender waiting on it then fails on the missing dir. Kept: the lock is released.
async function compareAndRemove(dir: string, same: () => Promise<boolean>): Promise<Decision> {
  const lock = join(dir, LOCK);
  try {
    await mkdir(lock);
  } catch (e) {
    if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'EEXIST') return { kind: 'keep', reason: IN_FLIGHT };
    throw e;
  }
  let equal: boolean;
  try {
    equal = await same();
  } catch (e) {
    await rm(lock, { recursive: true, force: true });
    throw e;
  }
  if (!equal) {
    await rm(lock, { recursive: true, force: true });
    return { kind: 'keep', reason: 'differs from its archived tree' };
  }
  // `rm` unlinks symlinks inside the dir; it never follows them.
  await rm(dir, { recursive: true });
  return { kind: 'prune' };
}

// The epic checks, in order: an event in flight, a readable epic, terminal, settled, archived.
async function checkEpic(io: PruneIo, slug: string, trees: Map<string, string>, hours: number, now: Date): Promise<Decision | { kind: 'candidate'; epic: LocalEpic; tree: string }> {
  if (await exists(join(io.root, 'jobs', 'epics', slug, LOCK))) return { kind: 'keep', reason: IN_FLIGHT };
  let epic: LocalEpic;
  try {
    epic = await readLocalEpic(io.root, slug);
  } catch (e) {
    if (isSystemError(e)) throw e;
    const text = lineOf(e);
    return { kind: 'keep', reason: text.startsWith(`epic ${slug}: `) ? text.slice(`epic ${slug}: `.length) : text };
  }
  if (!isEpicTerminal(epic)) return { kind: 'keep', reason: `not landed or abandoned (${epic.state ?? 'unreadable'})` };
  if (!isEpicSettled(epic, hours, now)) return { kind: 'keep', reason: 'not settled' };
  const tree = trees.get(slug);
  if (tree === undefined) return { kind: 'keep', reason: 'not archived' };
  return { kind: 'candidate', epic, tree };
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
  const epicTrees = await archivedEpicTrees(repo);
  const facts = epicFacts(io, repo);
  let removed = 0;
  let kept = 0;
  let failed = 0;
  for (const id of await localJobIds(io.root)) {
    try {
      const first = await check(io, id, trees, settleAfterHours, now, facts);
      const decision = first.kind === 'candidate' ? await compareAndRemove(first.job.dir, () => matchesArchived(repo, first.job, first.tree)) : first;
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
  for (const slug of await epicSlugs(io.root)) {
    const name = `epic ${slug}`;
    try {
      const first = await checkEpic(io, slug, epicTrees, settleAfterHours, now);
      const decision = first.kind === 'candidate' ? await compareAndRemove(first.epic.dir, () => matchesArchivedEpic(repo, first.epic, first.tree)) : first;
      if (decision.kind === 'prune') {
        removed++;
        io.stdout(`pruned ${name}`);
      } else {
        kept++;
        io.stdout(`kept ${name}: ${decision.reason}`);
      }
    } catch (e) {
      failed++;
      const text = lineOf(e);
      io.stderr(text.startsWith(`${name}: `) ? text : `${name}: ${text}`);
    }
  }
  io.stdout(`prune: removed ${removed}, kept ${kept}, failed ${failed}`);
  return failed === 0 ? 0 : 1;
}
