// Duration formatting and the card timers, ported from the vendored dashboard. Pure: every
// function takes `now`, and the UI re-runs them once a second.
import type { AgentSpan, Job } from './job';

/** Milliseconds since the epoch for an ISO time; a missing or bad time is 0. */
export const time = (iso: string | null | undefined): number => {
  const t = new Date(iso ?? 0).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/** Long form: 42s, 3m 7s, 2h 05m, 1d 4h. */
export function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** Compact form for the reviewer chips: 12s, 8m, 1h05m, 2d3h. */
export function fmtShort(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
}

/** "42s ago", "3m ago", "2h ago", or a date once it's a day old. */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - time(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** A short local date and time, e.g. "Oct 22, 3:04 PM". */
export const when = (t: number): string => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * A machine's "since" or "as of" time (brief andon-machines-ui): local 24-hour "14:02", prefixed
 * with a short date ("Oct 29 14:02") when it isn't today (by `now`'s local date).
 */
export function clockTime(t: number, now: number): string {
  const d = new Date(t);
  const today = new Date(now);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const same = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return same ? hm : `${MONTHS[d.getMonth()] ?? ''} ${d.getDate()} ${hm}`;
}

export interface Clock {
  /** The left-hand timer: "<stage> · <time in stage>", "waiting <wait>", or a merged job's "total <t>". */
  main: string;
  /** Total time since the claim, for a job still on the line. */
  total: string | null;
}

/** A card's timers. A legacy job (no `startedAt` or `stageEnteredAt`) gets none. */
export function clock(j: Job, now: number): Clock | null {
  if (j.startedAt === null || j.stageEnteredAt === null) return null;
  if (j.stage === 'merged') return j.endedAt !== null ? { main: `total ${fmt(time(j.endedAt) - time(j.startedAt))}`, total: null } : null;
  if (j.stage === 'needs-human') return { main: `waiting ${fmt(now - time(j.stageEnteredAt))}`, total: null };
  return { main: `${j.stage} · ${fmt(now - time(j.stageEnteredAt))}`, total: `total ${fmt(now - time(j.startedAt))}` };
}

/** The latest reviewer span for `key` in `round`, if the job's timing has one. */
export function reviewerSpan(j: Job, key: string, round: number): AgentSpan | null {
  const spans = (j.timing?.agents ?? []).filter((a) => a.role === 'reviewer' && a.key === key && a.round === round);
  return spans[spans.length - 1] ?? null;
}

export interface ChipTime {
  /** The tooltip: "<key> <verdict> · <time>" (or "<key>: <verdict>" with no span). */
  title: string;
  /** The tiny duration under the chip; empty with no span. */
  short: string;
  running: boolean;
}

/** A reviewer chip's time: ticking for an open span, final for a closed one, none without a span. */
export function chipTime(key: string, verdict: string, span: AgentSpan | null, now: number): ChipTime {
  if (span === null) return { title: `${key}: ${verdict}`, short: '', running: false };
  if (span.finishedAt !== null) {
    const label = verdict === 'pending' ? 'stopped' : verdict;
    const ms = span.ms ?? time(span.finishedAt) - time(span.startedAt);
    return { title: `${key} ${label} · ${fmt(ms)}`, short: fmtShort(ms), running: false };
  }
  const ms = now - time(span.startedAt);
  return { title: `${key} ${verdict} · ${fmt(ms)}`, short: fmtShort(ms), running: true };
}

const ABBR: Record<string, string> = { security: 'SEC' };
/** A reviewer key's chip label: SEC for security, else the first four letters upper-cased. */
export const abbr = (k: string): string => ABBR[k] ?? k.toUpperCase().slice(0, 4);

const CHIP: Record<string, string> = { security: 'se', contract: 'ct', code: 'cd', ui: 'ui', ux: 'ux' };
/** A reviewer key's two-letter token chip label (design §6): se, ct, cd, ui, ux, else its first two letters. */
export const chipLabel = (k: string): string => CHIP[k] ?? k.slice(0, 2).toLowerCase();
