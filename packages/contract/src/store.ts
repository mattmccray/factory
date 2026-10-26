// The factory's only writer of job state (docs/contract/v1.md): reads/appends events.jsonl and
// rewrites the derived job.json. `root` is the factory/ directory so tests can use a temp dir.
import { appendFile, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JOB_NUMBER_MAX, checkSlug, checkTransition, parseEventInput } from './contract';
import type { Config, EventInput, FactoryEvent, TransitionOptions, Verdict } from './contract';
import { project } from './project';
import type { JobSnapshot } from './project';

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;

const JOB_ID = /^\d{3}-[a-z0-9-]+$/;

// Every path under jobs/ is built from a validated id, so a bad id can never escape or litter jobs/.
function jobDir(root: string, id: string): string {
  if (!JOB_ID.test(id)) throw new Error(`job id '${id}' must match ^\\d{3}-[a-z0-9-]+$`);
  return join(root, 'jobs', id);
}
const logPath = (root: string, id: string): string => join(jobDir(root, id), 'events.jsonl');

const isNotFound = (e: unknown): boolean => typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT';
const isExists = (e: unknown): boolean => typeof e === 'object' && e !== null && 'code' in e && e.code === 'EEXIST';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

// Takes the `mkdir` lock at `lock`, waiting on a fresh holder and breaking one older than 30 s.
async function acquire(lock: string): Promise<void> {
  for (;;) {
    try {
      await mkdir(lock);
      return;
    } catch (e) {
      if (!isExists(e)) throw e;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) await rm(lock, { recursive: true, force: true });
      } catch (s) {
        if (!isNotFound(s)) throw s;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
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
    await rm(lock, { recursive: true, force: true });
    if (created && !ok) await rmdir(dir).catch(() => undefined); // a rejected claim leaves nothing behind
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
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
  const ids = id !== undefined ? [id] : await listEventedJobs(root);
  const done: string[] = [];
  for (const j of ids) {
    await withLock(jobDir(root, j), false, async () => {
      const log = await readLog(root, j);
      if (log.length === 0) throw new Error(`${j}: no events.jsonl to rebuild from`);
      await writeSnapshot(root, j, project(log));
    });
    done.push(j);
  }
  return done;
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
 * (`brief`, `issue`, `maxRound` only). Throws the one-line reason `claimJob` would.
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

/**
 * Creates a new job for `slug` (docs/contract/v1.md "CLI", `claim`): under `jobs/.claim.lock`
 * (an `mkdir`, stale after 30 s) it scans the job dirs, refuses a slug held by a live job, picks
 * the highest number + 1 (gaps are never filled; refused past 999), and appends `job.claimed`
 * through `appendEvent`, which creates the dir under its own `.events.lock`. A refusal writes nothing.
 */
export async function claimJob(
  root: string,
  slug: string,
  input: ClaimInput,
  now: () => Date = () => new Date(),
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
    const highest = dirs.reduce((n, d) => Math.max(n, Number(d.slice(0, 3))), 0);
    if (highest >= JOB_NUMBER_MAX) throw new Error(`job number ${JOB_NUMBER_MAX} is taken: no job numbers are left`);
    const id = `${String(highest + 1).padStart(3, '0')}-${slug}`;
    const snapshot = await appendEvent(root, id, claimedInput(id, input), now);
    return { id, snapshot };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
