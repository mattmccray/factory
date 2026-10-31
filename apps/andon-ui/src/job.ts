// The UI's view of the service's JSON (docs/contract/v1.md "`job.json` — the derived snapshot" and
// "Andon service"). The UI is a tolerant reader: it narrows `unknown` into the fields it shows,
// ignores fields it doesn't know, and treats a job with no `timing` (or no `startedAt`) as legacy.
// It imports `@factory/contract` with `import type` only (erased under `verbatimModuleSyntax`), to
// check its shapes against the contract's at compile time; it never runs contract code, so it
// runs in a browser (and later under txiki.js).
import type { AgentSpan as ContractAgentSpan, Config, EpicSnapshot, JobSnapshot, StageSpan as ContractStageSpan } from '@factory/contract';
import { toProjectRelease } from './release';
import type { ProjectRelease } from './release';

export type ReviewState = string; // 'PASS' | 'CHANGES' | 'pending', or a value a later v1 adds

export interface StageSpan {
  stage: string;
  round: number;
  enteredAt: string;
  exitedAt: string | null;
  ms: number | null;
}

export interface AgentSpan {
  role: string;
  key: string | null;
  round: number | null;
  startedAt: string;
  finishedAt: string | null;
  ms: number | null;
  verdict: string | null;
}

/** Why a job is (or was last) in `needs-human` (docs/contract/v1.md "`job.json`"). */
export type StoppedBy = 'escalated' | 'merge-failed';
/** The stages a job does its work in, before it stops for a human. */
export type WorkingStage = 'claimed' | 'spec' | 'build' | 'review' | 'approve';
/** What a job is to its epic (docs/contract/v1.md "Epic membership"): a plan member, or a generated sync or fix job. */
export type EpicJobKind = 'member' | 'sync' | 'fix';

export interface Job {
  id: string;
  title: string;
  branch: string;
  target: string | null; // the branch the job merges into; null: not recorded (claimed before it was)
  stage: string;
  round: number;
  maxRound: number | null;
  reviews: Record<string, ReviewState>;
  history: Array<{ round: number; reviews: Record<string, ReviewState> }>;
  decision: string | null;
  note: string;
  stoppedBy: StoppedBy | null; // null: not stopped, or a snapshot written before the field (a missing key)
  stoppedFrom: WorkingStage | null; // the working stage it left for needs-human; null as for stoppedBy
  startedAt: string | null;
  stageEnteredAt: string | null;
  endedAt: string | null;
  updated: string | null;
  timing: { stages: StageSpan[]; agents: AgentSpan[] } | null;
  epic: string | null; // the slug of the epic the job was claimed into; null: a standalone job (or a snapshot from before epics)
  kind: EpicJobKind | null; // what the job is to its epic; null exactly when `epic` is
}

/** One plan member of an epic, as `epic.json` lists it. */
export interface EpicMember {
  slug: string;
  after: string[];
  state: string; // queued, blocked, running, merged, needs-human, abandoned, or a state a later v1 adds
  job: string | null; // its newest job's id
  stage: string | null; // that job's stage
  blockedOn: Array<{ member: string; job: string | null }>;
}

/** The epic fields the UI reads (docs/contract/v1.md "`epic.json` — the derived snapshot"). */
export interface EpicCore {
  slug: string;
  branch: string;
  target: string;
  plan: string;
  planError: string | null;
  state: string; // running, waiting, landing, landed, abandoned, or a state a later v1 adds
  waitingOn: string | null; // 'you', 'members', or null
  note: string;
  sha: string | null;
  members: EpicMember[];
  generated: Array<{ id: string; kind: string; stage: string }>;
  counts: Record<string, number>;
  startedAt: string | null;
  endedAt: string | null;
  updated: string | null;
}

/**
 * An epic, plus its `title`: `epic.json` has none, so it is a non-empty string `title` when the
 * payload carries one (the service passes unknown fields through), else null. Its display name is
 * `epicName`.
 */
export interface Epic extends EpicCore {
  title: string | null;
}

export interface BoardConfig {
  reviewers: string[];
  settleAfterHours: number;
}

// Compile-time drift checks, one way: a real contract value must be accepted by the UI's wider
// shape. Narrowing a UI field so it no longer accepts the contract's type fails `bun run check`.
// (`ProjectInfo` is unchecked: the contract exports no type for the service's project entries.)
type Assignable<From, To> = [From] extends [To] ? true : false;
type Expect<T extends true> = T;
export type ContractShapesChecked = [
  Expect<Assignable<JobSnapshot, Job>>,
  Expect<Assignable<ContractStageSpan, StageSpan>>,
  Expect<Assignable<ContractAgentSpan, AgentSpan>>,
  Expect<Assignable<JobSnapshot['stoppedBy'], Job['stoppedBy']>>,
  Expect<Assignable<JobSnapshot['stoppedFrom'], Job['stoppedFrom']>>,
  Expect<Assignable<JobSnapshot['epic'], Job['epic']>>,
  Expect<Assignable<JobSnapshot['kind'], Job['kind']>>,
  Expect<Assignable<EpicSnapshot, EpicCore>>,
  Expect<Assignable<Config['reviewers'], BoardConfig['reviewers']>>,
  Expect<Assignable<Config['dashboard']['settleAfterHours'], BoardConfig['settleAfterHours']>>,
];

export interface ProjectInfo {
  id: string;
  name: string;
  root: string;
  /** Its factory release (`{ installed, state }`); absent when the service sent none (an older service) or a malformed one. */
  release?: ProjectRelease;
  /** The machine name of the service the project is on; absent when the service sent none (one from before the hub). */
  machine?: string;
}

/** A machine's state, as `GET /machines` reports it (docs/contract/v1.md "Andon service", "Peers"). */
export type MachineState = 'live' | 'connecting' | 'down' | 'error';
const MACHINE_STATES: readonly MachineState[] = ['live', 'connecting', 'down', 'error'];

/** One `GET /machines` entry: this machine first, then each listed peer. */
export interface Machine {
  name: string;
  url: string;
  state: MachineState;
  since: string; // ISO 8601: when it entered that state
  reason: string | null;
  release: string | null; // its service's running release; null when it can't be read
}

export const DEFAULT_SETTLE_HOURS = 24;

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function reviews(v: unknown): Record<string, ReviewState> {
  const out: Record<string, ReviewState> = {};
  if (!isRecord(v)) return out;
  for (const [k, r] of Object.entries(v)) if (typeof r === 'string') out[k] = r;
  return out;
}

function stageSpan(v: unknown): StageSpan | null {
  if (!isRecord(v)) return null;
  const stage = str(v.stage);
  const enteredAt = str(v.enteredAt);
  if (stage === null || enteredAt === null) return null;
  return { stage, round: num(v.round) ?? 0, enteredAt, exitedAt: str(v.exitedAt), ms: num(v.ms) };
}

function agentSpan(v: unknown): AgentSpan | null {
  if (!isRecord(v)) return null;
  const role = str(v.role);
  const startedAt = str(v.startedAt);
  if (role === null || startedAt === null) return null;
  return { role, key: str(v.key), round: num(v.round), startedAt, finishedAt: str(v.finishedAt), ms: num(v.ms), verdict: str(v.verdict) };
}

const STOPPED_BY: readonly StoppedBy[] = ['escalated', 'merge-failed'];
const EPIC_KINDS: readonly EpicJobKind[] = ['member', 'sync', 'fix'];
const WORKING: readonly WorkingStage[] = ['claimed', 'spec', 'build', 'review', 'approve'];
/** One of `allowed`, or null for a missing key or any other value. */
const oneOf = <T extends string>(allowed: readonly T[], v: unknown): T | null => allowed.find((a) => a === v) ?? null;

const present = <T>(v: T | null): v is T => v !== null;

/** Narrows one `job.json` value. Anything without a string `id` is dropped; unknown fields are ignored. */
export function toJob(v: unknown): Job | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  if (id === null || id === '') return null;
  const t = v.timing;
  const epic = str(v.epic) || null;
  return {
    id,
    title: str(v.title) ?? id,
    branch: str(v.branch) ?? '',
    target: str(v.target) || null,
    stage: str(v.stage) ?? 'claimed',
    round: num(v.round) ?? 0,
    maxRound: num(v.maxRound),
    reviews: reviews(v.reviews),
    history: list(v.history)
      .filter(isRecord)
      .map((h) => ({ round: num(h.round) ?? 0, reviews: reviews(h.reviews) })),
    decision: str(v.decision),
    note: str(v.note) ?? '',
    stoppedBy: oneOf(STOPPED_BY, v.stoppedBy),
    stoppedFrom: oneOf(WORKING, v.stoppedFrom),
    startedAt: str(v.startedAt),
    stageEnteredAt: str(v.stageEnteredAt),
    endedAt: str(v.endedAt),
    updated: str(v.updated),
    timing: isRecord(t) ? { stages: list(t.stages).map(stageSpan).filter(present), agents: list(t.agents).map(agentSpan).filter(present) } : null,
    epic,
    // a job in an epic with no readable kind is a member, as the contract reads one
    kind: epic === null ? null : (oneOf(EPIC_KINDS, v.kind) ?? 'member'),
  };
}

/** The drawer's branch line, `factory/<id> → <target>`; null when the job has no recorded target. */
export function landing(job: Job): string | null {
  if (job.target === null) return null;
  return `${job.branch || `factory/${job.id}`} → ${job.target}`;
}

export const toJobs = (v: unknown): Job[] => list(v).map(toJob).filter(present);

const strings = (v: unknown): string[] => list(v).filter((x): x is string => typeof x === 'string');

function epicMember(v: unknown): EpicMember | null {
  if (!isRecord(v)) return null;
  const slug = str(v.slug);
  if (slug === null || slug === '') return null;
  return {
    slug,
    after: strings(v.after),
    state: str(v.state) ?? 'queued',
    job: str(v.job) || null,
    stage: str(v.stage),
    blockedOn: list(v.blockedOn)
      .filter(isRecord)
      .map((b) => ({ member: str(b.member) ?? '', job: str(b.job) || null }))
      .filter((b) => b.member !== ''),
  };
}

function generatedJob(v: unknown): { id: string; kind: string; stage: string } | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  return id === null || id === '' ? null : { id, kind: str(v.kind) ?? 'sync', stage: str(v.stage) ?? 'claimed' };
}

function counts(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(v)) return out;
  for (const [k, n] of Object.entries(v)) if (typeof n === 'number' && Number.isInteger(n) && n >= 0) out[k] = n;
  return out;
}

/** Narrows one `epic.json` value. Anything without a non-empty string `slug` is dropped; unknown fields are ignored (but `title`). */
export function toEpic(v: unknown): Epic | null {
  if (!isRecord(v)) return null;
  const slug = str(v.slug);
  if (slug === null || slug === '') return null;
  return {
    slug,
    title: str(v.title)?.trim() || null,
    branch: str(v.branch) || `factory/epic/${slug}`,
    target: str(v.target) ?? '',
    plan: str(v.plan) ?? `factory/epics/${slug}.md`,
    planError: str(v.planError),
    state: str(v.state) ?? 'running',
    waitingOn: str(v.waitingOn),
    note: str(v.note) ?? '',
    sha: str(v.sha) || null,
    members: list(v.members).map(epicMember).filter(present),
    generated: list(v.generated).map(generatedJob).filter(present),
    counts: counts(v.counts),
    startedAt: str(v.startedAt),
    endedAt: str(v.endedAt),
    updated: str(v.updated),
  };
}

/** A payload's `epics`: a missing or malformed list is `[]`, and a malformed entry (or a second one with the same slug) is skipped. */
export function toEpics(v: unknown): Epic[] {
  const out: Epic[] = [];
  for (const e of list(v).map(toEpic).filter(present)) if (!out.some((x) => x.slug === e.slug)) out.push(e);
  return out;
}

/** An epic's display name: its `title` when the payload carries one, else its slug. */
export const epicName = (e: Pick<Epic, 'slug' | 'title'>): string => e.title ?? e.slug;

/** The parts of `config.json` the board reads. A missing `settleAfterHours` is 24. */
export function toConfig(v: unknown): BoardConfig {
  const c = isRecord(v) ? v : {};
  const dash = isRecord(c.dashboard) ? c.dashboard : {};
  const hours = num(dash.settleAfterHours);
  return {
    reviewers: list(c.reviewers).filter((r): r is string => typeof r === 'string'),
    settleAfterHours: hours !== null && hours > 0 ? hours : DEFAULT_SETTLE_HOURS,
  };
}

export function toProjects(v: unknown): ProjectInfo[] {
  const out: ProjectInfo[] = [];
  for (const p of list(isRecord(v) ? v.projects : null)) {
    if (!isRecord(p)) continue;
    const id = str(p.id);
    if (id === null) continue;
    const root = str(p.root) ?? '';
    const release = toProjectRelease(p.release);
    const info: ProjectInfo = release === null ? { id, name: str(p.name) ?? id, root } : { id, name: str(p.name) ?? id, root, release };
    const machine = str(p.machine);
    out.push(machine === null || machine === '' ? info : { ...info, machine });
  }
  return out;
}

/**
 * A `GET /machines` body (`{ machines: [...] }`, also the `machines` event's data), narrowed: an
 * entry without a non-empty string `name`, a string `url`, a known `state`, and a string `since` is
 * skipped; a `reason` or `release` that isn't a string is null; unknown fields are ignored. Null
 * when the body has no `machines` list.
 */
export function toMachines(v: unknown): Machine[] | null {
  if (!isRecord(v) || !Array.isArray(v.machines)) return null;
  const out: Machine[] = [];
  for (const m of v.machines) {
    if (!isRecord(m)) continue;
    const name = str(m.name);
    const url = str(m.url);
    const state = oneOf(MACHINE_STATES, m.state);
    const since = str(m.since);
    if (name === null || name === '' || url === null || state === null || since === null) continue;
    if (out.some((x) => x.name === name)) continue; // a repeated name: the first wins
    out.push({ name, url, state, since, reason: str(m.reason), release: str(m.release) });
  }
  return out;
}
