// The Claude Code usage reader (docs/contract/v1.md "Usage"): the one place that knows Claude
// Code's transcript layout and format, behind the contract's harness-neutral `UsageReader`
// (decision 9). It reads only each line's `timestamp`, `message.id`, `message.model`, and
// `message.usage`, and returns only the model and the four counts.
//
// Layout: the transcript root is `$CLAUDE_CONFIG_DIR` (else `~/.claude`), then `projects/`. Under
// it, a project folder per working directory (its path with every character outside
// `[A-Za-z0-9]` turned into `-`) holds `<session>.jsonl` (the orchestrating session) and
// `<session>/subagents/agent-<id>.jsonl` (each agent it ran).
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { isAgentId, unavailable } from '@factory/contract';
import type { Usage, UsageReader, UsageWindow } from '@factory/contract';
import { isNotFound } from './paths';

/** Where the reader looks: the environment (for `CLAUDE_CONFIG_DIR` and `HOME`) and the repo root. */
export interface ClaudeUsageOptions {
  repo: string;
  env?: Readonly<Record<string, string | undefined>>;
}

/** `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export function transcriptRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const config = env.CLAUDE_CONFIG_DIR;
  const base = config !== undefined && config !== '' ? config : join(env.HOME !== undefined && env.HOME !== '' ? env.HOME : homedir(), '.claude');
  return join(base, 'projects');
}

/** The project folder name Claude Code uses for a working directory. */
export const projectFolder = (dir: string): string => resolve(dir).replace(/[^A-Za-z0-9]/g, '-');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

interface Message {
  model: string | null;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * Sums assistant messages over one or more transcripts. Each `message.id` counts once: Claude
 * Code writes a line per content block and repeats the message's usage on each, so the largest
 * value seen per count is kept rather than summed.
 */
export class Tally {
  private readonly messages = new Map<string, Message>();
  private lines = 0;
  private recognized = 0;

  constructor(private readonly window: UsageWindow) {}

  /** Adds one transcript's text. A line that isn't JSON, or has no `timestamp`, is skipped. */
  add(text: string): void {
    const from = Date.parse(this.window.from);
    const to = Date.parse(this.window.to);
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      this.lines += 1;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(raw) || typeof raw.timestamp !== 'string') continue;
      const at = Date.parse(raw.timestamp);
      if (Number.isNaN(at)) continue;
      this.recognized += 1;
      if (at < from || at > to) continue;
      const message = raw.message;
      if (!isRecord(message) || typeof message.id !== 'string' || !isRecord(message.usage)) continue;
      const u = message.usage;
      const seen = this.messages.get(message.id);
      const model = typeof message.model === 'string' && message.model !== '' ? message.model : null;
      const next: Message = {
        model: seen?.model ?? model,
        input: Math.max(seen?.input ?? 0, count(u.input_tokens)),
        output: Math.max(seen?.output ?? 0, count(u.output_tokens)),
        cacheWrite: Math.max(seen?.cacheWrite ?? 0, count(u.cache_creation_input_tokens)),
        cacheRead: Math.max(seen?.cacheRead ?? 0, count(u.cache_read_input_tokens)),
      };
      this.messages.set(message.id, next);
    }
  }

  /** How many distinct messages fell inside the window. */
  get size(): number {
    return this.messages.size;
  }

  /** True when the transcripts had lines but none in a format this reader knows. */
  get unrecognized(): boolean {
    return this.lines > 0 && this.recognized === 0;
  }

  /** The counts, and the model with the most output tokens (ties: the first seen). */
  usage(): Usage {
    const total = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    const byModel = new Map<string, number>();
    for (const m of this.messages.values()) {
      total.input += m.input;
      total.output += m.output;
      total.cacheWrite += m.cacheWrite;
      total.cacheRead += m.cacheRead;
      if (m.model !== null && m.model !== '<synthetic>') byModel.set(m.model, (byModel.get(m.model) ?? 0) + m.output);
    }
    let model: string | null = null;
    let most = -1;
    for (const [name, out] of byModel) {
      if (out > most) {
        model = name;
        most = out;
      }
    }
    return { model, ...total };
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

async function dirsIn(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
}

/**
 * The agent's transcript, `<project>/<session>/subagents/agent-<id>.jsonl`: first under the
 * repo root's project folder, then under any project folder. Null when none is found. The id
 * is checked before any path is built from it.
 */
export async function findAgentTranscript(root: string, repo: string, agentId: string): Promise<string | null> {
  if (!isAgentId(agentId)) return null;
  const preferred = projectFolder(repo);
  const all = await dirsIn(root);
  const order = [...all.filter((p) => p === preferred), ...all.filter((p) => p !== preferred)];
  for (const project of order) {
    for (const session of await dirsIn(join(root, project))) {
      const path = join(root, project, session, 'subagents', `agent-${agentId}.jsonl`);
      if (await isFile(path)) return path;
    }
  }
  return null;
}

/** The orchestrating session's transcript for an agent transcript: `<project>/<session>.jsonl`. */
export const sessionTranscript = (agentTranscript: string): string => {
  const sessionDir = dirname(dirname(agentTranscript));
  return join(dirname(sessionDir), `${basename(sessionDir)}.jsonl`);
};

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** The Claude Code `UsageReader` for the repo at `opts.repo`. */
export function claudeUsageReader(opts: ClaudeUsageOptions): UsageReader {
  const root = transcriptRoot(opts.env);
  return {
    async agent(agentId, window) {
      if (!isAgentId(agentId)) return unavailable('agentId is not a safe id (want ^[A-Za-z0-9_-]+$)');
      const path = await findAgentTranscript(root, opts.repo, agentId);
      if (path === null) return unavailable(`no Claude Code transcript for agent ${agentId}`);
      const text = await readText(path);
      if (text === null) return unavailable(`no Claude Code transcript for agent ${agentId}`);
      const tally = new Tally(window);
      tally.add(text);
      if (tally.unrecognized) return unavailable('Claude Code transcript format not recognized');
      if (tally.size === 0) return unavailable('no assistant messages inside the span');
      return tally.usage();
    },
    async orchestrator(agentIds, window) {
      const ids = agentIds.filter(isAgentId);
      if (ids.length === 0) return unavailable('no agent ids recorded to find the orchestrating session');
      const sessions: string[] = [];
      for (const id of ids) {
        const path = await findAgentTranscript(root, opts.repo, id);
        if (path === null) continue;
        const session = sessionTranscript(path);
        if (!sessions.includes(session)) sessions.push(session);
      }
      if (sessions.length === 0) return unavailable('no Claude Code session found from the agent ids');
      const tally = new Tally(window);
      for (const session of sessions) {
        const text = await readText(session);
        if (text === null) return unavailable('an orchestrating session transcript is missing');
        tally.add(text);
      }
      if (tally.unrecognized) return unavailable('Claude Code transcript format not recognized');
      return tally.usage();
    },
  };
}
