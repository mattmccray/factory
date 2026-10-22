// The factory/v1 state contract (docs/contract/v1.md): event types, config parsing, and the
// transition rules the CLI enforces before it appends. Dependency-free on purpose.

export type Stage = 'claimed' | 'spec' | 'build' | 'review' | 'approve' | 'needs-human' | 'merged';
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
  | { type: 'job.claimed'; schema: 'factory/v1'; id: string; maxRound: number; brief: string | null; issue: string | null }
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
  | { type: 'job.merged'; sha: string };

export type FactoryEvent = EventInput & { ts: string };

export interface Config {
  schema: 'factory/v1';
  reviewers: string[];
  maxRound: number;
  dashboard: { settleAfterHours: number };
}

const SCHEMA = 'factory/v1';
const JOB_ID = /^\d{3}-[a-z0-9-]+$/;
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
  noExtraKeys(raw, ['schema', 'reviewers', 'maxRound', 'dashboard'], 'config');
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
  return { schema: SCHEMA, reviewers: keys, maxRound, dashboard: { settleAfterHours: settle } };
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
// `id` and `schema` are filled by the CLI via `ctx`, never typed by the caller. `verdict` is
// never caller-supplied for any event — the CLI reads it from the agent's file.
export function parseEventInput(
  type: string,
  fields: Record<string, unknown>,
  ctx?: { id: string; config: Config },
): EventInput {
  const allow = (...keys: string[]) => noExtraKeys(fields, keys, `${type}: extra field`);
  switch (type) {
    case 'job.claimed': {
      allow('brief', 'issue', 'maxRound');
      if (!ctx) throw new Error('job.claimed: needs the job id and config from the CLI');
      const maxRound = fields.maxRound === undefined ? ctx.config.maxRound : posInt(fields, 'maxRound');
      return { type, schema: SCHEMA, id: ctx.id, maxRound, brief: nullableStr(fields, 'brief'), issue: nullableStr(fields, 'issue') };
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
      default: break;
    }
  }
  return s;
}

function fail(msg: string): never {
  throw new Error(msg);
}

export function checkTransition(prior: FactoryEvent[], next: EventInput): void {
  const s = derive(prior);
  const { stage } = s;
  if (stage === null) {
    if (next.type !== 'job.claimed') fail(`no log yet: only job.claimed is allowed, got ${next.type}`);
    if (!JOB_ID.test(next.id)) fail(`job id '${next.id}' must match ^\\d{3}-[a-z0-9-]+$`);
    if (next.schema !== SCHEMA) fail(`schema must be "${SCHEMA}"`);
    if (!isPosInt(next.maxRound)) fail('maxRound must be a positive integer');
    return;
  }
  if (stage === 'merged') fail(`job is merged (terminal): ${next.type} not allowed`);
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
  }
}

function requireComplete(s: State): void {
  const waiting = s.reviewers.filter((r) => !s.finished.has(r));
  if (waiting.length) fail(`round ${s.round} is not complete, waiting on: ${waiting.join(', ')}`);
}
