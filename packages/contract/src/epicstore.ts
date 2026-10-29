// The epic store (docs/contract/v1.md "Epics"): the only writer of an epic's `events.jsonl` and
// its derived `epic.json` under `jobs/epics/<slug>/`, behind the epic's own `.events.lock`. It
// reads the plan (`epics/<slug>.md`), the member briefs (`briefs/<m>.md`), and every job's
// `job.json` that names the epic. `root` is the factory/ directory, as for the job store.
import { appendFile, lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { JOB_KINDS, SLUG_MAX, SLUG_PATTERN, checkEpicSlug, isEpicSlug, isJobId } from './contract';
import type { EventInput } from './contract';
import { briefPath, checkEpicTransition, isEpicEvent, loggedEpicState, memberClaimRefusal, parsePlan, planPath, planStartProblem, projectEpic, viewEpic } from './epic';
import type { EpicEvent, EpicEventInput, EpicJob, EpicSnapshot, EpicView, PlanMember } from './epic';
import { acquire, exists, isExists, isNotFound, release } from './lock';

/** The epic's runtime dir, `jobs/epics/<slug>/`; the slug is checked before the path is built. */
export function epicDir(root: string, slug: string): string {
  checkEpicSlug(slug);
  return join(root, 'jobs', 'epics', slug);
}
const epicLogPath = (root: string, slug: string): string => join(epicDir(root, slug), 'events.jsonl');

/** Parses an epic `events.jsonl` text into its events; a line that isn't an event throws, naming it. */
export function parseEpicLog(text: string): EpicEvent[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((line, i) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`epic events.jsonl line ${i + 1} is not valid JSON`);
    }
    if (!isEpicEvent(raw)) throw new Error(`epic events.jsonl line ${i + 1} is not an epic event`);
    return raw;
  });
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** The epic's events; none when it has no log. */
export async function readEpicLog(root: string, slug: string): Promise<EpicEvent[]> {
  const text = await readText(epicLogPath(root, slug));
  return text === null ? [] : parseEpicLog(text);
}

// The log's raw text, refusing a torn last line, as the job store does for appends.
async function readForAppend(root: string, slug: string): Promise<EpicEvent[]> {
  const raw = (await readText(epicLogPath(root, slug))) ?? '';
  if (raw !== '' && !raw.endsWith('\n')) throw new Error(`epic ${slug}: events.jsonl does not end with a newline (corrupt tail); refusing to append`);
  return parseEpicLog(raw);
}

// A tracked file's text, or null when it is missing. Only a regular file is read: a symlink (which
// could point outside the repo) or anything else is refused in one line naming `rel`.
async function readRegular(path: string, rel: string): Promise<string | null> {
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
  if (!st.isFile()) throw new Error(`${rel} is not a regular file (a symlink is never followed)`);
  return readFile(path, 'utf8');
}

/** The plan's text, `epics/<slug>.md` under `root`, or null when it is missing. Never follows a symlink. */
export function readPlan(root: string, slug: string): Promise<string | null> {
  checkEpicSlug(slug);
  return readRegular(join(root, 'epics', `${slug}.md`), planPath(slug));
}

// A member brief's text, or null when missing. The member slug was checked by the plan parser.
function readBrief(root: string, member: string): Promise<string | null> {
  if (member.length > SLUG_MAX || !SLUG_PATTERN.test(member)) return Promise.resolve(null);
  return readRegular(join(root, 'briefs', `${member}.md`), briefPath(member));
}

/** The one-line reason `epic start` refuses `slug`'s plan on plan grounds, or null (see `planStartProblem`). */
export async function epicPlanProblem(root: string, slug: string): Promise<string | null> {
  return planStartProblem(slug, await readPlan(root, slug), (m) => readBrief(root, m));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Every job whose `job.json` names `slug` as its epic, in id order. Readers are tolerant: a job
 * dir with no readable `job.json`, or one without a string `stage`, is skipped.
 */
export async function readEpicJobs(root: string, slug: string): Promise<EpicJob[]> {
  let names: string[];
  try {
    names = (await readdir(join(root, 'jobs'), { withFileTypes: true })).filter((d) => d.isDirectory() && isJobId(d.name)).map((d) => d.name).sort();
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  const out: EpicJob[] = [];
  for (const id of names) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(root, 'jobs', id, 'job.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!isRecord(raw) || raw.epic !== slug || typeof raw.stage !== 'string') continue;
    const kind = JOB_KINDS.find((k) => k === raw.kind) ?? 'member';
    out.push({
      id,
      stage: raw.stage,
      kind,
      brief: typeof raw.brief === 'string' ? raw.brief : null,
      updated: typeof raw.updated === 'string' ? raw.updated : null,
    });
  }
  return out;
}

/** Everything the epic's projection reads: its log, the plan's members as it reads now, and its jobs. */
export interface EpicInputs {
  log: EpicEvent[];
  members: PlanMember[];
  planError: string | null;
  jobs: EpicJob[];
  view: EpicView;
}

/** Reads the epic's inputs. The log is read whole; a missing or partly malformed plan is a `planError`, not a failure. */
export async function loadEpic(root: string, slug: string, log?: EpicEvent[]): Promise<EpicInputs> {
  const events = log ?? (await readEpicLog(root, slug));
  const text = await readPlan(root, slug);
  let members: PlanMember[] = [];
  let planError: string | null = null;
  if (text === null) planError = `plan ${planPath(slug)} is missing`;
  else {
    const plan = parsePlan(text);
    members = plan.members;
    const [first] = plan.errors;
    if (first !== undefined) planError = `plan ${planPath(slug)} ${first}`;
  }
  const jobs = await readEpicJobs(root, slug);
  return { log: events, members, planError, jobs, view: viewEpic(events, members, jobs) };
}

async function writeEpicSnapshot(root: string, slug: string, snap: EpicSnapshot): Promise<void> {
  const file = join(epicDir(root, slug), 'epic.json');
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(snap, null, 2)}\n`);
  await rename(tmp, file);
}

const project = (i: EpicInputs): EpicSnapshot => projectEpic(i.log, i.members, i.jobs, i.planError);

/**
 * Runs `fn` holding the epic's `jobs/epics/<slug>/.events.lock` (an `mkdir`; stale after 30 s).
 * A missing epic dir is `epic <slug> has not started`.
 */
export async function withEpicLock<T>(root: string, slug: string, fn: () => Promise<T>): Promise<T> {
  const dir = epicDir(root, slug);
  if (!(await exists(dir))) throw new Error(`epic ${slug} has not started (no jobs/epics/${slug}/)`);
  const lock = join(dir, '.events.lock');
  await acquire(lock);
  try {
    return await fn();
  } finally {
    await release(lock);
  }
}

/**
 * Starts an epic: reserves `jobs/epics/<slug>/` with an exclusive `mkdir` (a second start, or a
 * concurrent one, is refused here, before anything else runs), takes the epic's lock, runs
 * `setup` (the CLI's git work; it returns how to undo it), logs `epic.started` (its first event)
 * with the system clock's timestamp, and writes `epic.json`. On any failure after the
 * reservation, the undo runs (if setup returned one; a failing undo adds its reason to the error)
 * and the dirs this call created are removed, so a refused start leaves nothing.
 */
export async function startEpic(
  root: string,
  slug: string,
  input: EpicEventInput,
  now: () => Date = () => new Date(),
  setup: () => Promise<() => Promise<void>> = async () => async () => undefined,
): Promise<EpicSnapshot> {
  const dir = epicDir(root, slug);
  if (input.type !== 'epic.started' || input.slug !== slug) throw new Error(`epic ${slug}: start needs epic.started for ${slug}`);
  const parent = join(root, 'jobs', 'epics');
  const madeParent = await mkdir(parent, { recursive: true });
  try {
    await mkdir(dir);
  } catch (e) {
    if (madeParent !== undefined) await removeEmpty(parent, madeParent);
    if (isExists(e)) throw new Error(`epic ${slug} has already started: one run per plan`);
    throw e;
  }
  const lock = join(dir, '.events.lock');
  await acquire(lock);
  let ok = false;
  let undo: (() => Promise<void>) | null = null;
  try {
    const prior = await readForAppend(root, slug);
    checkEpicTransition(prior, input);
    undo = await setup();
    const event: EpicEvent = { ts: now().toISOString(), ...input };
    await appendFile(epicLogPath(root, slug), `${JSON.stringify(event)}\n`);
    const snap = project(await loadEpic(root, slug));
    await writeEpicSnapshot(root, slug, snap);
    ok = true;
    return snap;
  } catch (e) {
    // The undo's own failure (git state left behind) is added to the reason, never hidden.
    const reason = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';
    const left = undo === null ? null : await undo().then(() => null, (u: unknown) => (u instanceof Error ? u.message : String(u)));
    throw left === null ? e : new Error(`${reason}; ${left}`);
  } finally {
    await release(lock);
    if (!ok) {
      await rm(dir, { recursive: true, force: true });
      if (madeParent !== undefined) await removeEmpty(parent, madeParent);
    }
  }
}

// Removes `dir` and its parents up to `made` (the first dir a recursive mkdir created), innermost
// first, stopping at the first one that isn't empty.
async function removeEmpty(dir: string, made: string): Promise<void> {
  for (let d = dir; d.length >= made.length; d = dirname(d)) {
    if (!(await rmdir(d).then(() => true, () => false))) return;
  }
}

/** Options for `appendEpicEvent`. */
export interface EpicAppendOptions {
  /** Runs after the transition check, under the lock, before the append; throws to refuse. */
  check?: (inputs: EpicInputs) => void;
}

/**
 * Appends one epic event (not `epic.started`, which only `startEpic` logs) under the epic's lock:
 * read, refuse a torn tail, check the transition (`epic.landing` against the plan and jobs as they
 * read now), run `opts.check`, append with the system clock's timestamp, and rewrite `epic.json`.
 */
export async function appendEpicEvent(root: string, slug: string, input: EpicEventInput, now: () => Date = () => new Date(), opts: EpicAppendOptions = {}): Promise<EpicSnapshot> {
  return withEpicLock(root, slug, async () => {
    const prior = await readForAppend(root, slug);
    if (prior.length === 0) throw new Error(`epic ${slug} has not started (no epic.started)`);
    const inputs = await loadEpic(root, slug, prior);
    checkEpicTransition(prior, input, inputs.view.landBlock);
    opts.check?.(inputs);
    const event: EpicEvent = { ts: now().toISOString(), ...input };
    await appendFile(epicLogPath(root, slug), `${JSON.stringify(event)}\n`);
    const snap = project(await loadEpic(root, slug));
    await writeEpicSnapshot(root, slug, snap);
    return snap;
  });
}

// Rewrites epic.json; the caller holds the epic's lock.
async function rebuildLocked(root: string, slug: string): Promise<EpicSnapshot> {
  const inputs = await loadEpic(root, slug);
  if (inputs.log.length === 0) throw new Error(`epic ${slug}: no events.jsonl to rebuild from`);
  const snap = project(inputs);
  await writeEpicSnapshot(root, slug, snap);
  return snap;
}

/** Regenerates the epic's `epic.json` from its log, its plan, and its jobs, under the epic's lock. */
export function rebuildEpic(root: string, slug: string): Promise<EpicSnapshot> {
  return withEpicLock(root, slug, () => rebuildLocked(root, slug));
}

/** The epic dirs under `jobs/epics/` (names that are epic slugs; anything else is ignored), sorted. */
export async function epicSlugs(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, 'jobs', 'epics'), { withFileTypes: true })).filter((d) => d.isDirectory() && isEpicSlug(d.name)).map((d) => d.name).sort();
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
}

type Claimed = Extract<EventInput, { type: 'job.claimed' }>;

/**
 * The epic half of `claim … epic=<e>`: under the epic's lock, checks the epic (started, not
 * landed or abandoned, its log not torn) and, for a member, the plan (the brief is a listed
 * member, its `after:` members have merged, it has no job that isn't abandoned, no sync job is
 * live, the working members are under `maxParallel`); fills the plan's `maxRound` when the caller
 * gave none; then runs `append` (which logs `job.claimed`) and rewrites `epic.json`. The caller
 * holds `jobs/.claim.lock`, so two claims can't both pass the cap or both claim one member.
 */
export async function claimIntoEpic<T>(
  root: string,
  claimed: Claimed,
  maxParallel: number,
  maxRoundGiven: boolean,
  append: (claimed: Claimed) => Promise<T>,
): Promise<T> {
  const slug = claimed.epic;
  if (slug === undefined) throw new Error('claimIntoEpic: the claim names no epic');
  return withEpicLock(root, slug, async () => {
    const prior = await readForAppend(root, slug);
    const state = loggedEpicState(prior);
    if (state === null) throw new Error(`epic ${slug} has not started (no epic.started)`);
    if (state === 'landed' || state === 'abandoned') throw new Error(`epic ${slug} is ${state}: no job is claimed into it`);
    const inputs = await loadEpic(root, slug, prior);
    let next = claimed;
    if ((claimed.kind ?? 'member') === 'member') {
      const m = /^factory\/briefs\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.exec(claimed.brief ?? '');
      if (!m) throw new Error(`a member claim needs brief=factory/briefs/<member>.md, got ${JSON.stringify(claimed.brief)}`);
      const member = m[1] ?? '';
      if (inputs.planError !== null && inputs.members.length === 0) throw new Error(inputs.planError);
      const refusal = memberClaimRefusal(inputs.view, member, maxParallel);
      if (refusal !== null) throw new Error(`epic ${slug}: ${refusal}`);
      const planRound = inputs.members.find((x) => x.slug === member)?.maxRound ?? null;
      if (!maxRoundGiven && planRound !== null) next = { ...claimed, maxRound: planRound };
    }
    const out = await append(next);
    // The job exists now: epic.json is a disposable projection, so a failed rewrite never fails
    // the claim (it would leave a job whose id was never printed). `epic show` and `rebuild` regenerate it.
    await rebuildLocked(root, slug).catch(() => undefined);
    return out;
  });
}
