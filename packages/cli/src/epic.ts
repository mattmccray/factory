// `factory epic …` (docs/contract/v1.md "Epics" and "CLI"): the epic's setup and teardown, its
// events, and its scheduling. The CLI owns the epic's git setup (`epic start`: branch and
// worktree) and teardown (`epic abandon`); every merge stays with the orchestrator.
//   epic start <slug> [session=…]
//   epic event <slug> <type> [field=value …]
//   epic next <slug>
//   epic show <slug>
//   epic abandon <slug> "<reason>" [--force] [--delete-branch]
import { lstat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import {
  appendEpicEvent,
  checkEpicSlug,
  epicBranch,
  epicMaxParallel,
  epicNext,
  epicPlanProblem,
  loadEpic,
  mergeTarget,
  parseEpicEventInput,
  parseFields,
  readEpicJobs,
  rebuildEpic,
  startEpic,
} from '@factory/contract';
import type { Config, EpicSnapshot } from '@factory/contract';
import { abandonJob, isDir } from './abandon';
import { addWorktree, branchExists, deleteBranch, removeWorktree, resolveTarget } from './git';
import { isNotFound } from './paths';

export const EPIC_USAGE = {
  epic: 'usage: epic start|event|next|show|abandon <slug> …',
  epicStart: 'usage: epic start <slug> [session=t3code:<environmentId>/<threadId>]',
  epicEvent: 'usage: epic event <slug> <type> [field=value …]',
  epicNext: 'usage: epic next <slug>',
  epicShow: 'usage: epic show <slug>',
  epicAbandon: 'usage: epic abandon <slug> "<reason>" [--force] [--delete-branch]',
};

export interface EpicIo {
  root: string; // the factory/ directory
  stdout: (line: string) => void;
}

const WORKING = ['claimed', 'spec', 'build', 'review', 'approve'];

// `lstat`, so a dangling symlink at the worktree path still counts as taken.
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

/** The epic worktree, relative to the repo root: `factory/.worktrees/epic-<slug>`. */
const worktreeOf = (repo: string, root: string, slug: string): string => relative(repo, join(resolve(root), '.worktrees', `epic-${slug}`));

/** Runs one `epic` subcommand; `config` was parsed by the caller. */
export async function runEpic(rest: readonly string[], io: EpicIo, config: Config): Promise<number> {
  const [sub, ...args] = rest;
  switch (sub) {
    case 'start':
      return start(args, io, config);
    case 'event':
      return event(args, io);
    case 'next':
      return next(args, io, config);
    case 'show':
      return show(args, io);
    case 'abandon':
      return abandon(args, io);
    default:
      throw new Error(EPIC_USAGE.epic);
  }
}

// All or nothing: every check runs first (the slug before any path; the plan, the target, the
// fields), then the epic dir is reserved, the branch and worktree are made, and `epic.started`
// is logged. Any failure after the reservation undoes the git work and removes the dir.
async function start(args: readonly string[], io: EpicIo, config: Config): Promise<number> {
  const [slug, ...kv] = args;
  if (slug === undefined || slug === '') throw new Error(EPIC_USAGE.epicStart);
  checkEpicSlug(slug);
  const fields = parseFields(kv);
  const problem = await epicPlanProblem(io.root, slug);
  if (problem !== null) throw new Error(`epic start ${slug}: ${problem}`);
  const repo = dirname(resolve(io.root));
  const target = await resolveTarget(repo, mergeTarget(config));
  const input = parseEpicEventInput('epic.started', fields, { slug, target });
  const branch = epicBranch(slug);
  const worktree = worktreeOf(repo, io.root, slug);
  const setup = async (): Promise<() => Promise<void>> => {
    if (await branchExists(repo, branch)) throw new Error(`epic start ${slug}: branch ${branch} already exists`);
    if (await pathExists(join(repo, worktree))) throw new Error(`epic start ${slug}: ${worktree} already exists`);
    const undo = async (): Promise<void> => {
      if (await isDir(join(repo, worktree))) await removeWorktree(repo, worktree);
      await deleteBranch(repo, branch);
    };
    const why = await addWorktree(repo, worktree, branch, target);
    if (why !== null) {
      await undo();
      throw new Error(`epic start ${slug}: git worktree add failed: ${why}`);
    }
    return undo;
  };
  const snap = await startEpic(io.root, slug, input, undefined, setup);
  io.stdout(snap.state);
  return 0;
}

async function event(args: readonly string[], io: EpicIo): Promise<number> {
  const [slug, type, ...kv] = args;
  if (!slug || !type) throw new Error(EPIC_USAGE.epicEvent);
  checkEpicSlug(slug);
  if (type === 'epic.started') throw new Error(`epic.started is written only by epic start: run ${EPIC_USAGE.epicStart.replace('usage: ', '')}`);
  if (type === 'epic.abandoned') throw new Error(`epic.abandoned is written only by epic abandon: run ${EPIC_USAGE.epicAbandon.replace('usage: ', '')}`);
  const input = parseEpicEventInput(type, parseFields(kv));
  io.stdout((await appendEpicEvent(io.root, slug, input)).state);
  return 0;
}

async function next(args: readonly string[], io: EpicIo, config: Config): Promise<number> {
  const [slug, ...extra] = args;
  if (!slug || extra.length > 0) throw new Error(EPIC_USAGE.epicNext);
  checkEpicSlug(slug);
  const inputs = await loadEpic(io.root, slug);
  if (inputs.log.length === 0) throw new Error(`epic ${slug} has not started`);
  for (const line of epicNext(inputs.view, epicMaxParallel(config))) io.stdout(line);
  return 0;
}

async function show(args: readonly string[], io: EpicIo): Promise<number> {
  const [slug, ...extra] = args;
  if (!slug || extra.length > 0) throw new Error(EPIC_USAGE.epicShow);
  checkEpicSlug(slug);
  for (const line of formatEpicShow(await rebuildEpic(io.root, slug))) io.stdout(line);
  return 0;
}

/** `epic show`'s lines: the epic's state, why it waits, each member's state, and the generated jobs. */
export function formatEpicShow(snap: EpicSnapshot): string[] {
  const out = [`epic ${snap.slug}  ${snap.state}  ${snap.branch} -> ${snap.target}`];
  if (snap.waitingOn === 'you') out.push(`waiting on you: ${snap.note}`);
  if (snap.waitingOn === 'members') {
    const stuck = [...snap.members.filter((m) => m.state === 'needs-human').map((m) => `${m.slug} (${m.job ?? ''})`), ...snap.generated.filter((g) => g.stage === 'needs-human').map((g) => `${g.kind} ${g.id}`)];
    out.push(`waiting on members: nothing else can run; needs-human: ${stuck.join(', ')}`);
  }
  if (snap.state === 'abandoned' || snap.state === 'landed') out.push(`note: ${snap.note}`);
  if (snap.planError !== null) out.push(`plan: ${snap.planError}`);
  for (const m of snap.members) {
    const parts = [`member ${m.slug}`, m.state];
    if (m.job !== null) parts.push(m.job);
    if (m.state === 'running' && m.stage !== null) parts.push(m.stage);
    if (m.state === 'blocked') parts.push(`blocked on ${m.blockedOn.map((b) => (b.job === null ? b.member : `${b.member} (${b.job})`)).join(', ')}`);
    out.push(parts.join('  '));
  }
  for (const g of snap.generated) out.push(`${g.kind} ${g.id}  ${g.stage}`);
  return out;
}

interface AbandonArgs {
  slug: string;
  reason: string;
  force: boolean;
  deleteBranch: boolean;
}

function parseAbandon(args: readonly string[]): AbandonArgs {
  const [slug, reason, ...flags] = args;
  if (slug === undefined || reason === undefined || reason === '' || flags.length > 2) throw new Error(EPIC_USAGE.epicAbandon);
  const known = ['--force', '--delete-branch'];
  if (flags.some((f) => !known.includes(f)) || new Set(flags).size !== flags.length) throw new Error(EPIC_USAGE.epicAbandon);
  return { slug, reason, force: flags.includes('--force'), deleteBranch: flags.includes('--delete-branch') };
}

// Logs `epic.abandoned` first (refused, writing nothing, while an epic job is in a working stage
// and `--force` isn't given), which closes the epic to new claims; then abandons every epic job
// that isn't merged or abandoned (as `abandon` does, with `--force` passed through), and removes
// the epic worktree and, with `--delete-branch`, the epic branch. Job branches are kept.
async function abandon(args: readonly string[], io: EpicIo): Promise<number> {
  const a = parseAbandon(args);
  checkEpicSlug(a.slug);
  const input = parseEpicEventInput('epic.abandoned', { reason: a.reason });
  await appendEpicEvent(io.root, a.slug, input, undefined, {
    check: ({ jobs }) => {
      const working = jobs.filter((j) => WORKING.includes(j.stage));
      if (working.length > 0 && !a.force) {
        throw new Error(`epic ${a.slug}: ${working.map((j) => `${j.id} (${j.stage})`).join(', ')} ${working.length === 1 ? 'is' : 'are'} in a working stage; stop ${working.length === 1 ? 'its session' : 'their sessions'} and pass --force`);
      }
    },
  });
  const left: string[] = [];
  for (const j of await readEpicJobs(io.root, a.slug)) {
    if (j.stage === 'merged' || j.stage === 'abandoned') continue;
    try {
      const r = await abandonJob(io.root, { id: j.id, reason: `epic ${a.slug} abandoned: ${a.reason}`, force: a.force, deleteBranch: false });
      left.push(...r.left);
    } catch (e) {
      left.push(`job ${j.id} (${(e instanceof Error ? e.message : String(e)).split('\n')[0] ?? ''})`);
    }
  }
  const repo = dirname(resolve(io.root));
  const worktree = worktreeOf(repo, io.root, a.slug);
  const branch = epicBranch(a.slug);
  let worktreeLeft = false;
  if (await isDir(join(repo, worktree))) {
    const why = await removeWorktree(repo, worktree);
    if (why !== null) {
      worktreeLeft = true;
      left.push(`worktree ${worktree} (${why})`);
    }
  }
  if (a.deleteBranch) {
    if (worktreeLeft) left.push(`branch ${branch} (its worktree is still there)`);
    else {
      const why = await deleteBranch(repo, branch);
      if (why !== null) left.push(`branch ${branch} (${why})`);
    }
  }
  if (left.length > 0) throw new Error(`epic ${a.slug} is abandoned, but cleanup left behind: ${left.join('; ')}`);
  io.stdout('abandoned');
  return 0;
}
