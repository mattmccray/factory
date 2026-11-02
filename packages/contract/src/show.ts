// Human-readable timing and usage summary for `factory/cli.ts show`. Pure: `now` drives open spans.
import type { AgentSpan, JobSnapshot } from './project';
import { tokensOf } from './usage';
import type { UsageTotal } from './usage';

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function span(ms: number | null, openSince: string, now: Date): string {
  return ms !== null ? duration(ms) : `running ${duration(now.getTime() - Date.parse(openSince))}`;
}

export function formatShow(snap: JobSnapshot, now: Date): string[] {
  const out = [`${snap.id}  ${snap.stage}${snap.title ? `  ${snap.title}` : ''}`];
  for (const s of snap.timing.stages) {
    const head = `stage  ${s.stage}${s.round ? ` r${s.round}` : ''}`;
    // merged and abandoned are terminal: their span never closes, and it isn't running either.
    out.push(s.stage === 'merged' || s.stage === 'abandoned' ? head : `${head}  ${span(s.ms, s.enteredAt, now)}`);
  }
  for (const a of snap.timing.agents) {
    const who = [a.role, a.key, a.round !== null ? `r${a.round}` : null, a.name].filter((x) => x !== null).join(' ');
    out.push(`agent  ${who}  ${span(a.ms, a.startedAt, now)}${a.verdict ? `  ${a.verdict}` : ''}`);
  }
  return [...out, ...formatUsage(snap)];
}

/** A token count in short form: `950`, `12.3k`, `1.2M`. */
export function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 999_950) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * A total in one phrase: `= 1.2M` when exact, `≥ 1.2M, 1 span unknown` when partial (a lower
 * bound), else `unavailable (2 spans)` or `not recorded`. `unit` names what was counted.
 */
export function usageSummary(t: UsageTotal, unit: [string, string] = ['span', 'spans']): string {
  const sum = compactTokens(tokensOf(t));
  switch (t.status) {
    case 'exact':
      return `= ${sum}`;
    case 'partial':
      return `≥ ${sum}, ${plural(t.unknown, `${unit[0]} unknown`, `${unit[1]} unknown`)}`;
    case 'unavailable':
      return `unavailable (${plural(t.unknown, unit[0], unit[1])})`;
    case 'not recorded':
      return 'not recorded';
  }
}

const NONE = '-';

function spanRow(a: AgentSpan): string[] {
  const id = [a.role, a.key ?? NONE, a.round === null ? NONE : String(a.round)];
  const u = a.usage;
  if (u === null) return [...id, a.finishedAt === null ? 'running' : 'not recorded', NONE, NONE, NONE, NONE];
  if ('unavailable' in u) return [...id, `unavailable: ${u.unavailable}`, NONE, NONE, NONE, NONE];
  return [...id, u.model ?? NONE, String(u.input), String(u.output), String(u.cacheWrite), String(u.cacheRead)];
}

function totalRow(label: string, t: UsageTotal, summary: string): string[] {
  const counted = t.status === 'exact' || t.status === 'partial';
  const n = (v: number): string => (!counted ? NONE : t.status === 'partial' ? `≥ ${v}` : String(v));
  return [label, '', '', summary, n(t.input), n(t.output), n(t.cacheWrite), n(t.cacheRead)];
}

/**
 * The usage table: a row per agent span (role, key, round, model, and the four counts), then the
 * totals per stage, per round, and for the job, and the orchestrator line. Empty when the job has
 * no agent span and no orchestrator stretch yet.
 */
export function formatUsage(snap: JobSnapshot): string[] {
  const u = snap.usage;
  const orchestrator = u.orchestrator;
  if (snap.timing.agents.length === 0 && (orchestrator === null || orchestrator.spans === 0)) return [];
  const rows: string[][] = [['role', 'key', 'round', 'model', 'input', 'output', 'cache write', 'cache read']];
  for (const a of snap.timing.agents) rows.push(spanRow(a));
  for (const s of u.stages) rows.push(totalRow(`stage ${s.stage}`, s.total, usageSummary(s.total)));
  for (const r of u.rounds) rows.push(totalRow(`round ${r.round}`, r.total, usageSummary(r.total)));
  if (orchestrator === null) rows.push(['orchestrator', '', '', `in epic ${snap.epic ?? ''} (epic show)`, '', '', '', '']);
  else if (orchestrator.spans === 0) rows.push(['orchestrator', '', '', 'no stretch ended yet', '', '', '', '']);
  else rows.push(totalRow('orchestrator', orchestrator, usageSummary(orchestrator, ['stretch', 'stretches'])));
  rows.push(totalRow('job', u.job, usageSummary(u.job)));
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length))) ?? [];
  return ['usage', ...rows.map((r) => `  ${r.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ')}`.trimEnd())];
}
