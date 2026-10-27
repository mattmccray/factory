// The factory/v1 state contract (docs/contract/v1.md): event types, config parsing, and the
// transition rules the CLI enforces before it appends. Dependency-free on purpose.

export type Stage = 'claimed' | 'spec' | 'build' | 'review' | 'approve' | 'needs-human' | 'merged' | 'abandoned';
/** The stages a job is worked in: everything but `needs-human` and the terminal `merged` and `abandoned`. */
export type WorkingStage = 'claimed' | 'spec' | 'build' | 'review' | 'approve';
export const WORKING_STAGES: readonly WorkingStage[] = ['claimed', 'spec', 'build', 'review', 'approve'];
/** Narrows a stage to a working stage, or null. */
export const workingStage = (stage: Stage): WorkingStage | null => WORKING_STAGES.find((w) => w === stage) ?? null;
export type Role = 'spec-writer' | 'builder' | 'reviewer' | 'approver';
export type Verdict = 'PASS' | 'CHANGES' | 'APPROVE' | 'ESCALATE';
type EnteredStage = 'spec' | 'build' | 'approve';

interface AgentIdentity {
  role: Role;
  key?: string; // reviewer key
  round?: number;
  name?: string;
}

export type EventInput =
  // `target` is the branch the job is based on and merges into, resolved by the CLI at claim time
  // (absent on logs claimed before it existed).
  | { type: 'job.claimed'; schema: 'factory/v1'; id: string; maxRound: number; brief: string | null; issue: string | null; target?: string }
  | { type: 'job.titled'; title: string }
  | { type: 'stage.entered'; stage: EnteredStage }
  | { type: 'round.started'; round: number; reviewers: string[] }
  | ({ type: 'agent.started' } & AgentIdentity)
  | ({ type: 'agent.finished'; verdict?: Verdict } & AgentIdentity)
  | { type: 'job.noted'; note: string }
  | { type: 'job.escalated'; reason: string }
  | { type: 'job.reworked'; k: number; maxRound: number }
  | { type: 'job.human-approved' }
  | { type: 'merge.failed'; reason: string }
  | { type: 'job.merged'; sha: string }
  | { type: 'job.abandoned'; reason: string };

export type FactoryEvent = EventInput & { ts: string };

export interface Config {
  schema: 'factory/v1';
  name?: string; // the project's display name (Andon); absent means the root's basename
  reviewers: string[];
  maxRound: number;
  dashboard: { settleAfterHours: number };
  gate?: string[]; // shell commands run in order from the worktree root; green only when all exit 0
  roles?: Record<string, RoleRunner>; // keyed by a fixed role or a configured reviewer key
  merge?: MergePolicy;
}

/** How a job lands. `target` is `"current"` (the main checkout's branch at claim time) or a branch name. */
export interface MergePolicy {
  target?: string;
}

/** The `merge.target` value meaning "the branch the main checkout is on". */
export const CURRENT_TARGET = 'current';

/**
 * The branch names a target may have: a conservative subset of git's ref names, so a target can
 * never carry shell metacharacters, quotes, or whitespace into the commands that use it.
 */
export const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** True when `name` is a branch name a target may use (see `BRANCH_PATTERN`). */
export function isTargetBranch(name: string): boolean {
  return (
    BRANCH_PATTERN.test(name) &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.includes('/.') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock')
  );
}

/** The effective `merge.target`: `"current"` when `merge` or `merge.target` is absent. */
export function mergeTarget(config: Config): string {
  return config.merge?.target ?? CURRENT_TARGET;
}

/** The runners a role may be filled by. Widened additively within v1 as runners ship. */
export type Runner = 'claude';

/** How one role is run: by which runner, and optionally on which harness model (default `opus`). */
export interface RoleRunner {
  runner: Runner;
  model?: string;
}

/** A role's model is an opaque harness model name, constrained so it can't break YAML frontmatter. */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/;
/** The model a role runs on when `roles` gives it none. */
export const DEFAULT_MODEL = 'opus';
const RUNNERS: readonly Runner[] = ['claude'];

const SCHEMA = 'factory/v1';
const JOB_ID = /^\d{3}-[a-z0-9-]+$/;
/** True when `id` is a well-formed job id (`^\d{3}-[a-z0-9-]+$`), safe to build a path from. */
export const isJobId = (id: string): boolean => JOB_ID.test(id);
/** The slug `claim` accepts: the job id with its `NNN-` prefix removed. */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** The longest slug `claim` accepts, in characters. */
export const SLUG_MAX = 40;
/** The highest job number; `claim` refuses once it is taken. */
export const JOB_NUMBER_MAX = 999;

/** Throws a one-line reason unless `slug` is one `claim` accepts (`SLUG_PATTERN`, at most `SLUG_MAX`). */
export function checkSlug(slug: string): void {
  if (slug.length > SLUG_MAX) throw new Error(`slug ${JSON.stringify(slug)} is ${slug.length} characters (at most ${SLUG_MAX})`);
  if (!SLUG_PATTERN.test(slug)) throw new Error(`slug ${JSON.stringify(slug)} must match ${SLUG_PATTERN.source}`);
}
const REVIEWER_KEY = /^[a-z][a-z0-9-]*$/;
const RESERVED_KEYS = ['spec-writer', 'builder', 'approver'];
const ROLES: readonly Role[] = ['spec-writer', 'builder', 'reviewer', 'approver'];
const ENTERED: readonly EnteredStage[] = ['spec', 'build', 'approve'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

function noExtraKeys(obj: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${what}: unknown key ${extra.map((k) => `'${k}'`).join(', ')}`);
}

// ---- config ----

export function parseConfig(raw: unknown): Config {
  if (!isRecord(raw)) throw new Error('config: must be a JSON object');
  noExtraKeys(raw, ['schema', 'name', 'reviewers', 'maxRound', 'dashboard', 'gate', 'roles', 'merge'], 'config');
  if (raw.schema !== SCHEMA) throw new Error(`config: schema must be "${SCHEMA}"`);
  const { reviewers, maxRound, dashboard } = raw;
  if (!Array.isArray(reviewers) || reviewers.length === 0) throw new Error('config: reviewers must be a non-empty array');
  const keys: string[] = [];
  for (const k of reviewers) {
    if (typeof k !== 'string' || !REVIEWER_KEY.test(k)) throw new Error(`config: bad reviewer key ${JSON.stringify(k)} (want ^[a-z][a-z0-9-]*$)`);
    if (RESERVED_KEYS.includes(k)) throw new Error(`config: reviewer key '${k}' is reserved`);
    if (keys.includes(k)) throw new Error(`config: duplicate reviewer key '${k}'`);
    keys.push(k);
  }
  if (!isPosInt(maxRound)) throw new Error('config: maxRound must be a positive integer');
  if (!isRecord(dashboard)) throw new Error('config: dashboard must be an object');
  noExtraKeys(dashboard, ['settleAfterHours'], 'config.dashboard');
  const settle = dashboard.settleAfterHours;
  if (typeof settle !== 'number' || !(settle > 0)) throw new Error('config: dashboard.settleAfterHours must be a positive number');
  const config: Config = { schema: SCHEMA, reviewers: keys, maxRound, dashboard: { settleAfterHours: settle } };
  if (raw.name !== undefined) config.name = parseName(raw.name);
  if (raw.gate !== undefined) config.gate = parseGate(raw.gate);
  if (raw.roles !== undefined) config.roles = parseRoles(raw.roles, keys);
  if (raw.merge !== undefined) config.merge = parseMerge(raw.merge);
  return config;
}

// Optional `merge`: only `target`, a non-empty branch name or "current" (the default).
function parseMerge(merge: unknown): MergePolicy {
  if (!isRecord(merge)) throw new Error('config: merge must be an object { target? }');
  noExtraKeys(merge, ['target'], 'config.merge');
  if (merge.target === undefined) return {};
  const target = merge.target;
  if (typeof target !== 'string' || target.trim() === '') {
    throw new Error(`config: merge.target must be "${CURRENT_TARGET}" or a non-empty branch name`);
  }
  if (!isTargetBranch(target)) {
    throw new Error(`config: merge.target ${JSON.stringify(target)} is not an allowed branch name (want ${BRANCH_PATTERN.source}, no '..', no '.lock' suffix)`);
  }
  return { target };
}

/** The longest project `name`, in Unicode code points. */
export const NAME_MAX = 64;
// Any Unicode Cc code point: U+0000–U+001F and U+007F–U+009F.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

// Optional `name`: a display label, 1–NAME_MAX code points, no leading or trailing whitespace, no
// control characters. The reason never echoes the value, so it stays one line.
function parseName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('config: name must be a string');
  const length = [...name].length;
  if (length === 0) throw new Error('config: name must not be empty');
  if (length > NAME_MAX) throw new Error(`config: name is ${length} characters (at most ${NAME_MAX})`);
  if (CONTROL.test(name)) throw new Error('config: name must not contain control characters');
  if (name.trim() !== name) throw new Error('config: name must not have leading or trailing whitespace');
  return name;
}

// Optional `roles`: role name (a fixed role or a configured reviewer key) -> { runner, model? }.
// Validated after `reviewers`, since the valid role names depend on them.
function parseRoles(roles: unknown, reviewers: readonly string[]): Record<string, RoleRunner> {
  if (!isRecord(roles)) throw new Error('config: roles must be an object mapping a role name to { runner, model? }');
  const out: Record<string, RoleRunner> = {};
  for (const [name, entry] of Object.entries(roles)) {
    const what = `config: roles.${REVIEWER_KEY.test(name) ? name : JSON.stringify(name)}`;
    if (!RESERVED_KEYS.includes(name) && !reviewers.includes(name)) {
      throw new Error(`${what}: unknown role (want ${[...RESERVED_KEYS, ...reviewers].join(', ')})`);
    }
    if (!isRecord(entry)) throw new Error(`${what}: must be an object { runner, model? }`);
    noExtraKeys(entry, ['runner', 'model'], what);
    if (entry.runner === undefined) throw new Error(`${what}: runner is required`);
    const runner = RUNNERS.find((r) => r === entry.runner);
    if (runner === undefined) throw new Error(`${what}: runner must be ${RUNNERS.map((r) => `"${r}"`).join(' or ')}`);
    const parsed: RoleRunner = { runner };
    if (entry.model !== undefined) {
      const model = entry.model;
      if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) {
        throw new Error(`${what}: model must be a non-empty string matching ${MODEL_PATTERN.source}`);
      }
      parsed.model = model;
    }
    out[name] = parsed;
  }
  return out;
}

// Optional `gate`: a non-empty array of non-empty shell command strings, kept in order.
function parseGate(gate: unknown): string[] {
  if (!Array.isArray(gate) || gate.length === 0) throw new Error('config: gate must be a non-empty array of command strings');
  const commands: string[] = [];
  for (const [i, c] of gate.entries()) {
    if (typeof c !== 'string' || c.trim() === '') throw new Error(`config: gate[${i}] must be a non-empty command string`);
    commands.push(c);
  }
  return commands;
}

// ---- event input ----

function str(f: Record<string, unknown>, k: string): string {
  const v = f[k];
  if (typeof v !== 'string' || v === '') throw new Error(`missing or non-string field '${k}'`);
  return v;
}
function optStr(f: Record<string, unknown>, k: string): string | undefined {
  return f[k] === undefined ? undefined : str(f, k);
}
function nullableStr(f: Record<string, unknown>, k: string): string | null {
  return f[k] === undefined || f[k] === null ? null : str(f, k);
}
function posInt(f: Record<string, unknown>, k: string): number {
  const v = f[k];
  if (!isPosInt(v)) throw new Error(`field '${k}' must be a positive integer`);
  return v;
}
function oneOf<T extends string>(f: Record<string, unknown>, k: string, allowed: readonly T[]): T {
  const v = str(f, k);
  const hit = allowed.find((a) => a === v);
  if (hit === undefined) throw new Error(`field '${k}' must be one of ${allowed.join('|')}`);
  return hit;
}
function reviewerKey(f: Record<string, unknown>, k: string): string {
  const v = str(f, k);
  if (!REVIEWER_KEY.test(v)) throw new Error(`bad reviewer key '${v}'`);
  return v;
}

function agentIdentity(f: Record<string, unknown>): AgentIdentity {
  const role = oneOf(f, 'role', ROLES);
  const name = optStr(f, 'name');
  const id: AgentIdentity = { role };
  if (role === 'reviewer') {
    id.key = reviewerKey(f, 'key');
    id.round = posInt(f, 'round');
  } else if (f.key !== undefined) throw new Error(`field 'key' is only for role 'reviewer'`);
  else if (f.round !== undefined) id.round = posInt(f, 'round');
  if (name !== undefined) id.name = name;
  return id;
}

// job.claimed: a caller may pass `brief`, `issue`, and `maxRound` (defaults to config.maxRound).
// round.started: `reviewers` defaults to config.reviewers.
// `id`, `schema`, and `target` (the resolved branch) are filled by the CLI via `ctx`, never typed
// by the caller. `verdict` is never caller-supplied for any event — the CLI reads it from the
// agent's file.
export function parseEventInput(
  type: string,
  fields: Record<string, unknown>,
  ctx?: { id: string; config: Config; target?: string },
): EventInput {
  const allow = (...keys: string[]) => noExtraKeys(fields, keys, `${type}: extra field`);
  switch (type) {
    case 'job.claimed': {
      allow('brief', 'issue', 'maxRound');
      if (!ctx) throw new Error('job.claimed: needs the job id and config from the CLI');
      if (ctx.target !== undefined && !isTargetBranch(ctx.target)) throw new Error(`job.claimed: target ${JSON.stringify(ctx.target)} is not an allowed branch name`);
      const maxRound = fields.maxRound === undefined ? ctx.config.maxRound : posInt(fields, 'maxRound');
      const claimed: Extract<EventInput, { type: 'job.claimed' }> = { type, schema: SCHEMA, id: ctx.id, maxRound, brief: nullableStr(fields, 'brief'), issue: nullableStr(fields, 'issue') };
      if (ctx.target !== undefined) claimed.target = ctx.target;
      return claimed;
    }
    case 'job.titled':
      allow('title');
      return { type, title: str(fields, 'title') };
    case 'stage.entered':
      allow('stage');
      return { type, stage: oneOf(fields, 'stage', ENTERED) };
    case 'round.started': {
      allow('round', 'reviewers');
      // Omitted -> the configured reviewers; the stored event always carries the list.
      if (fields.reviewers === undefined && !ctx) throw new Error(`round.started: field 'reviewers' needs the config from the CLI`);
      const list = fields.reviewers === undefined && ctx ? ctx.config.reviewers : fields.reviewers;
      if (!Array.isArray(list) || list.length === 0) throw new Error(`field 'reviewers' must be a non-empty array`);
      const reviewers = list.map((r) => reviewerKey({ r }, 'r'));
      if (new Set(reviewers).size !== reviewers.length) throw new Error(`field 'reviewers' has duplicates`);
      return { type, round: posInt(fields, 'round'), reviewers };
    }
    case 'agent.started':
      allow('role', 'key', 'round', 'name');
      return { type, ...agentIdentity(fields) };
    case 'agent.finished':
      allow('role', 'key', 'round', 'name');
      return { type, ...agentIdentity(fields) };
    case 'job.noted':
      allow('note');
      return { type, note: str(fields, 'note') };
    case 'job.escalated':
      allow('reason');
      return { type, reason: str(fields, 'reason') };
    case 'job.reworked':
      allow('k', 'maxRound');
      return { type, k: posInt(fields, 'k'), maxRound: posInt(fields, 'maxRound') };
    case 'job.human-approved':
      allow();
      return { type };
    case 'merge.failed':
      allow('reason');
      return { type, reason: str(fields, 'reason') };
    case 'job.merged':
      allow('sha');
      return { type, sha: str(fields, 'sha') };
    case 'job.abandoned':
      allow('reason');
      return { type, reason: str(fields, 'reason') };
    default:
      throw new Error(`unknown event type '${type}'`);
  }
}

// ---- transitions ----

interface State {
  stage: Stage | null; // null = no log yet
  round: number;
  maxRound: number;
  reviewers: string[]; // current round's list
  finished: Set<string>; // reviewers with a verdict in the current round
  humanApproved: boolean;
}

function derive(prior: FactoryEvent[]): State {
  const s: State = { stage: null, round: 0, maxRound: 0, reviewers: [], finished: new Set(), humanApproved: false };
  for (const e of prior) {
    switch (e.type) {
      case 'job.claimed': s.stage = 'claimed'; s.maxRound = e.maxRound; break;
      case 'stage.entered': s.stage = e.stage; break;
      case 'round.started': s.stage = 'review'; s.round = e.round; s.reviewers = e.reviewers; s.finished = new Set(); break;
      case 'agent.finished':
        if (e.role === 'reviewer' && e.key !== undefined && e.verdict !== undefined && e.round === s.round) s.finished.add(e.key);
        break;
      case 'job.escalated': s.stage = 'needs-human'; s.humanApproved = false; break;
      case 'job.reworked': s.stage = 'build'; s.maxRound = e.maxRound; s.humanApproved = false; break;
      case 'job.human-approved': s.humanApproved = true; break;
      case 'merge.failed': s.stage = 'needs-human'; s.humanApproved = false; break;
      case 'job.merged': s.stage = 'merged'; break;
      case 'job.abandoned': s.stage = 'abandoned'; break;
      default: break;
    }
  }
  return s;
}

function fail(msg: string): never {
  throw new Error(msg);
}

/** Options for `checkTransition`. `force` lets `job.abandoned` leave a working stage; nothing else reads it. */
export interface TransitionOptions {
  force?: boolean;
}

export function checkTransition(prior: FactoryEvent[], next: EventInput, opts: TransitionOptions = {}): void {
  const s = derive(prior);
  const { stage } = s;
  if (stage === null) {
    if (next.type !== 'job.claimed') fail(`no log yet: only job.claimed is allowed, got ${next.type}`);
    if (!JOB_ID.test(next.id)) fail(`job id '${next.id}' must match ^\\d{3}-[a-z0-9-]+$`);
    if (next.schema !== SCHEMA) fail(`schema must be "${SCHEMA}"`);
    if (!isPosInt(next.maxRound)) fail('maxRound must be a positive integer');
    return;
  }
  if (stage === 'merged' || stage === 'abandoned') fail(`job is ${stage} (terminal): ${next.type} not allowed`);
  const bad = (): never => fail(`${next.type} not allowed from stage '${stage}'`);

  switch (next.type) {
    case 'job.claimed':
      return bad();
    case 'job.noted':
    case 'job.titled':
    case 'agent.started':
    case 'agent.finished':
      return;
    case 'stage.entered': {
      if (next.stage === 'spec') return stage === 'claimed' ? undefined : bad();
      if (next.stage === 'build') {
        if (stage === 'spec') return;
        if (stage !== 'review') return bad();
        requireComplete(s);
        if (s.round >= s.maxRound) fail(`round ${s.round} has reached maxRound ${s.maxRound}: cannot enter build again`);
        return;
      }
      if (stage !== 'review') return bad();
      return requireComplete(s);
    }
    case 'round.started':
      if (stage !== 'build') return bad();
      if (next.round !== s.round + 1) fail(`round must be previous + 1 (${s.round + 1}), got ${next.round}`);
      return;
    case 'job.escalated':
      return stage === 'needs-human' ? bad() : undefined; // any working stage; merged is caught above
    case 'merge.failed':
      if (stage === 'approve') return;
      if (stage === 'needs-human' && s.humanApproved) return;
      return bad();
    case 'job.merged':
      if (stage === 'approve' || (stage === 'needs-human' && s.humanApproved)) return;
      return stage === 'needs-human' ? fail('job.merged from needs-human requires job.human-approved first') : bad();
    case 'job.reworked':
      return stage === 'needs-human' ? undefined : bad();
    case 'job.human-approved':
      // Idempotent while needs-human: a retried approve after an interrupted session is harmless.
      return stage === 'needs-human' ? undefined : bad();
    case 'job.abandoned':
      // From needs-human always; from a working stage only with force (the caller confirmed the
      // session driving the job is stopped). merged and abandoned are caught above.
      if (stage === 'needs-human' || opts.force === true) return;
      return fail(`job.abandoned from working stage '${stage}' requires force (abandon --force)`);
  }
}

function requireComplete(s: State): void {
  const waiting = s.reviewers.filter((r) => !s.finished.has(r));
  if (waiting.length) fail(`round ${s.round} is not complete, waiting on: ${waiting.join(', ')}`);
}
