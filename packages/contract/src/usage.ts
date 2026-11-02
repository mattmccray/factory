// Token spend in factory/v1 (docs/contract/v1.md "Usage"): the harness-neutral usage shape the
// CLI records on events, the reader interface a harness adapter implements, the stretches an
// orchestrator's spend is read over, and the rollups `job.json` and `epic.json` carry. Pure: the
// contract never knows a harness's transcript format (decision 9); a reader is injected.

/** One span's spend: the model with the most output tokens and the four raw token counts. */
export interface UsageCounts {
  model: string | null; // null: no message in the window named a model
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Why a span's spend couldn't be read: a one-line reason. */
export interface UsageUnavailable {
  unavailable: string;
}

/** What the CLI records for one span or stretch: the counts, or why they couldn't be read. */
export type Usage = UsageCounts | UsageUnavailable;

/** A time window, both ends ISO-8601 and inclusive. */
export interface UsageWindow {
  from: string;
  to: string;
}

/**
 * What a harness adapter gives the store. Both calls resolve to a `Usage` (unavailable with a
 * one-line reason when they can't read it); a throw is caught by the store and recorded as
 * unavailable, never failing the event.
 */
export interface UsageReader {
  /** The spend of the agent `agentId` inside `window`. */
  agent(agentId: string, window: UsageWindow): Promise<Usage>;
  /** The spend of the orchestrating session(s), found from `agentIds`, inside `window`. */
  orchestrator(agentIds: readonly string[], window: UsageWindow): Promise<Usage>;
}

/** The agent ids the CLI uses in a path: letters, digits, `_`, and `-` only. */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** True when `id` is an agent id the CLI may build a path from (`AGENT_ID_PATTERN`). */
export const isAgentId = (id: string): boolean => AGENT_ID_PATTERN.test(id);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const COUNT_KEYS = ['model', 'input', 'output', 'cacheWrite', 'cacheRead'];

/**
 * Narrows a stored usage value. Readers are tolerant: anything that isn't exactly the counts
 * shape or `{ unavailable: "<reason>" }` is not a usage (and reads as not recorded).
 */
export function readUsage(v: unknown): Usage | null {
  if (!isRecord(v)) return null;
  const keys = Object.keys(v);
  if (keys.length === 1 && typeof v.unavailable === 'string' && v.unavailable !== '') return { unavailable: v.unavailable };
  if (keys.length !== COUNT_KEYS.length || !COUNT_KEYS.every((k) => keys.includes(k))) return null;
  const { model, input, output, cacheWrite, cacheRead } = v;
  if (model !== null && typeof model !== 'string') return null;
  if (!isCount(input) || !isCount(output) || !isCount(cacheWrite) || !isCount(cacheRead)) return null;
  return { model, input, output, cacheWrite, cacheRead };
}

/** A one-line reason: the first line of `text`, trimmed, never empty. */
export function unavailable(text: string): UsageUnavailable {
  const line = (text.split('\n')[0] ?? '').trim();
  return { unavailable: line === '' ? 'unknown reason' : line };
}

// ---- stretches ----

/** The job events that start an orchestrator stretch, and those that end one. */
export const JOB_STRETCH_STARTS: readonly string[] = ['job.claimed', 'job.reworked', 'job.human-approved'];
export const JOB_STRETCH_ENDS: readonly string[] = ['job.escalated', 'merge.failed', 'job.merged', 'job.abandoned'];
/** The epic events that start an orchestrator stretch, and those that end one. */
export const EPIC_STRETCH_STARTS: readonly string[] = ['epic.started', 'epic.resumed'];
export const EPIC_STRETCH_ENDS: readonly string[] = ['epic.waiting', 'epic.landed', 'epic.abandoned'];

/**
 * When the stretch open at the end of `events` began: the first start event after the last end
 * event, or null when no stretch is open.
 */
export function openStretch(events: readonly { type: string; ts: string }[], starts: readonly string[], ends: readonly string[]): string | null {
  let from: string | null = null;
  for (const e of events) {
    if (ends.includes(e.type)) from = null;
    else if (from === null && starts.includes(e.type)) from = e.ts;
  }
  return from;
}

// ---- rollups ----

/**
 * A rollup over spans (or stretches). `status`: `exact` when every span has counts (or there are
 * none), `partial` when some do and `unknown` don't (the counts are a lower bound),
 * `unavailable` when none has counts and some was unavailable, `not recorded` when none was
 * recorded at all (logs written before usage was).
 */
export interface UsageTotal {
  status: 'exact' | 'partial' | 'unavailable' | 'not recorded';
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  spans: number;
  unknown: number;
}

/** Sums the given span usages; `null` is a span whose usage was never recorded. */
export function totalOf(usages: readonly (Usage | null)[]): UsageTotal {
  const t: UsageTotal = { status: 'exact', input: 0, output: 0, cacheWrite: 0, cacheRead: 0, spans: usages.length, unknown: 0 };
  let counted = 0;
  let unavailableSpans = 0;
  for (const u of usages) {
    if (u === null) t.unknown += 1;
    else if ('unavailable' in u) {
      t.unknown += 1;
      unavailableSpans += 1;
    } else {
      counted += 1;
      t.input += u.input;
      t.output += u.output;
      t.cacheWrite += u.cacheWrite;
      t.cacheRead += u.cacheRead;
    }
  }
  if (t.unknown === 0) t.status = 'exact';
  else if (counted > 0) t.status = 'partial';
  else t.status = unavailableSpans > 0 ? 'unavailable' : 'not recorded';
  return t;
}

/** The sum of a total's four counts. */
export const tokensOf = (t: { input: number; output: number; cacheWrite: number; cacheRead: number }): number => t.input + t.output + t.cacheWrite + t.cacheRead;

/**
 * The orchestrator stretches of a log: one usage per end event that closes an open stretch (or
 * carries an `orchestrator` field), `null` when that event recorded none.
 */
export function stretchUsages(events: readonly { type: string; ts: string; orchestrator?: unknown }[], starts: readonly string[], ends: readonly string[]): (Usage | null)[] {
  const out: (Usage | null)[] = [];
  let open = false;
  for (const e of events) {
    if (ends.includes(e.type)) {
      if (open || e.orchestrator !== undefined) out.push(readUsage(e.orchestrator));
      open = false;
    } else if (starts.includes(e.type)) open = true;
  }
  return out;
}
