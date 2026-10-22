// Projection: the append-only event log -> the `job.json` snapshot (factory/CONTRACT.md).
// Pure — no clock reads. Viewers compute live elapsed time from the open timestamps.
import type { FactoryEvent, Role, Stage, Verdict } from './contract';

export type ReviewState = 'PASS' | 'CHANGES' | 'pending';
export type Decision = 'APPROVE' | 'ESCALATE' | 'APPROVE (human)';

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
  builder: string | null;
  stage: Stage;
  round: number;
  maxRound: number;
  reviews: Record<string, ReviewState>;
  history: { round: number; reviews: Record<string, ReviewState> }[];
  reworks: number;
  decision: Decision | null;
  note: string;
  brief: string | null;
  issue: string | null;
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
      for (const a of s.timing.agents) {
        if (a.finishedAt === null) {
          a.finishedAt = e.ts;
          a.ms = ms(a.startedAt, e.ts);
        }
      }
      s.note = e.reason;
      enterStage(s, 'needs-human', e.ts);
      return;
    case 'merge.failed':
      s.note = e.reason;
      enterStage(s, 'needs-human', e.ts);
      return;
    case 'job.reworked':
      s.reworks = e.k;
      s.maxRound = e.maxRound;
      s.decision = null;
      s.note = ''; // the escalation reason no longer describes the job
      enterStage(s, 'build', e.ts);
      return;
    case 'job.human-approved':
      s.decision = 'APPROVE (human)';
      return;
    case 'job.merged':
      s.endedAt = e.ts;
      s.note = `merged ${e.sha}`;
      enterStage(s, 'merged', e.ts);
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
    builder: null,
    stage: 'claimed',
    round: 0,
    maxRound: first.maxRound,
    reviews: {},
    history: [],
    reworks: 0,
    decision: null,
    note: '',
    brief: first.brief,
    issue: first.issue,
    startedAt: first.ts,
    stageEnteredAt: first.ts,
    endedAt: null,
    updated: first.ts,
    timing: { stages: [{ stage: 'claimed', round: 0, enteredAt: first.ts, exitedAt: null, ms: null }], agents: [] },
  };
  for (const e of events.slice(1)) apply(snapshot, e);
  return snapshot;
}
