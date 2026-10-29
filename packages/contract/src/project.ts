// Projection: the append-only event log -> the `job.json` snapshot (docs/contract/v1.md).
// Pure — no clock reads. Viewers compute live elapsed time from the open timestamps.
import { isSession, workingStage } from './contract';
import type { FactoryEvent, Role, Session, Stage, Verdict, WorkingStage } from './contract';

export type ReviewState = 'PASS' | 'CHANGES' | 'pending';
export type Decision = 'APPROVE' | 'ESCALATE' | 'APPROVE (human)';
/** Why a job is (or was last) in `needs-human`. */
export type StoppedBy = 'escalated' | 'merge-failed';

export interface StageSpan {
  stage: Stage;
  round: number;
  enteredAt: string;
  exitedAt: string | null;
  ms: number | null;
}

export interface AgentSpan {
  role: Role;
  key: string | null;
  round: number | null;
  name: string | null;
  startedAt: string;
  finishedAt: string | null;
  ms: number | null;
  verdict: Verdict | null;
}

export interface JobSnapshot {
  schema: 'factory/v1';
  id: string;
  title: string;
  branch: string;
  target: string | null; // the branch the job is based on and merges into; null: claimed before it was recorded
  builder: string | null;
  stage: Stage;
  round: number;
  maxRound: number;
  reviews: Record<string, ReviewState>;
  history: { round: number; reviews: Record<string, ReviewState> }[];
  reworks: number;
  conflicts: number; // merge.conflicted events in the log; 0 when none (readers treat a missing key as 0)
  decision: Decision | null;
  note: string;
  stoppedBy: StoppedBy | null; // set by job.escalated / merge.failed; reset by job.reworked
  stoppedFrom: WorkingStage | null; // the working stage the job left for needs-human
  brief: string | null;
  issue: string | null;
  session: Session | null; // the most recent session on job.claimed/job.reworked/job.human-approved; null: none ever
  startedAt: string;
  stageEnteredAt: string;
  endedAt: string | null;
  updated: string;
  timing: { stages: StageSpan[]; agents: AgentSpan[] };
}

const ms = (from: string, to: string): number => Date.parse(to) - Date.parse(from);

function enterStage(s: JobSnapshot, stage: Stage, ts: string): void {
  if (s.stage === stage && s.timing.stages.length > 0) return; // e.g. merge.failed from needs-human
  const open = s.timing.stages[s.timing.stages.length - 1];
  if (open && open.exitedAt === null) {
    open.exitedAt = ts;
    open.ms = ms(open.enteredAt, ts);
  }
  s.stage = stage;
  s.stageEnteredAt = ts;
  s.timing.stages.push({ stage, round: s.round, enteredAt: ts, exitedAt: null, ms: null });
}

function sameAgent(a: AgentSpan, role: Role, key: string | null, round: number | null, name: string | null): boolean {
  return a.role === role && a.key === key && a.round === round && a.name === name;
}

// An event that ends a stage from the outside (an agent never wrote its file, or the job was
// abandoned) leaves no agent span open: each closes at `ts` with its verdict still null.
function closeOpenAgents(s: JobSnapshot, ts: string): void {
  for (const a of s.timing.agents) {
    if (a.finishedAt === null) {
      a.finishedAt = ts;
      a.ms = ms(a.startedAt, ts);
    }
  }
}

// Readers are tolerant: a stored session that isn't well-formed is ignored, never fatal.
const storedSession = (v: unknown): Session | null => (isSession(v) ? { app: v.app, environment: v.environment, thread: v.thread } : null);

function apply(s: JobSnapshot, e: FactoryEvent): void {
  s.updated = e.ts;
  switch (e.type) {
    case 'job.claimed':
      return; // handled by the initial snapshot
    case 'job.titled':
      s.title = e.title;
      return;
    case 'stage.entered':
      enterStage(s, e.stage, e.ts);
      return;
    case 'round.started': {
      if (s.round > 0) s.history.push({ round: s.round, reviews: s.reviews });
      s.round = e.round;
      s.reviews = Object.fromEntries(e.reviewers.map((k): [string, ReviewState] => [k, 'pending']));
      enterStage(s, 'review', e.ts);
      return;
    }
    case 'agent.started': {
      const name = e.name ?? null;
      if (e.role === 'builder' && name !== null) s.builder = name;
      s.timing.agents.push({
        role: e.role, key: e.key ?? null, round: e.round ?? null, name,
        startedAt: e.ts, finishedAt: null, ms: null, verdict: null,
      });
      return;
    }
    case 'agent.finished': {
      const key = e.key ?? null;
      const round = e.round ?? null;
      const name = e.name ?? null;
      const verdict = e.verdict ?? null;
      // Latest unmatched start first. A finish with no start (shouldn't happen: the CLI
      // doesn't enforce pairing) is kept as a zero-length span rather than dropped.
      let span: AgentSpan | undefined;
      for (let i = s.timing.agents.length - 1; i >= 0; i--) {
        const a = s.timing.agents[i];
        if (a && a.finishedAt === null && sameAgent(a, e.role, key, round, name)) { span = a; break; }
      }
      if (!span) {
        span = { role: e.role, key, round, name, startedAt: e.ts, finishedAt: null, ms: null, verdict: null };
        s.timing.agents.push(span);
      }
      span.finishedAt = e.ts;
      span.ms = ms(span.startedAt, e.ts);
      span.verdict = verdict;
      // A chip belongs to the current round: a stale (or future) round's finish, or a key the
      // round never listed, closes its span but leaves the chips alone.
      if (e.role === 'reviewer' && key !== null && (verdict === 'PASS' || verdict === 'CHANGES')) {
        if (round === s.round && Object.hasOwn(s.reviews, key)) s.reviews[key] = verdict;
      } else if (e.role === 'approver' && (verdict === 'APPROVE' || verdict === 'ESCALATE')) {
        s.decision = verdict;
      }
      return;
    }
    case 'job.noted':
      s.note = e.note;
      return;
    case 'job.escalated':
      // An escalation can come mid-stage (an agent never wrote its file): no span stays open.
      closeOpenAgents(s, e.ts);
      s.note = e.reason;
      s.stoppedBy = 'escalated';
      s.stoppedFrom = workingStage(s.stage);
      enterStage(s, 'needs-human', e.ts);
      return;
    case 'merge.failed':
      s.note = e.reason;
      s.stoppedBy = 'merge-failed';
      // From approve, that's where it stopped; a retry from needs-human keeps the original stage.
      if (s.stage !== 'needs-human') s.stoppedFrom = workingStage(s.stage);
      enterStage(s, 'needs-human', e.ts);
      return;
    case 'merge.conflicted':
      // Back to the builder with a two-round budget past the current round. stoppedBy/stoppedFrom,
      // reworks, and session stay; no agent runs during a merge, so no span closes. The decision
      // approved work the resolution has since changed: the next approver run sets it again.
      s.conflicts += 1;
      s.maxRound = s.round + 2;
      s.note = e.reason;
      s.decision = null;
      enterStage(s, 'build', e.ts);
      return;
    case 'job.reworked':
      s.reworks = e.k;
      s.stoppedBy = null;
      s.stoppedFrom = null;
      s.maxRound = e.maxRound;
      s.decision = null;
      s.note = ''; // the escalation reason no longer describes the job
      s.session = storedSession(e.session) ?? s.session; // latest wins; none keeps the earlier one
      enterStage(s, 'build', e.ts);
      return;
    case 'job.human-approved':
      s.decision = 'APPROVE (human)';
      s.session = storedSession(e.session) ?? s.session;
      return;
    case 'job.merged':
      s.endedAt = e.ts;
      s.note = `merged ${e.sha}`;
      enterStage(s, 'merged', e.ts);
      return;
    case 'job.abandoned':
      // Terminal like merged; stoppedBy/stoppedFrom keep why it last stopped, if it did.
      closeOpenAgents(s, e.ts);
      s.endedAt = e.ts;
      s.note = e.reason;
      enterStage(s, 'abandoned', e.ts);
      return;
  }
}

export function project(events: FactoryEvent[]): JobSnapshot {
  const first = events[0];
  if (!first || first.type !== 'job.claimed') throw new Error('event log must start with job.claimed');
  const snapshot: JobSnapshot = {
    schema: first.schema,
    id: first.id,
    title: first.id,
    branch: `factory/${first.id}`,
    target: typeof first.target === 'string' ? first.target : null,
    builder: null,
    stage: 'claimed',
    round: 0,
    maxRound: first.maxRound,
    reviews: {},
    history: [],
    reworks: 0,
    conflicts: 0,
    decision: null,
    note: '',
    stoppedBy: null,
    stoppedFrom: null,
    brief: first.brief,
    issue: first.issue,
    session: storedSession(first.session),
    startedAt: first.ts,
    stageEnteredAt: first.ts,
    endedAt: null,
    updated: first.ts,
    timing: { stages: [{ stage: 'claimed', round: 0, enteredAt: first.ts, exitedAt: null, ms: null }], agents: [] },
  };
  for (const e of events.slice(1)) apply(snapshot, e);
  return snapshot;
}
