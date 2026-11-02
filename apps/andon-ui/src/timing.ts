// The drawer's timing, ported from the vendored dashboard's `summaryHtml` and `timingHtml`: a
// one-line summary under the title, and a "timing" view with a stage bar, a stage table, and an
// agent table. Work spans exclude `claimed` and `merged`; open spans are measured to `now`.
// Token spend (design §8): a Tokens column in both tables, an orchestrator row, a usage summary,
// and the job's total on the summary line (usage.ts holds the cells and the gap states).
import type { AgentSpan, Job, StageSpan } from './job';
import { fmt, time, when } from './time';
import { BLANK, NOT_RECORDED_TITLE, spanCell, tokensPart, totalCell, totalOf, usageSummary } from './usage';
import type { TokenCell, UsageSummary } from './usage';

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

/**
 * The drawer's summary line: total, then per-stage sums across rounds, then the round count, then
 * the job's token total (`64.0M tokens`, `≥ 64.0M tokens` when partial; none when nothing was
 * counted, never `0`). `title` is the tokens' tooltip, null when the line has no tokens part.
 */
export function summary(j: Job, now: number): { recorded: boolean; text: string; title: string | null } {
  const t = timed(j);
  if (t === null) return { recorded: false, text: NO_TIMING, title: null };
  const sums = new Map<string, number>();
  for (const s of workSpans(j)) sums.set(s.stage, (sums.get(s.stage) ?? 0) + spanMs(ofStage(s), now));
  const tokens = j.usage === null ? null : tokensPart(j.usage.job);
  const parts = [`total ${fmt(totalMs(j, t.startedAt, now))}`, ...[...sums].map(([stage, ms]) => `${stageLabel(stage)} ${fmt(ms)}`), rounds(j.round), tokens?.text ?? ''];
  return { recorded: true, text: parts.filter((p) => p !== '').join(' · '), title: tokens?.title ?? null };
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
  tokens: TokenCell; // the closed agent spans that started inside this span
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
  tokens: TokenCell;
}

export interface TimingView {
  line: string; // "Claimed <t> · merged <t> · total <d>", rendered as is
  claimed: string;
  merged: string | null;
  total: string;
  bar: BarSegment[];
  legend: Array<{ stage: string; label: string }>;
  stages: StageRow[];
  agents: AgentRow[];
  orchestrator: TokenCell | null; // the Agents table's last row; null: none (nothing recorded)
  usage: UsageSummary | null; // the usage summary under the tables; null: nothing counted
}

/** The epic orchestrator cell's tooltip: a member's orchestrator spend is counted once, on its epic. */
export const inEpicTitle = (slug: string): string => `Counted once for epic ${slug} (epic page)`;

/**
 * The orchestrator row: the job's `usage.orchestrator` total (blank until a stretch ends), or a
 * muted "in epic" for a job in an epic, whose orchestrator spend is the epic's. Null when the job
 * recorded nothing, so a job from before tracking has no orchestrator row.
 */
function orchestratorCell(j: Job): TokenCell | null {
  const u = j.usage;
  if (u === null || u.job.status === 'not recorded') return null;
  if (j.epic !== null) return { text: 'in epic', muted: true, title: inEpicTitle(j.epic) };
  return u.orchestrator === null ? { text: '—', muted: true, title: NOT_RECORDED_TITLE } : totalCell(u.orchestrator);
}

/** A stage span's Tokens: the total of the closed agent spans that started in [enteredAt, exitedAt); blank when there is none. */
function stageTokens(s: StageSpan, agents: readonly AgentSpan[]): TokenCell {
  const from = time(s.enteredAt);
  const to = s.exitedAt === null ? Infinity : time(s.exitedAt);
  const inside = agents.filter((a) => a.finishedAt !== null && time(a.startedAt) >= from && time(a.startedAt) < to);
  return inside.length === 0 ? BLANK : totalCell(totalOf(inside.map((a) => a.usage)));
}

/** The timing view's header line; the "merged" part appears only for a merged job. */
export const timingLine = (claimed: string, merged: string | null, total: string): string =>
  [`Claimed ${claimed}`, ...(merged !== null ? [`merged ${merged}`] : []), `total ${total}`].join(' · ');

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
    tokens: stageTokens(s, t.agents),
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
      tokens: spanCell(a),
    };
  });
  const claimed = when(time(t.startedAt));
  const merged = j.endedAt !== null ? when(time(j.endedAt)) : null;
  const total = fmt(totalMs(j, t.startedAt, now));
  return {
    line: timingLine(claimed, merged, total),
    claimed,
    merged,
    total,
    bar,
    legend,
    stages: stageRows,
    agents: agentRows,
    orchestrator: orchestratorCell(j),
    usage: j.usage === null ? null : usageSummary(j.usage.job),
  };
}
