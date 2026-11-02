// Token spend for the inspector (docs/contract/v1.md "Usage"; design §8, epics design): the compact
// sum, the cell a span or total shows, and the totals the views combine. Pure. The UI may only
// `import type` from `@factory/contract`, so `compactTokens`, `tokensOf`, and `totalOf` are
// reimplemented here; the tests pin them to the contract's own. A total is never shown as more
// exact than it is: `—` not recorded, `?` unavailable, `≥` partial, blank while nothing has closed.
import type { AgentSpan, Usage, UsageTotal } from './job';

/** The sum of the four counts. */
export const tokensOf = (t: { input: number; output: number; cacheWrite: number; cacheRead: number }): number => t.input + t.output + t.cacheWrite + t.cacheRead;

/** A token count in short form, as `factory show` prints it: `950`, `12.3k`, `1.2M`, `64.0M`. */
export function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 999_950) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Sums span usages as the contract's `totalOf` does; `null` is a span whose usage was never recorded. */
export function totalOf(usages: readonly (Usage | null)[]): UsageTotal {
  const t: UsageTotal = { status: 'exact', input: 0, output: 0, cacheWrite: 0, cacheRead: 0, spans: usages.length, unknown: 0 };
  let unavailableSpans = 0;
  for (const u of usages) {
    if (u === null) t.unknown += 1;
    else if ('unavailable' in u) {
      t.unknown += 1;
      unavailableSpans += 1;
    } else {
      t.input += u.input;
      t.output += u.output;
      t.cacheWrite += u.cacheWrite;
      t.cacheRead += u.cacheRead;
    }
  }
  t.status = statusOf(t.spans - t.unknown, t.unknown, unavailableSpans > 0);
  return t;
}

// exact when nothing is unknown, partial when some has counts, else unavailable or not recorded
const statusOf = (counted: number, unknown: number, someUnavailable: boolean): UsageTotal['status'] =>
  unknown === 0 ? 'exact' : counted > 0 ? 'partial' : someUnavailable ? 'unavailable' : 'not recorded';

/** One span whose spend was never recorded (a job before tracking, or one Andon doesn't hold). */
export const NOT_RECORDED: UsageTotal = { status: 'not recorded', input: 0, output: 0, cacheWrite: 0, cacheRead: 0, spans: 1, unknown: 1 };

/**
 * Combines totals into one: the counts, `spans`, and `unknown` summed, and the status taken from
 * the combined total the way `totalOf` takes it (unavailable when no part has counts and some part
 * was unavailable).
 */
export function combine(totals: readonly UsageTotal[]): UsageTotal {
  const t: UsageTotal = { status: 'exact', input: 0, output: 0, cacheWrite: 0, cacheRead: 0, spans: 0, unknown: 0 };
  for (const p of totals) {
    t.input += p.input;
    t.output += p.output;
    t.cacheWrite += p.cacheWrite;
    t.cacheRead += p.cacheRead;
    t.spans += p.spans;
    t.unknown += p.unknown;
  }
  t.status = statusOf(t.spans - t.unknown, t.unknown, totals.some((p) => p.status === 'unavailable'));
  return t;
}

/** Whether a total has any span with counts: `exact` with a span, or `partial`. Nothing counted never reads `0`. */
export const counted = (t: UsageTotal): boolean => (t.status === 'exact' && t.spans > 0) || t.status === 'partial';

/** A Tokens cell: its text, whether it reads faint (`—`, `?`, "in epic"), and its tooltip. */
export interface TokenCell {
  text: string;
  muted: boolean;
  title: string | null;
}

export const BLANK: TokenCell = { text: '', muted: false, title: null };
export const NOT_RECORDED_TITLE = 'Not recorded (before token tracking)';

const full = (n: number): string => n.toLocaleString('en-US');
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/** "<n> span(s) unavailable", for a total's `unknown`. */
export const unavailableText = (n: number): string => `${plural(n, 'span', 'spans')} unavailable`;

/** The four counts, one per line, in full: input, output, cache write, cache read. */
export const countLines = (t: { input: number; output: number; cacheWrite: number; cacheRead: number }): string[] => [
  `input ${full(t.input)}`,
  `output ${full(t.output)}`,
  `cache write ${full(t.cacheWrite)}`,
  `cache read ${full(t.cacheRead)}`,
];

/**
 * An agent span's cell: blank while it runs; its compact sum with the counts and the model as the
 * tooltip; a muted `?` with the CLI's reason when unavailable; a muted `—` when not recorded.
 */
export function spanCell(a: AgentSpan): TokenCell {
  if (a.finishedAt === null) return BLANK;
  const u = a.usage;
  if (u === null) return { text: '—', muted: true, title: NOT_RECORDED_TITLE };
  if ('unavailable' in u) return { text: '?', muted: true, title: u.unavailable };
  return { text: compactTokens(tokensOf(u)), muted: false, title: [...countLines(u), u.model ?? 'model not recorded'].join('\n') };
}

/**
 * A total's cell: blank when it holds no span; a muted `—` when not recorded; a muted `?` when
 * unavailable; `≥ <sum>` when partial (the counts are a lower bound); else the compact sum. The
 * tooltip lists the four counts, and a partial total adds how many spans are unavailable.
 */
export function totalCell(t: UsageTotal): TokenCell {
  if (t.spans === 0) return BLANK;
  switch (t.status) {
    case 'not recorded':
      return { text: '—', muted: true, title: NOT_RECORDED_TITLE };
    case 'unavailable':
      return { text: '?', muted: true, title: unavailableText(t.unknown) };
    case 'partial':
      return { text: `≥ ${compactTokens(tokensOf(t))}`, muted: false, title: [...countLines(t), unavailableText(t.unknown)].join('\n') };
    case 'exact':
      return { text: compactTokens(tokensOf(t)), muted: false, title: countLines(t).join('\n') };
  }
}

/** A header's tokens part, "64.0M tokens" (or "≥ 64.0M tokens"), with its tooltip; null when nothing was counted. */
export function tokensPart(t: UsageTotal): { text: string; title: string } | null {
  if (!counted(t)) return null;
  const cell = totalCell(t);
  return { text: `${cell.text} tokens`, title: cell.title ?? '' };
}

/** The usage summary's rows: the four kinds, each prefixed `≥` when the total is partial. */
export interface UsageSummary {
  rows: Array<{ label: string; value: string }>;
  note: string | null; // "<n> span(s) unavailable" when partial
}

/** The usage summary under the timing tables, by kind; null when nothing was counted. */
export function usageSummary(t: UsageTotal): UsageSummary | null {
  if (!counted(t)) return null;
  const v = (n: number): string => (t.status === 'partial' ? `≥ ${full(n)}` : full(n));
  return {
    rows: [
      { label: 'Input', value: v(t.input) },
      { label: 'Output', value: v(t.output) },
      { label: 'Cache write', value: v(t.cacheWrite) },
      { label: 'Cache read', value: v(t.cacheRead) },
    ],
    note: t.status === 'partial' ? unavailableText(t.unknown) : null,
  };
}
