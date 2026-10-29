// The factory CLI's core commands — the only writer of job state (docs/contract/v1.md "CLI").
//   claim <slug> [brief=…] [issue=…] [maxRound=…] [session=t3code:<environmentId>/<threadId>]
//   event <id> <type> [field=value …]
//   rebuild <id> | --all
//   show <id>
//   abandon <id> "<reason>" [--force] [--delete-branch]
//   archive <id> | --all [--force]
//   doctor
// This is everything the installed, self-contained `factory/cli.ts` carries (`installed.ts`).
// The source CLI (`index.ts`) adds `init` and `upgrade` on top.
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { appendEvent, archiveEnabled, checkClaim, checkSlug, claimJob, formatShow, isJobId, mergeTarget, parseConfig, parseEventInput, parseFields, project, readLog, rebuild } from '@factory/contract';
import { archiveJob, archivedIds, isTerminal, localJobIds, readLocalJob } from './archive';
import { doctor } from './doctor';
import { deleteBranch, removeWorktree, resolveTarget } from './git';
import { isNotFound } from './paths';

export interface Io {
  root: string; // the factory/ directory
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  registry?: string; // the Andon registry file `init` registers in (source CLI only); absent: none
  now?: () => Date; // drives `show`'s open spans; event timestamps always come from the store's clock
}

export const USAGE = {
  claim: 'usage: claim <slug> [brief=…] [issue=…] [maxRound=…] [session=t3code:<environmentId>/<threadId>]',
  event: 'usage: event <id> <type> [field=value …]',
  rebuild: 'usage: rebuild <id> | --all',
  show: 'usage: show <id>',
  abandon: 'usage: abandon <id> "<reason>" [--force] [--delete-branch]',
  archive: 'usage: archive <id> | --all [--force]',
  // The installed CLI's top-level usage line; `doctor`, `abandon`, and `archive` are documented in docs/contract/v1.md.
  all: 'usage: claim <slug> [k=v …] | event <id> <type> [k=v …] | rebuild <id>|--all | show <id>',
};

// Runs one core command; an unknown or missing command is a usage error naming `usage`.
export async function dispatchCore(argv: readonly string[], io: Io, usage: string = USAGE.all): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === 'doctor') {
    // A bad config.json is a finding here, not a crash before dispatch.
    const findings = await doctor(io.root);
    for (const f of findings) io.stdout(f.line);
    return findings.every((f) => f.ok) ? 0 : 1;
  }
  const config = parseConfig(JSON.parse(await readFile(join(io.root, 'config.json'), 'utf8')));
  switch (cmd) {
    case 'claim': {
      const [slug, ...kv] = rest;
      if (slug === undefined) throw new Error(USAGE.claim);
      checkSlug(slug);
      const fields = parseFields(kv);
      // The slug and fields are checked before git runs; the target is resolved before the claim
      // lock is taken, so a refusal writes nothing and uses up no job number.
      checkClaim(slug, { fields, config });
      const repo = dirname(resolve(io.root));
      const target = await resolveTarget(repo, mergeTarget(config));
      // The archive's ids count whatever the config says, so turning archiving off never reuses a number.
      io.stdout((await claimJob(io.root, slug, { fields, config, target }, undefined, { archived: () => archivedIds(repo) })).id);
      return 0;
    }
    case 'event': {
      const [id, type, ...kv] = rest;
      if (!id || !type) throw new Error(USAGE.event);
      if (type === 'job.claimed') throw new Error(`job.claimed is written only by claim: run ${USAGE.claim.replace('usage: ', '')}`);
      const fields = parseFields(kv);
      io.stdout((await appendEvent(io.root, id, parseEventInput(type, fields, { id, config }))).stage);
      return 0;
    }
    case 'rebuild': {
      const [target] = rest;
      if (!target) throw new Error(USAGE.rebuild);
      const ids = await rebuild(io.root, target === '--all' ? undefined : target);
      io.stdout(`rebuilt ${ids.length}: ${ids.join(' ')}`);
      return 0;
    }
    case 'show': {
      const [id] = rest;
      if (!id) throw new Error(USAGE.show);
      const log = await readLog(io.root, id);
      if (log.length === 0) throw new Error(`${id}: no events.jsonl (legacy or unknown job)`);
      for (const line of formatShow(project(log), (io.now ?? (() => new Date()))())) io.stdout(line);
      return 0;
    }
    case 'abandon':
      return abandon(rest, io);
    case 'archive': {
      const args = parseArchive(rest);
      if (!archiveEnabled(config)) throw new Error('archiving is disabled: config.json has no "archive": { "enabled": true }; nothing written');
      return args.all ? archiveAll(io, args.force) : archiveOne(io, args.target, args.force);
    }
    default:
      throw new Error(usage);
  }
}

interface AbandonArgs {
  id: string;
  reason: string;
  force: boolean;
  deleteBranch: boolean;
}

// `<id> "<reason>"` then the two flags, each at most once, in any order; anything else is usage.
function parseAbandon(rest: readonly string[]): AbandonArgs {
  const [id, reason, ...flags] = rest;
  if (id === undefined || reason === undefined || reason === '' || flags.length > 2) throw new Error(USAGE.abandon);
  const known = ['--force', '--delete-branch'];
  if (flags.some((f) => !known.includes(f)) || new Set(flags).size !== flags.length) throw new Error(USAGE.abandon);
  return { id, reason, force: flags.includes('--force'), deleteBranch: flags.includes('--delete-branch') };
}

const isDir = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
};

// Closes a job for good: logs `job.abandoned` (the transition check runs under the per-job lock),
// then removes its worktree and, with --delete-branch, its branch. The event is logged before
// cleanup, as `job.merged` is, so git and the board can't disagree about whether the job is closed.
async function abandon(rest: readonly string[], io: Io): Promise<number> {
  const args = parseAbandon(rest);
  if (!isJobId(args.id)) throw new Error(`job id '${args.id}' must match ^\\d{3}-[a-z0-9-]+$`);
  const input = parseEventInput('job.abandoned', { reason: args.reason });
  const snap = await appendEvent(io.root, args.id, input, undefined, { force: args.force });

  const repo = dirname(resolve(io.root));
  const branch = `factory/${args.id}`;
  const worktree = relative(repo, join(resolve(io.root), '.worktrees', args.id));
  const left: string[] = [];
  if (await isDir(join(repo, worktree))) {
    const why = await removeWorktree(repo, worktree);
    if (why !== null) left.push(`worktree ${worktree} (${why})`);
  }
  if (args.deleteBranch) {
    if (snap.branch !== branch) left.push(`branch ${snap.branch} (not ${branch}; not deleted)`);
    else if (left.length > 0) left.push(`branch ${branch} (its worktree is still there)`);
    else {
      const why = await deleteBranch(repo, branch);
      if (why !== null) left.push(`branch ${branch} (${why})`);
    }
  }
  if (left.length > 0) throw new Error(`${args.id} is abandoned, but cleanup left behind: ${left.join('; ')}`);
  io.stdout(snap.stage);
  return 0;
}

interface ArchiveArgs {
  all: boolean;
  target: string;
  force: boolean;
}

// `<id>` or `--all`, plus `--force` at most once, in any order; anything else is usage.
function parseArchive(rest: readonly string[]): ArchiveArgs {
  const force = rest.filter((a) => a === '--force').length;
  const others = rest.filter((a) => a !== '--force');
  const [target] = others;
  if (force > 1 || others.length !== 1 || target === undefined || target === '') throw new Error(USAGE.archive);
  if (target.startsWith('-') && target !== '--all') throw new Error(USAGE.archive);
  return { all: target === '--all', target, force: force === 1 };
}

// Archives one job; it must be `merged` or `abandoned`. Prints `archived <id> <short sha>`, or
// `<id>: already archived (unchanged)` for a no-op.
async function archiveOne(io: Io, id: string, force: boolean): Promise<number> {
  const job = await readLocalJob(io.root, id);
  const outcome = await archiveJob(dirname(resolve(io.root)), job, force);
  io.stdout(outcome.kind === 'archived' ? `archived ${id} ${outcome.commit.slice(0, 7)}` : `${id}: already archived (unchanged)`);
  return 0;
}

// Archives every terminal local job in id order, one commit each; unchanged ones are no-ops and
// live ones are skipped. A per-job failure is one stderr line, and the rest still run.
async function archiveAll(io: Io, force: boolean): Promise<number> {
  const repo = dirname(resolve(io.root));
  let archived = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;
  for (const id of await localJobIds(io.root)) {
    try {
      const job = await readLocalJob(io.root, id);
      if (!isTerminal(job)) {
        skipped++;
        continue;
      }
      const outcome = await archiveJob(repo, job, force);
      if (outcome.kind === 'unchanged') unchanged++;
      else {
        archived++;
        io.stdout(`archived ${id} ${outcome.commit.slice(0, 7)}`);
      }
    } catch (e) {
      failed++;
      io.stderr((e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '');
    }
  }
  io.stdout(`archive --all: archived ${archived}, unchanged ${unchanged}, skipped ${skipped} (not merged or abandoned), failed ${failed}`);
  return failed === 0 ? 0 : 1;
}

// Runs `body` and returns its exit code; any thrown error becomes exit 1 with one stderr line.
export async function guarded(io: Io, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (e) {
    io.stderr((e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '');
    return 1;
  }
}

// Returns the exit code: 0 on success, 1 on any rejection or usage error (one stderr line).
export function runCore(argv: readonly string[], io: Io): Promise<number> {
  return guarded(io, () => dispatchCore(argv, io));
}
