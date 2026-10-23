// The UI's view of the agent's JSON (docs/contract/v1.md "`job.json` — the derived snapshot" and
// "Andon agent"). The UI is a tolerant reader: it narrows `unknown` into the fields it shows,
// ignores fields it doesn't know, and treats a job with no `timing` (or no `startedAt`) as legacy.
// It imports `@factory/contract` with `import type` only (erased under `verbatimModuleSyntax`), to
// check its shapes against the contract's at compile time; it never runs contract code, so it
// runs in a browser (and later under txiki.js).
import type { AgentSpan as ContractAgentSpan, Config, JobSnapshot, StageSpan as ContractStageSpan } from '@factory/contract';

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
  startedAt: string | null;
  stageEnteredAt: string | null;
  endedAt: string | null;
  updated: string | null;
  timing: { stages: StageSpan[]; agents: AgentSpan[] } | null;
}

export interface BoardConfig {
  reviewers: string[];
  settleAfterHours: number;
}

// Compile-time drift checks, one way: a real contract value must be accepted by the UI's wider
// shape. Narrowing a UI field so it no longer accepts the contract's type fails `bun run check`.
// (`ProjectInfo` is unchecked: the contract exports no type for the agent's project entries.)
type Assignable<From, To> = [From] extends [To] ? true : false;
type Expect<T extends true> = T;
export type ContractShapesChecked = [
  Expect<Assignable<JobSnapshot, Job>>,
  Expect<Assignable<ContractStageSpan, StageSpan>>,
  Expect<Assignable<ContractAgentSpan, AgentSpan>>,
  Expect<Assignable<Config['reviewers'], BoardConfig['reviewers']>>,
  Expect<Assignable<Config['dashboard']['settleAfterHours'], BoardConfig['settleAfterHours']>>,
];

export interface ProjectInfo {
  id: string;
  name: string;
  root: string;
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

const present = <T>(v: T | null): v is T => v !== null;

/** Narrows one `job.json` value. Anything without a string `id` is dropped; unknown fields are ignored. */
export function toJob(v: unknown): Job | null {
  if (!isRecord(v)) return null;
  const id = str(v.id);
  if (id === null || id === '') return null;
  const t = v.timing;
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
    startedAt: str(v.startedAt),
    stageEnteredAt: str(v.stageEnteredAt),
    endedAt: str(v.endedAt),
    updated: str(v.updated),
    timing: isRecord(t) ? { stages: list(t.stages).map(stageSpan).filter(present), agents: list(t.agents).map(agentSpan).filter(present) } : null,
  };
}

/** The drawer's branch line, `factory/<id> → <target>`; null when the job has no recorded target. */
export function landing(job: Job): string | null {
  if (job.target === null) return null;
  return `${job.branch || `factory/${job.id}`} → ${job.target}`;
}

export const toJobs = (v: unknown): Job[] => list(v).map(toJob).filter(present);

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
    out.push({ id, name: str(p.name) ?? id, root });
  }
  return out;
}
