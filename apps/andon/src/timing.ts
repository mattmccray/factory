// The drawer's timing, ported from the vendored dashboard's `summaryHtml` and `timingHtml`: a
// one-line summary under the title, and a "timing" view with a stage bar, a stage table, and an
// agent table. Work spans exclude `claimed` and `merged`; open spans are measured to `now`.
import type { AgentSpan, Job, StageSpan } from './job';
import { fmt, time, when } from './time';

export const NO_TIMING = 'no timing recorded — this job predates the event log';

type Span = { start: string; end: string | null; ms: number | null };
const ofStage = (s: StageSpan): Span => ({ start: s.enteredAt, end: s.exitedAt, ms: s.ms });
const ofAgent = (a: AgentSpan): Span => ({ start: a.startedAt, end: a.finishedAt, ms: a.ms });
const spanMs = (s: Span, now: number): number => s.ms ?? (s.end !== null ? time(s.end) : now) - time(s.start);

/** A job's timing, or null for a legacy job (no `timing`, or no `startedAt` to measure from). */
const timed = (j: Job): { startedAt: string; stages: StageSpan[]; agents: AgentSpan[] } | null =>
  j.timing === null || j.startedAt === null ? null : { startedAt: j.startedAt, ...j.timing };

export const workSpans = (j: Job): StageSpan[] => (j.timing?.stages ?? []).filter((s) => s.stage !== 'merged' && s.stage !== 'claimed');
export const stageLabel = (stage: string): string => (stage === 'needs-human' ? 'waiting' : stage);
const rounds = (n: number): string => (n > 0 ? `${n} round${n > 1 ? 's' : ''}` : '');

const totalMs = (j: Job, startedAt: string, now: number): number => (j.endedAt !== null ? time(j.endedAt) : now) - time(startedAt);

/** The drawer's summary line: total, then per-stage sums across rounds, then the round count. */
export function summary(j: Job, now: number): { recorded: boolean; text: string } {
  const t = timed(j);
  if (t === null) return { recorded: false, text: NO_TIMING };
  const sums = new Map<string, number>();
  for (const s of workSpans(j)) sums.set(s.stage, (sums.get(s.stage) ?? 0) + spanMs(ofStage(s), now));
  const parts = [`total ${fmt(totalMs(j, t.startedAt, now))}`, ...[...sums].map(([stage, ms]) => `${stageLabel(stage)} ${fmt(ms)}`), rounds(j.round)];
  return { recorded: true, text: parts.filter((p) => p !== '').join(' · ') };
}

export interface BarSegment {
  stage: string; // the raw stage, for styling
  grow: number; // the segment's share of the bar
  title: string;
}

export interface StageRow {
  stage: string;
  round: string;
  entered: string;
  duration: string;
  open: boolean;
}

export interface AgentRow {
  who: string;
  round: string;
  verdict: string | null; // a verdict dot, when the agent gave one
  result: string; // the verdict, "running", "done", or "stopped"
  muted: boolean; // "stopped" reads faint
  started: string;
  duration: string;
  open: boolean;
}

export interface TimingView {
  claimed: string;
  merged: string | null;
  total: string;
  bar: BarSegment[];
  legend: Array<{ stage: string; label: string }>;
  stages: StageRow[];
  agents: AgentRow[];
}

const roundLabel = (r: number | null): string => (r !== null && r > 0 ? `R${r}` : '—');

/** The "timing" view, or null for a legacy job (the drawer then shows no "timing" entry). */
export function timingView(j: Job, now: number): TimingView | null {
  const t = timed(j);
  if (t === null) return null;
  const stages = workSpans(j);
  const bar = stages.map((s) => {
    const ms = spanMs(ofStage(s), now);
    return { stage: s.stage, grow: Math.max(ms, 1), title: `${stageLabel(s.stage)}${s.round > 0 ? ` · R${s.round}` : ''} · ${fmt(ms)}` };
  });
  const legend = [...new Set(stages.map((s) => s.stage))].map((stage) => ({ stage, label: stageLabel(stage) }));
  const stageRows = stages.map((s) => ({
    stage: stageLabel(s.stage),
    round: roundLabel(s.round),
    entered: when(time(s.enteredAt)),
    duration: fmt(spanMs(ofStage(s), now)),
    open: s.exitedAt === null,
  }));
  const agents = [...t.agents].sort((a, b) => time(a.startedAt) - time(b.startedAt));
  const agentRows = agents.map((a) => {
    // Spec-writer and builder finish without a verdict; a reviewer or approver closed without one was stopped by an escalation.
    const graded = a.role === 'reviewer' || a.role === 'approver';
    const result = a.verdict ?? (a.finishedAt === null ? 'running' : graded ? 'stopped' : 'done');
    return {
      who: a.role === 'reviewer' ? (a.key ?? a.role) : a.role,
      round: roundLabel(a.round),
      verdict: a.verdict,
      result,
      muted: a.verdict === null && a.finishedAt !== null && graded,
      started: when(time(a.startedAt)),
      duration: fmt(spanMs(ofAgent(a), now)),
      open: a.finishedAt === null,
    };
  });
  return {
    claimed: when(time(t.startedAt)),
    merged: j.endedAt !== null ? when(time(j.endedAt)) : null,
    total: fmt(totalMs(j, t.startedAt, now)),
    bar,
    legend,
    stages: stageRows,
    agents: agentRows,
  };
}
