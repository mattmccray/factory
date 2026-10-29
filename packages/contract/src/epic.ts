// Epics in factory/v1 (docs/contract/v1.md "Epics"): the plan file's format and its one parser,
// the epic's own events and the transitions the CLI enforces on them, the `epic.json` projection
// over the epic's log, its plan, and its jobs, the `epic next` rules, and the epic-aware settle
// rule. Pure: no file or clock reads (the store, `epicstore.ts`, does the IO).
import { SLUG_MAX, SLUG_PATTERN, checkEpicSlug, epicBranch, isSession, isTargetBranch, noExtraKeys, parseSession, str } from './contract';
import type { JobKind, Session } from './contract';

// ---- the plan file: factory/epics/<slug>.md ----

export type PlanStatus = 'draft' | 'ready' | 'done' | 'abandoned';
export const PLAN_STATUSES: readonly PlanStatus[] = ['draft', 'ready', 'done', 'abandoned'];

/** One `## Members` item: a member brief's slug, the members it waits on, and its own review budget. */
export interface PlanMember {
  slug: string;
  after: string[];
  maxRound: number | null;
}

/**
 * A parsed plan. `status` is null when the plan has no `- Status:` line or an unknown status (the
 * reason is in `statusError`). `errors` are the parse errors of the `## Members` list (malformed
 * or duplicate items, no list at all), in line order; `members` holds the items that parsed.
 */
export interface Plan {
  status: PlanStatus | null;
  statusError: string | null;
  members: PlanMember[];
  errors: string[];
}

const isSlug = (s: string): boolean => s.length <= SLUG_MAX && SLUG_PATTERN.test(s);
const ITEM = /^- `([^`]*)`(.*)$/;
const AFTER = /\bafter:/g;
const AFTER_LIST = /\bafter:\s*(`[^`]*`(?:\s*,\s*`[^`]*`)*)/;
const MAX_ROUND = /\bmaxRound:/g;
const MAX_ROUND_VALUE = /\bmaxRound:\s*([1-9]\d*)(?!\w|\.\d)/;
const STATUS = /^- Status:(.*)$/;

/**
 * The status on a brief's or plan's `- Status:` line: the first such line before the first `## `
 * heading, trimmed; null when there is none.
 */
export function statusLine(text: string): string | null {
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) return null;
    const m = STATUS.exec(line.trimEnd());
    if (m) return (m[1] ?? '').trim();
  }
  return null;
}

/**
 * Parses a plan file's text. Its `## Members` section runs to the next `#`/`##` heading; each list
 * item at column 0 starts with the member's brief slug in backticks and may carry
 * `` after: `<slug>`[, `<slug>`] `` and `maxRound: <n>`. Indented lines continue the item above;
 * other lines are prose. Any other list item, a bad slug, a malformed `after:` or `maxRound:`,
 * and a duplicate member are errors.
 */
export function parsePlan(text: string): Plan {
  const plan: Plan = { status: null, statusError: null, members: [], errors: [] };
  const status = statusLine(text);
  if (status === null) plan.statusError = 'has no "- Status:" line';
  else {
    const hit = PLAN_STATUSES.find((s) => s === status);
    if (hit === undefined) plan.statusError = `has an unknown status (want ${PLAN_STATUSES.join('|')})`;
    else plan.status = hit;
  }

  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === '## Members');
  if (start < 0) {
    plan.errors.push('has no "## Members" section');
    return plan;
  }
  // Items as [line number, text], continuation lines joined to their item.
  const items: { n: number; text: string }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^#{1,2} /.test(line)) break;
    if (line.startsWith('- ') || line === '-' || line.startsWith('* ') || line.startsWith('+ ') || /^\d+[.)] /.test(line)) items.push({ n: i + 1, text: line });
    else if (/^\s/.test(line) && line.trim() !== '' && items.length > 0) {
      const last = items[items.length - 1];
      if (last) last.text += ` ${line.trim()}`;
    }
  }
  const seen = new Set<string>();
  for (const { n, text: item } of items) {
    const where = `## Members line ${n}`;
    const m = ITEM.exec(item);
    if (!m) {
      plan.errors.push(`${where} is malformed (want "- \`<brief slug>\`" first)`);
      continue;
    }
    const slug = m[1] ?? '';
    const rest = m[2] ?? '';
    if (!isSlug(slug)) {
      plan.errors.push(`${where}: member slug must match ${SLUG_PATTERN.source} (at most ${SLUG_MAX} characters)`);
      continue;
    }
    if (seen.has(slug)) {
      plan.errors.push(`${where}: member ${slug} is listed twice`);
      continue;
    }
    let after: string[] = [];
    const afters = rest.match(AFTER)?.length ?? 0;
    if (afters > 1) {
      plan.errors.push(`${where}: member ${slug} has more than one after:`);
      continue;
    }
    if (afters === 1) {
      const a = AFTER_LIST.exec(rest);
      if (!a) {
        plan.errors.push(`${where}: member ${slug} has a malformed after: (want after: \`<slug>\`[, \`<slug>\`])`);
        continue;
      }
      after = [...(a[1] ?? '').matchAll(/`([^`]*)`/g)].map((x) => x[1] ?? '');
      const bad = after.find((s) => !isSlug(s));
      if (bad !== undefined) {
        plan.errors.push(`${where}: member ${slug} has an after: entry that is not a slug`);
        continue;
      }
      if (new Set(after).size !== after.length) {
        plan.errors.push(`${where}: member ${slug} lists an after: member twice`);
        continue;
      }
    }
    let maxRound: number | null = null;
    const rounds = rest.match(MAX_ROUND)?.length ?? 0;
    if (rounds > 1) {
      plan.errors.push(`${where}: member ${slug} has more than one maxRound:`);
      continue;
    }
    if (rounds === 1) {
      const r = MAX_ROUND_VALUE.exec(rest);
      const value = r ? Number(r[1]) : Number.NaN;
      if (!Number.isSafeInteger(value) || value < 1) {
        plan.errors.push(`${where}: member ${slug} has a malformed maxRound: (want a positive integer)`);
        continue;
      }
      maxRound = value;
    }
    seen.add(slug);
    plan.members.push({ slug, after, maxRound });
  }
  if (items.length === 0) plan.errors.push('"## Members" lists no members');
  return plan;
}

/** The first problem with a plan's `after:` edges: one naming a non-member, or a cycle. Null when none. */
export function planGraphError(members: readonly PlanMember[]): string | null {
  const names = new Set(members.map((m) => m.slug));
  for (const m of members) {
    const missing = m.after.find((a) => !names.has(a));
    if (missing !== undefined) return `member ${m.slug} is after ${missing}, which is not a member`;
  }
  const bySlug = new Map(members.map((m) => [m.slug, m]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (slug: string): string[] | null => {
    if (state.get(slug) === 'done') return null;
    if (state.get(slug) === 'visiting') return [...stack.slice(stack.indexOf(slug)), slug];
    state.set(slug, 'visiting');
    stack.push(slug);
    for (const a of bySlug.get(slug)?.after ?? []) {
      const cycle = visit(a);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(slug, 'done');
    return null;
  };
  for (const m of members) {
    const cycle = visit(m.slug);
    if (cycle) return `the after: edges form a cycle: ${cycle.join(' -> ')}`;
  }
  return null;
}

/** A plan's repo-relative path. */
export const planPath = (slug: string): string => `factory/epics/${slug}.md`;
/** A member brief's repo-relative path. */
export const briefPath = (member: string): string => `factory/briefs/${member}.md`;

/**
 * The one-line reason `epic start` refuses a plan on plan grounds, or null when it would start.
 * `text` is the plan's text (null: no plan file); `readBrief` returns a member brief's text, or
 * null when it is missing. The same reason is `doctor`'s FAIL for a `ready` plan. In order: a
 * missing plan, its status, its `## Members` parse errors, its `after:` edges, its member briefs.
 */
export async function planStartProblem(slug: string, text: string | null, readBrief: (member: string) => Promise<string | null>): Promise<string | null> {
  const what = `plan ${planPath(slug)}`;
  if (text === null) return `${what} is missing`;
  const plan = parsePlan(text);
  if (plan.statusError !== null) return `${what} ${plan.statusError}`;
  if (plan.status !== 'ready') return `${what} is ${plan.status ?? 'unknown'}, not ready`;
  const [parse] = plan.errors;
  if (parse !== undefined) return `${what} ${parse}`;
  const graph = planGraphError(plan.members);
  if (graph !== null) return `${what}: ${graph}`;
  for (const m of plan.members) {
    const brief = await readBrief(m.slug);
    if (brief === null) return `${what}: member brief ${briefPath(m.slug)} is missing`;
    const status = statusLine(brief);
    if (status !== 'ready') return `${what}: member brief ${briefPath(m.slug)} is ${status === null ? 'without a "- Status:" line' : JSON.stringify(status)}, not ready`;
  }
  return null;
}

// ---- events ----

export type EpicEventInput =
  | { type: 'epic.started'; schema: 'factory/v1'; slug: string; target: string; session?: Session }
  | { type: 'epic.waiting'; reason: string }
  | { type: 'epic.resumed'; session?: Session }
  | { type: 'epic.landing' }
  | { type: 'epic.landed'; sha: string }
  | { type: 'epic.abandoned'; reason: string };

export type EpicEvent = EpicEventInput & { ts: string };
export type EpicEventType = EpicEventInput['type'];
export const EPIC_EVENT_TYPES: readonly EpicEventType[] = ['epic.started', 'epic.waiting', 'epic.resumed', 'epic.landing', 'epic.landed', 'epic.abandoned'];

/**
 * Parses an epic event's caller fields. `epic.started` needs `ctx` (the slug and the target the
 * CLI resolved); its `schema`, `slug`, and `target` are never caller fields. `session` is accepted
 * on `epic.started` and `epic.resumed` only; any other or unknown field is an error.
 */
export function parseEpicEventInput(type: string, fields: Record<string, unknown>, ctx?: { slug: string; target: string }): EpicEventInput {
  const allow = (...keys: string[]) => noExtraKeys(fields, keys, `${type}: extra field`);
  switch (type) {
    case 'epic.started': {
      allow('session');
      if (!ctx) throw new Error('epic.started: needs the slug and target from the CLI');
      checkEpicSlug(ctx.slug);
      if (!isTargetBranch(ctx.target)) throw new Error(`epic.started: target ${JSON.stringify(ctx.target)} is not an allowed branch name`);
      const started: Extract<EpicEventInput, { type: 'epic.started' }> = { type, schema: 'factory/v1', slug: ctx.slug, target: ctx.target };
      if (fields.session !== undefined) started.session = parseSession(fields.session);
      return started;
    }
    case 'epic.waiting':
      allow('reason');
      return { type, reason: str(fields, 'reason') };
    case 'epic.resumed': {
      allow('session');
      const resumed: Extract<EpicEventInput, { type: 'epic.resumed' }> = { type };
      if (fields.session !== undefined) resumed.session = parseSession(fields.session);
      return resumed;
    }
    case 'epic.landing':
      allow();
      return { type };
    case 'epic.landed':
      allow('sha');
      return { type, sha: str(fields, 'sha') };
    case 'epic.abandoned':
      allow('reason');
      return { type, reason: str(fields, 'reason') };
    default:
      throw new Error(`unknown epic event type '${type}' (want ${EPIC_EVENT_TYPES.join('|')})`);
  }
}

/** True when `v` is a stored epic event (the epic log is written only by the CLI, so the type and ts are checked). */
export function isEpicEvent(v: unknown): v is EpicEvent {
  return typeof v === 'object' && v !== null && 'ts' in v && typeof v.ts === 'string' && 'type' in v && typeof v.type === 'string';
}

// ---- transitions ----

/** The state an epic's log records. `waiting` here is only a logged `epic.waiting`. */
export type LoggedEpicState = 'running' | 'waiting' | 'landing' | 'landed' | 'abandoned';

interface Logged {
  state: LoggedEpicState | null; // null: no log yet
  resumeTo: 'running' | 'landing'; // where epic.resumed returns from a logged waiting
}

function logged(prior: readonly EpicEvent[]): Logged {
  const s: Logged = { state: null, resumeTo: 'running' };
  for (const e of prior) {
    switch (e.type) {
      case 'epic.started': s.state = 'running'; break;
      case 'epic.waiting':
        if (s.state === 'running' || s.state === 'landing') s.resumeTo = s.state;
        s.state = 'waiting';
        break;
      case 'epic.resumed': if (s.state === 'waiting') s.state = s.resumeTo; break;
      case 'epic.landing': s.state = 'landing'; break;
      case 'epic.landed': s.state = 'landed'; break;
      case 'epic.abandoned': s.state = 'abandoned'; break;
      default: break;
    }
  }
  return s;
}

/** The epic's logged state (null: no log). */
export const loggedEpicState = (prior: readonly EpicEvent[]): LoggedEpicState | null => logged(prior).state;

/**
 * Throws a one-line reason unless `next` may follow `prior`. `landBlock` is why `epic.landing`
 * can't be logged now (a member not merged, a live sync or fix job), or null when it can; only
 * `epic.landing` reads it.
 */
export function checkEpicTransition(prior: readonly EpicEvent[], next: EpicEventInput, landBlock: string | null = null): void {
  const { state } = logged(prior);
  if (state === null) {
    if (next.type !== 'epic.started') throw new Error(`no epic log yet: only epic.started (epic start) is allowed, got ${next.type}`);
    return;
  }
  if (state === 'landed' || state === 'abandoned') throw new Error(`epic is ${state} (terminal): ${next.type} not allowed`);
  const bad = (): never => {
    throw new Error(`${next.type} not allowed from epic state '${state}'`);
  };
  switch (next.type) {
    case 'epic.started':
      throw new Error('epic has already started: one run per plan');
    case 'epic.waiting':
      return state === 'running' || state === 'landing' ? undefined : bad();
    case 'epic.resumed':
      return state === 'running' || state === 'waiting' ? undefined : bad();
    case 'epic.landing':
      if (state !== 'running') return bad();
      if (landBlock !== null) throw new Error(`epic.landing refused: ${landBlock}`);
      return;
    case 'epic.landed':
      return state === 'landing' ? undefined : bad();
    case 'epic.abandoned':
      return;
  }
}

// ---- the projection: epic.json ----

/** An epic job, as `epic.json` reads it from the job's `job.json`. */
export interface EpicJob {
  id: string;
  stage: string;
  kind: JobKind;
  brief: string | null;
  updated: string | null;
}

export type MemberState = 'queued' | 'blocked' | 'running' | 'merged' | 'needs-human' | 'abandoned';
export const MEMBER_STATES: readonly MemberState[] = ['queued', 'blocked', 'running', 'merged', 'needs-human', 'abandoned'];
export type EpicState = 'running' | 'waiting' | 'landing' | 'landed' | 'abandoned';

export interface EpicMember {
  slug: string;
  after: string[];
  state: MemberState;
  job: string | null; // its newest job, if it has one
  stage: string | null; // that job's stage
  blockedOn: { member: string; job: string | null }[]; // the unmerged `after:` members (blocked only)
}

export interface EpicSnapshot {
  schema: 'factory/v1';
  slug: string;
  branch: string;
  target: string;
  plan: string; // the plan's repo-relative path
  planError: string | null; // why the plan couldn't be read or parsed in full, if so
  state: EpicState;
  waitingOn: 'you' | 'members' | null;
  note: string;
  session: Session | null;
  sha: string | null; // the epic.landed sha
  members: EpicMember[];
  generated: { id: string; kind: JobKind; stage: string }[];
  counts: Record<MemberState, number>;
  startedAt: string;
  endedAt: string | null;
  updated: string;
}

const WORKING = ['claimed', 'spec', 'build', 'review', 'approve'];
const isWorking = (stage: string): boolean => WORKING.includes(stage);
const isLiveStage = (stage: string): boolean => stage !== 'merged' && stage !== 'abandoned';

/** What the epic's log, plan, and jobs say, for the projection, `epic next`, and the claim checks. */
export interface EpicView {
  logged: LoggedEpicState | null;
  members: EpicMember[];
  generated: EpicJob[];
  claimable: string[]; // queued members, in plan order, when no sync job is live (cap not applied)
  workingMembers: number; // member jobs in a working stage (needs-human holds no slot)
  liveSync: EpicJob | null;
  landBlock: string | null; // why landing can't start now, or null
}

const memberJobs = (jobs: readonly EpicJob[], member: string): EpicJob[] =>
  jobs.filter((j) => j.kind === 'member' && j.brief === briefPath(member)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Builds the epic view from the log, the plan's members (as the plan reads now), and the epic's jobs. */
export function viewEpic(log: readonly EpicEvent[], members: readonly PlanMember[], jobs: readonly EpicJob[]): EpicView {
  const newest = new Map<string, EpicJob>();
  for (const m of members) {
    const mine = memberJobs(jobs, m.slug);
    const last = mine[mine.length - 1];
    if (last) newest.set(m.slug, last);
  }
  const merged = (slug: string): boolean => newest.get(slug)?.stage === 'merged';
  const out: EpicMember[] = members.map((m) => {
    const job = newest.get(m.slug);
    const base = { slug: m.slug, after: [...m.after], job: job?.id ?? null, stage: job?.stage ?? null, blockedOn: [] };
    if (job) {
      const state: MemberState = job.stage === 'merged' ? 'merged' : job.stage === 'abandoned' ? 'abandoned' : job.stage === 'needs-human' ? 'needs-human' : 'running';
      return { ...base, state };
    }
    const blockedOn = m.after.filter((a) => !merged(a)).map((a) => ({ member: a, job: newest.get(a)?.id ?? null }));
    return { ...base, state: blockedOn.length > 0 ? 'blocked' : 'queued', blockedOn };
  });
  const generated = jobs.filter((j) => j.kind !== 'member').sort((a, b) => (a.id < b.id ? -1 : 1));
  const liveSync = generated.find((j) => j.kind === 'sync' && isLiveStage(j.stage)) ?? null;
  const liveGenerated = generated.filter((j) => isLiveStage(j.stage));
  const claimable = liveSync === null ? out.filter((m) => m.state === 'queued').map((m) => m.slug) : [];
  const workingMembers = jobs.filter((j) => j.kind === 'member' && isWorking(j.stage)).length;
  let landBlock: string | null = null;
  const unmerged = out.filter((m) => m.state !== 'merged');
  if (out.length === 0) landBlock = 'the plan lists no members';
  else if (unmerged.length > 0) landBlock = `not every member has merged (${unmerged.map((m) => `${m.slug}: ${m.state}`).join(', ')})`;
  else if (liveGenerated.length > 0) landBlock = `${liveGenerated.map((j) => `${j.kind} job ${j.id}`).join(', ')} ${liveGenerated.length === 1 ? 'is' : 'are'} live`;
  return { logged: loggedEpicState(log), members: out, generated, claimable, workingMembers, liveSync, landBlock };
}

/**
 * Projects `epic.json`. `planError` is why the plan couldn't be read or parsed in full (its
 * parsed members still count). The state is the logged one, except that a running or landing
 * epic is `waiting` on its members when nothing can run (no claimable member, not landable), no
 * epic job is in a working stage, and some epic job is in `needs-human`.
 */
export function projectEpic(log: readonly EpicEvent[], members: readonly PlanMember[], jobs: readonly EpicJob[], planError: string | null = null): EpicSnapshot {
  const first = log[0];
  if (!first || first.type !== 'epic.started') throw new Error('epic log must start with epic.started');
  const view = viewEpic(log, members, jobs);
  const snap: EpicSnapshot = {
    schema: 'factory/v1',
    slug: first.slug,
    branch: epicBranch(first.slug),
    target: first.target,
    plan: planPath(first.slug),
    planError,
    state: 'running',
    waitingOn: null,
    note: '',
    session: isSession(first.session) ? { app: first.session.app, environment: first.session.environment, thread: first.session.thread } : null,
    sha: null,
    members: view.members,
    generated: view.generated.map((j) => ({ id: j.id, kind: j.kind, stage: j.stage })),
    counts: { queued: 0, blocked: 0, running: 0, merged: 0, 'needs-human': 0, abandoned: 0 },
    startedAt: first.ts,
    endedAt: null,
    updated: first.ts,
  };
  for (const e of log.slice(1)) {
    snap.updated = e.ts;
    switch (e.type) {
      case 'epic.waiting': snap.note = e.reason; break;
      case 'epic.resumed':
        snap.note = '';
        if (isSession(e.session)) snap.session = { app: e.session.app, environment: e.session.environment, thread: e.session.thread };
        break;
      case 'epic.landed': snap.sha = e.sha; snap.note = `landed ${e.sha}`; snap.endedAt = e.ts; break;
      case 'epic.abandoned': snap.note = e.reason; snap.endedAt = e.ts; break;
      default: break;
    }
  }
  for (const j of jobs) if (j.updated !== null && j.updated > snap.updated) snap.updated = j.updated;
  for (const m of view.members) snap.counts[m.state] += 1;
  const state = view.logged ?? 'running';
  snap.state = state;
  if (state === 'waiting') snap.waitingOn = 'you';
  else if ((state === 'running' || state === 'landing') && membersWait(view, jobs)) {
    snap.state = 'waiting';
    snap.waitingOn = 'members';
  }
  return snap;
}

function membersWait(view: EpicView, jobs: readonly EpicJob[]): boolean {
  if (jobs.some((j) => isWorking(j.stage))) return false;
  if (!jobs.some((j) => j.stage === 'needs-human')) return false;
  return view.claimable.length === 0 && view.landBlock !== null;
}

/**
 * `epic next`: one action per line. While the logged state is `running`: `claim <member>` for each
 * queued member (no job, every `after:` member merged), in plan order, as long as the working
 * members stay under `maxParallel` and no sync job is live; or `land` when every member has merged
 * and no sync or fix job is live. Nothing otherwise.
 */
export function epicNext(view: EpicView, maxParallel: number): string[] {
  if (view.logged !== 'running') return [];
  if (view.landBlock === null) return ['land'];
  const room = Math.max(0, maxParallel - view.workingMembers);
  return view.claimable.slice(0, room).map((m) => `claim ${m}`);
}

/**
 * Why a member claim for `member` is refused now, or null when it may be claimed. The epic's
 * logged state is checked by the caller.
 */
export function memberClaimRefusal(view: EpicView, member: string, maxParallel: number): string | null {
  const m = view.members.find((x) => x.slug === member);
  if (m === undefined) return `${briefPath(member)} is not listed in the plan's ## Members`;
  if (m.job !== null && m.state !== 'abandoned') return `member ${member} already has job ${m.job} (${m.stage ?? 'unknown'})`;
  const waits = m.after.filter((a) => view.members.find((x) => x.slug === a)?.state !== 'merged');
  if (waits.length > 0) {
    const named = waits.map((a) => {
      const job = view.members.find((x) => x.slug === a)?.job ?? null;
      return job === null ? a : `${a} (${job})`;
    });
    return `member ${member} waits on ${named.join(', ')}, not yet merged`;
  }
  if (view.liveSync !== null) return `sync job ${view.liveSync.id} is live: no member is claimed until it is merged or abandoned`;
  if (view.workingMembers >= maxParallel) return `${view.workingMembers} members are working, at epic.maxParallel ${maxParallel}`;
  return null;
}

// ---- the epic-aware settle rule ----

/** A job or an epic, as the settle rule reads it. */
export interface SettleJob {
  stage: string | null;
  endedAt: string | null;
  epic?: string | null; // the job's epic, if it has one
}

/** An epic's terminal facts, as the settle rule reads them. */
export interface SettleEpic {
  state: string | null; // its logged state; `landed` and `abandoned` are terminal
  endedAt: string | null;
}

const HOUR_MS = 3_600_000;
const time = (now: Date | number): number => (typeof now === 'number' ? now : now.getTime());

function endedBefore(endedAt: string | null, hours: number, now: Date | number): boolean {
  if (endedAt === null) return false;
  const ended = Date.parse(endedAt);
  return !Number.isNaN(ended) && time(now) - ended > hours * HOUR_MS;
}

/** An epic settles like a job: `abandoned` at once, `landed` once its `endedAt` is more than `hours` old. */
export function isEpicSettled(epic: SettleEpic, hours: number, now: Date | number): boolean {
  if (epic.state === 'abandoned') return true;
  return epic.state === 'landed' && endedBefore(epic.endedAt, hours, now);
}

/**
 * The epic-aware settle rule. An `abandoned` job is settled at once, with or without an epic,
 * whatever its epic's state. A `merged` job with no epic settles once its `endedAt` is more than
 * `hours` old (the contract's settle rule). A `merged` job with an epic is never settled while the
 * epic isn't terminal (`epic` is its epic's facts; null or absent: unknown, so not terminal); once
 * it is, the job settles when the epic does (by the epic's `endedAt`). Every other stage is
 * unsettled.
 */
export function isSettled(job: SettleJob, hours: number, now: Date | number, epic?: SettleEpic | null): boolean {
  if (job.stage === 'abandoned') return true;
  if (job.stage !== 'merged') return false;
  if (job.epic === undefined || job.epic === null) return endedBefore(job.endedAt, hours, now);
  if (epic === undefined || epic === null || (epic.state !== 'landed' && epic.state !== 'abandoned')) return false;
  return isEpicSettled(epic, hours, now);
}
