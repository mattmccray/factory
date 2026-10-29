// The factory CLI's core commands — the only writer of job state (docs/contract/v1.md "CLI").
//   claim <slug> [brief=…] [issue=…] [maxRound=…] [session=t3code:<environmentId>/<threadId>] [epic=<slug> [kind=member|sync|fix]]
//   event <id> <type> [field=value …]
//   rebuild <id> | --all
//   show <id>
//   abandon <id> "<reason>" [--force] [--delete-branch]
//   archive <id> | --all [--force]
//   prune
//   doctor
//   epic start|event|next|show|abandon <slug> …   (epic.ts)
// This is everything the installed, self-contained `factory/cli.ts` carries (`installed.ts`).
// The source CLI (`index.ts`) adds `init` and `upgrade` on top.
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { appendEvent, archiveEnabled, checkClaim, checkSlug, claimJob, epicBranch, epicSlugs, isEpicSlug, isJobId, formatShow, mergeTarget, parseConfig, parseEventInput, parseFields, project, readEpicLog, readLog, rebuildAll } from '@factory/contract';
import { abandonJob } from './abandon';
import { archiveEpic, archiveJob, archivedIds, isEpicTerminal, isTerminal, localJobIds, readLocalEpic, readLocalJob } from './archive';
import { doctor } from './doctor';
import { EPIC_USAGE, runEpic } from './epic';
import { branchExists, resolveTarget } from './git';
import { pruneAll } from './prune';

export interface Io {
  root: string; // the factory/ directory
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  registry?: string; // the Andon registry file `init` registers in (source CLI only); absent: none
  now?: () => Date; // drives `show`'s open spans and `prune`'s settle check; event timestamps always come from the store's clock
}

export const USAGE = {
  claim: 'usage: claim <slug> [brief=…] [issue=…] [maxRound=…] [session=t3code:<environmentId>/<threadId>] [epic=<slug> [kind=member|sync|fix]]',
  event: 'usage: event <id> <type> [field=value …]',
  rebuild: 'usage: rebuild <id> | --all',
  show: 'usage: show <id>',
  abandon: 'usage: abandon <id> "<reason>" [--force] [--delete-branch]',
  archive: 'usage: archive <id> | --all [--force]',
  prune: 'usage: prune',
  ...EPIC_USAGE,
  // The installed CLI's top-level usage line; `doctor`, `abandon`, `archive`, and `prune` are documented in docs/contract/v1.md.
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
      const epic = typeof fields.epic === 'string' ? fields.epic : undefined;
      const target = epic === undefined ? await resolveTarget(repo, mergeTarget(config)) : await epicTarget(io.root, repo, epic);
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
      const { jobs, epics } = await rebuildAll(io.root, target === '--all' ? undefined : target);
      io.stdout(`rebuilt ${jobs.length}: ${jobs.join(' ')}`);
      if (epics.length > 0) io.stdout(`rebuilt epics ${epics.length}: ${epics.join(' ')}`);
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
    case 'epic':
      return runEpic(rest, io, config);
    case 'archive': {
      const args = parseArchive(rest);
      if (!archiveEnabled(config)) throw new Error('archiving is disabled: config.json has no "archive": { "enabled": true }; nothing written');
      return args.all ? archiveAll(io, args.force) : archiveOne(io, args.target, args.force);
    }
    case 'prune': {
      // In order: the arguments (none), the archiving-off refusal (before any job dir or ref is read), the sweep.
      if (rest.length > 0) throw new Error(USAGE.prune);
      if (!archiveEnabled(config)) throw new Error('archiving is disabled: config.json has no "archive": { "enabled": true }; nothing removed');
      return pruneAll(io, config.dashboard.settleAfterHours);
    }
    default:
      throw new Error(usage);
  }
}

// A job in epic <e> targets the epic branch, which must exist. The epic's started and terminal
// checks run again under the locks (`claimJob`); this early one names the likelier problem.
async function epicTarget(root: string, repo: string, epic: string): Promise<string> {
  if ((await readEpicLog(root, epic)).length === 0) throw new Error(`epic ${epic} has not started (no epic.started)`);
  const branch = epicBranch(epic);
  if (!(await branchExists(repo, branch))) throw new Error(`epic ${epic}: no branch refs/heads/${branch}`);
  return branch;
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

// Closes a job for good (`abandon.ts`); a cleanup that left something behind exits 1 naming it.
async function abandon(rest: readonly string[], io: Io): Promise<number> {
  const args = parseAbandon(rest);
  const { snap, left } = await abandonJob(io.root, args);
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
// `<id>: already archived (unchanged)` for a no-op. An argument that is an epic slug (never a job
// id) archives that epic, which must be `landed` or `abandoned`: `archived epic <slug> <short sha>`,
// or `epic <slug>: already archived (unchanged)`.
async function archiveOne(io: Io, id: string, force: boolean): Promise<number> {
  if (!isJobId(id) && isEpicSlug(id)) {
    const epic = await readLocalEpic(io.root, id);
    const outcome = await archiveEpic(dirname(resolve(io.root)), epic, force);
    io.stdout(outcome.kind === 'archived' ? `archived epic ${id} ${outcome.commit.slice(0, 7)}` : `epic ${id}: already archived (unchanged)`);
    return 0;
  }
  const job = await readLocalJob(io.root, id);
  const outcome = await archiveJob(dirname(resolve(io.root)), job, force);
  io.stdout(outcome.kind === 'archived' ? `archived ${id} ${outcome.commit.slice(0, 7)}` : `${id}: already archived (unchanged)`);
  return 0;
}

// Archives every terminal local job in id order, then every terminal local epic in slug order,
// one commit each; unchanged ones are no-ops and live ones are skipped (counted with the jobs). A
// per-job or per-epic failure is one stderr line, and the rest still run.
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
  // Then every local epic, in slug order: landed and abandoned ones are archived, the rest skipped.
  for (const slug of await epicSlugs(io.root)) {
    try {
      const epic = await readLocalEpic(io.root, slug);
      if (!isEpicTerminal(epic)) {
        skipped++;
        continue;
      }
      const outcome = await archiveEpic(repo, epic, force);
      if (outcome.kind === 'unchanged') unchanged++;
      else {
        archived++;
        io.stdout(`archived epic ${slug} ${outcome.commit.slice(0, 7)}`);
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
