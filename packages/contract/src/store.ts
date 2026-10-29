// The factory's only writer of job state (docs/contract/v1.md): reads/appends events.jsonl and
// rewrites the derived job.json. `root` is the factory/ directory so tests can use a temp dir.
import { appendFile, mkdir, readFile, readdir, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JOB_NUMBER_MAX, checkSlug, checkTransition, epicMaxParallel, parseEventInput } from './contract';
import type { Config, EventInput, FactoryEvent, TransitionOptions, Verdict } from './contract';
import { claimIntoEpic, epicSlugs, rebuildEpic } from './epicstore';
import { acquire, exists, isNotFound, release } from './lock';
import { project } from './project';
import type { JobSnapshot } from './project';

const JOB_ID = /^\d{3}-[a-z0-9-]+$/;

// Every path under jobs/ is built from a validated id, so a bad id can never escape or litter jobs/.
function jobDir(root: string, id: string): string {
  if (!JOB_ID.test(id)) throw new Error(`job id '${id}' must match ^\\d{3}-[a-z0-9-]+$`);
  return join(root, 'jobs', id);
}
const logPath = (root: string, id: string): string => join(jobDir(root, id), 'events.jsonl');


// Parses one log line into an event. The log is written only by this module, so a line that is
// valid JSON object is trusted to be a FactoryEvent (transitions were checked before append).
function parseLine(line: string, n: number): FactoryEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error(`events.jsonl line ${n} is not valid JSON`);
  }
  if (!isEvent(raw)) throw new Error(`events.jsonl line ${n} is not a factory event`);
  return raw;
}

function isEvent(v: unknown): v is FactoryEvent {
  return typeof v === 'object' && v !== null && 'ts' in v && typeof v.ts === 'string' && 'type' in v && typeof v.type === 'string';
}

export async function readLog(root: string, id: string): Promise<FactoryEvent[]> {
  let text: string;
  try {
    text = await readFile(logPath(root, id), 'utf8');
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  return parseLog(text);
}

/**
 * Parses an `events.jsonl` text into its events, exactly as `readLog` does for a file (so a log
 * read from elsewhere, such as the `factory/archive` branch, re-projects the same). An empty text
 * is no events; a line that is not a factory event throws, naming the line.
 */
export function parseLog(text: string): FactoryEvent[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((line, i) => parseLine(line, i + 1));
}

export async function readVerdict(path: string, allowed: readonly string[]): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (isNotFound(e)) throw new Error(`${path}: missing`);
    throw e;
  }
  const first = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  const hit = allowed.find((a) => a === first);
  if (hit === undefined) throw new Error(`${path}: first line must be one of ${allowed.map((a) => `"${a}"`).join(', ')}`);
  return hit.replace(/^VERDICT: /, '');
}

const REVIEW_VERDICTS: readonly Verdict[] = ['PASS', 'CHANGES'];
const DECISION_VERDICTS: readonly Verdict[] = ['APPROVE', 'ESCALATE'];

// For a finishing reviewer/approver, the verdict is read from the agent's file, never supplied.
async function withVerdict(root: string, id: string, input: EventInput): Promise<EventInput> {
  if (input.type !== 'agent.finished') return input;
  if (input.role === 'reviewer') {
    const path = join(jobDir(root, id), `round-${input.round}`, `review-${input.key}.md`);
    const v = await readVerdict(path, REVIEW_VERDICTS.map((x) => `VERDICT: ${x}`));
    const verdict = REVIEW_VERDICTS.find((x) => x === v);
    if (verdict === undefined) throw new Error(`${path}: unreachable verdict '${v}'`);
    return { ...input, verdict };
  }
  if (input.role === 'approver') {
    const path = join(jobDir(root, id), 'decision.md');
    const v = await readVerdict(path, DECISION_VERDICTS);
    const verdict = DECISION_VERDICTS.find((x) => x === v);
    if (verdict === undefined) throw new Error(`${path}: unreachable verdict '${v}'`);
    return { ...input, verdict };
  }
  return input;
}

// Serializes the whole read -> check -> append -> project -> write sequence per job.
// Only a creating caller (job.claimed) may make the job dir; anyone else on a missing dir fails.
async function withLock<T>(dir: string, create: boolean, fn: () => Promise<T>): Promise<T> {
  let created = false;
  if (create) created = (await mkdir(dir, { recursive: true })) !== undefined;
  else if (!(await exists(dir))) throw new Error(`${dir.split('/').pop()}: no such job`);
  const lock = join(dir, '.events.lock');
  await acquire(lock);
  let ok = false;
  try {
    const out = await fn();
    ok = true;
    return out;
  } finally {
    await release(lock);
    if (created && !ok) await rmdir(dir).catch(() => undefined); // a rejected claim leaves nothing behind
  }
}

async function writeSnapshot(root: string, id: string, snap: JobSnapshot): Promise<void> {
  const file = join(jobDir(root, id), 'job.json');
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(snap, null, 2)}\n`);
  await rename(tmp, file);
}

// `opts.force` is passed to the transition check only (it lets `job.abandoned` leave a working
// stage); it is never recorded on the event.
export async function appendEvent(
  root: string,
  id: string,
  input: EventInput,
  now: () => Date = () => new Date(),
  opts: TransitionOptions = {},
): Promise<JobSnapshot> {
  const snap = await appendJobEvent(root, id, input, now, opts);
  if (snap.epic !== null) await refreshEpic(root, snap.epic);
  return snap;
}

// After an event on a job in an epic, the epic's epic.json is rewritten under the epic's own lock
// (taken after the job's lock is released). It is a disposable projection: a failure here (a torn
// epic log, an epic dir that is gone) never fails the job's event; `epic show` and `rebuild`
// regenerate it.
async function refreshEpic(root: string, epic: string): Promise<void> {
  await rebuildEpic(root, epic).catch(() => undefined);
}

function appendJobEvent(root: string, id: string, input: EventInput, now: () => Date, opts: TransitionOptions): Promise<JobSnapshot> {
  return withLock(jobDir(root, id), input.type === 'job.claimed', async () => {
    const prior = await readLog(root, id);
    if (prior.length === 0 && (await exists(join(jobDir(root, id), 'job.json')))) {
      throw new Error(`${id} is a legacy job (no events.jsonl); not modifiable`);
    }
    const raw = prior.length === 0 ? '' : await readFile(logPath(root, id), 'utf8');
    if (raw !== '' && !raw.endsWith('\n')) throw new Error(`${id}: events.jsonl does not end with a newline (corrupt tail); refusing to append`);
    const checked = await withVerdict(root, id, input);
    checkTransition(prior, checked, opts);
    const event: FactoryEvent = { ts: now().toISOString(), ...checked };
    await appendFile(logPath(root, id), `${JSON.stringify(event)}\n`);
    const snap = project(await readLog(root, id));
    await writeSnapshot(root, id, snap);
    return snap;
  });
}

export async function rebuild(root: string, id?: string): Promise<string[]> {
  return (await rebuildAll(root, id)).jobs;
}

/**
 * Regenerates `job.json` for one job (and, when it is in an epic, that epic's `epic.json`), or,
 * with no id, for every job with a log and then every epic under `jobs/epics/`. Returns what it
 * rebuilt.
 */
export async function rebuildAll(root: string, id?: string): Promise<{ jobs: string[]; epics: string[] }> {
  const ids = id !== undefined ? [id] : await listEventedJobs(root);
  const done: string[] = [];
  const named = new Set<string>();
  for (const j of ids) {
    const snap = await withLock(jobDir(root, j), false, async () => {
      const log = await readLog(root, j);
      if (log.length === 0) throw new Error(`${j}: no events.jsonl to rebuild from`);
      const s = project(log);
      await writeSnapshot(root, j, s);
      return s;
    });
    if (snap.epic !== null) named.add(snap.epic);
    done.push(j);
  }
  const epics = id !== undefined ? [...named] : await epicSlugs(root);
  for (const e of epics) await rebuildEpic(root, e);
  return { jobs: done, epics };
}

async function listEventedJobs(root: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = (await readdir(join(root, 'jobs'), { withFileTypes: true })).filter((d) => d.isDirectory() && JOB_ID.test(d.name)).map((d) => d.name);
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  const out: string[] = [];
  for (const name of entries.sort()) {
    try {
      await stat(logPath(root, name));
      out.push(name);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
  return out;
}

/** What `claimJob` records on `job.claimed`: the caller's fields, the config, and the resolved target. */
export interface ClaimInput {
  fields: Record<string, unknown>;
  config: Config;
  target?: string;
}

function claimedInput(id: string, input: ClaimInput): EventInput {
  const ctx: { id: string; config: Config; target?: string } = { id, config: input.config };
  if (input.target !== undefined) ctx.target = input.target;
  return parseEventInput('job.claimed', input.fields, ctx);
}

/**
 * Checks a claim without touching disk: the slug (`checkSlug`) and the `job.claimed` fields
 * (`brief`, `issue`, `maxRound`, `session`, `epic`, `kind` only; `kind` needs `epic`, a member
 * needs `brief`, a sync or fix job takes none). Throws the one-line reason `claimJob` would.
 */
export function checkClaim(slug: string, input: ClaimInput): void {
  checkSlug(slug);
  claimedInput(`000-${slug}`, input);
}

// The job dirs under jobs/ (names matching the job-id pattern; anything else is ignored).
async function jobDirs(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, 'jobs'), { withFileTypes: true })).filter((d) => d.isDirectory() && JOB_ID.test(d.name)).map((d) => d.name).sort();
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
}

// Live: a readable job.json whose stage is neither `merged` nor `abandoned`. No readable job.json is not live.
async function isLive(root: string, id: string): Promise<boolean> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(jobDir(root, id), 'job.json'), 'utf8'));
  } catch {
    return false;
  }
  if (typeof raw !== 'object' || raw === null || !('stage' in raw) || typeof raw.stage !== 'string') return false;
  return raw.stage !== 'merged' && raw.stage !== 'abandoned';
}

/** How `claimJob` learns of job ids used outside `jobs/`. */
export interface ClaimOptions {
  /**
   * The job ids archived on the `factory/archive` branch (its top-level entries; none when the
   * branch is missing). Read under `jobs/.claim.lock`, whatever the config says, so a number on
   * the archive is never handed out again. Absent: only the job dirs count.
   */
  archived?: () => Promise<readonly string[]>;
}

/**
 * Creates a new job for `slug` (docs/contract/v1.md "CLI", `claim`): under `jobs/.claim.lock`
 * (an `mkdir`, stale after 30 s) it scans the job dirs, refuses a slug held by a live job, picks
 * the highest number among the job dirs and the archived ids + 1 (gaps are never filled; refused
 * past 999), and appends `job.claimed`, which creates the dir under its own `.events.lock`. A
 * claim into an epic (`epic` in the fields) also takes the epic's `.events.lock`, nested inside
 * `.claim.lock`, for the epic's checks, the append, and the `epic.json` rewrite
 * (`claimIntoEpic`). A refusal writes nothing.
 */
export async function claimJob(
  root: string,
  slug: string,
  input: ClaimInput,
  now: () => Date = () => new Date(),
  opts: ClaimOptions = {},
): Promise<{ id: string; snapshot: JobSnapshot }> {
  checkClaim(slug, input);
  const jobs = join(root, 'jobs');
  await mkdir(jobs, { recursive: true });
  const lock = join(jobs, '.claim.lock');
  await acquire(lock);
  try {
    const dirs = await jobDirs(root);
    for (const d of dirs) {
      if (d.slice(4) === slug && (await isLive(root, d))) throw new Error(`slug ${slug} is live as ${d}`);
    }
    const archived = opts.archived === undefined ? [] : (await opts.archived()).filter((d) => JOB_ID.test(d));
    const highest = [...dirs, ...archived].reduce((n, d) => Math.max(n, Number(d.slice(0, 3))), 0);
    if (highest >= JOB_NUMBER_MAX) throw new Error(`job number ${JOB_NUMBER_MAX} is taken: no job numbers are left`);
    const id = `${String(highest + 1).padStart(3, '0')}-${slug}`;
    const claimed = claimedInput(id, input);
    if (claimed.type !== 'job.claimed' || claimed.epic === undefined) {
      const snapshot = await appendJobEvent(root, id, claimed, now, {});
      return { id, snapshot };
    }
    // In an epic: its checks and the append run under the epic's lock, nested in .claim.lock.
    const snapshot = await claimIntoEpic(root, claimed, epicMaxParallel(input.config), input.fields.maxRound !== undefined, (c) => appendJobEvent(root, id, c, now, {}));
    return { id, snapshot };
  } finally {
    await release(lock);
  }
}
